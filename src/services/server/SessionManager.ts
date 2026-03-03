/**
 * SessionManager: Event-driven session lifecycle
 *
 * Manages active sessions in memory:
 * - ActiveSession map (sessionDbId -> session state)
 * - Enqueue observations/summaries to persistent PendingMessageStore
 * - Start/stop observer agents (SDKAgent)
 * - Event-driven message iteration for agents
 * - Session cleanup on complete
 *
 * Ported from claude-mem's SessionManager — adapted for Postgres backend.
 * Removed SQLite PendingMessageStore class (using Postgres functions directly).
 */

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { getDb } from '../postgres/client.js';
import {
  getSdkSessionById,
  getPromptCount,
  enqueue,
  claimNextMessage,
  confirmProcessed,
  getPendingCount,
  hasAnyPendingWork,
  updateMemorySessionId,
} from '../postgres/index.js';
import { storeObservations } from '../postgres/transactions.js';
import type {
  ActiveSession,
  PendingMessage,
  PendingMessageWithId,
  ObservationData,
} from '../worker-types.js';
import type { PendingMessageRow, ObservationInput, SessionSummaryInput } from '../postgres/types.js';
import type { SDKSessionManager } from '../worker/SDKAgent.js';
import type { DatabaseManagerRef, SessionStoreRef } from '../worker/agents/ResponseProcessor.js';
import type { PendingMessageStoreRef } from '../worker/agents/ResponseProcessor.js';
import type { StorageResult } from '../worker/agents/types.js';
import type { NormalizedSummary } from '../worker/agents/ResponseProcessor.js';
import type { ParsedObservation } from '../../sdk/parser.js';
import type { ModeConfig } from '../domain/types.js';
import type { EmbedFn } from '../../embeddings/index.js';
import { SDKAgent } from '../worker/SDKAgent.js';
import { getProcessBySession, ensureProcessExit } from '../worker/ProcessRegistry.js';
import type { SSEBroadcaster } from '../worker/SSEBroadcaster.js';

// Idle timeout for sessions — 15 minutes without activity
const MAX_SESSION_IDLE_MS = 15 * 60 * 1000;

// Poll interval for claiming messages from the persistent queue
const CLAIM_POLL_INTERVAL_MS = 500;

// Idle timeout before generator exits
const GENERATOR_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * SessionManager manages active sessions and coordinates between
 * HTTP routes and the SDKAgent observer.
 */
export class SessionManager implements SDKSessionManager {
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();
  private embedFn?: EmbedFn;
  private modeConfig?: ModeConfig;
  private sseBroadcaster?: SSEBroadcaster;

  constructor(embedFn?: EmbedFn, modeConfig?: ModeConfig, sseBroadcaster?: SSEBroadcaster) {
    this.embedFn = embedFn;
    this.modeConfig = modeConfig;
    this.sseBroadcaster = sseBroadcaster;
  }

  /**
   * Broadcast an SSE event to connected viewers
   */
  broadcastEvent(event: { type: string; [key: string]: any }): void {
    if (this.sseBroadcaster) {
      this.sseBroadcaster.broadcast(event);
    }
  }

  /**
   * Set the mode configuration (can be loaded after construction)
   */
  setModeConfig(mode: ModeConfig): void {
    this.modeConfig = mode;
  }

  // ============================================================================
  // Session Lifecycle
  // ============================================================================

  /**
   * Initialize a session in memory from the database record.
   * Does NOT start the SDK agent — call startSession() for that.
   */
  private async initializeSession(
    sessionDbId: number,
    userPrompt?: string,
    promptNumber?: number,
  ): Promise<ActiveSession> {
    // Check if already active
    let session = this.sessions.get(sessionDbId);
    if (session) {
      // Update prompt for continuation
      if (userPrompt) {
        session.userPrompt = userPrompt;
        session.lastPromptNumber = promptNumber || session.lastPromptNumber;
      }
      return session;
    }

    const db = getDb();
    const dbSession = await getSdkSessionById(db, sessionDbId);
    if (!dbSession) {
      throw new Error(`Session ${sessionDbId} not found in database`);
    }

    // Determine prompt number from DB if not provided
    const effectivePromptNumber =
      promptNumber || (await getPromptCount(db, dbSession.content_session_id)) || 1;

    // Create active session
    // CRITICAL: Do NOT load memorySessionId from database (Issue #817)
    // When creating a new in-memory session, any DB memory_session_id is STALE
    // because the SDK context was lost when the worker restarted.
    session = {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      memorySessionId: null, // Always start fresh — SDK will capture new ID
      project: dbSession.project,
      userPrompt: userPrompt || dbSession.user_prompt || '',
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: effectivePromptNumber,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      conversationHistory: [],
      currentProvider: null,
      consecutiveRestarts: 0,
      processingMessageIds: [],
      lastGeneratorActivity: Date.now(),
    };

    this.sessions.set(sessionDbId, session);

    // Create event emitter for queue notifications
    const emitter = new EventEmitter();
    this.sessionQueues.set(sessionDbId, emitter);

    logger.info('SESSION', 'Session initialized', {
      sessionId: sessionDbId,
      project: session.project,
      contentSessionId: session.contentSessionId,
      lastPromptNumber: effectivePromptNumber,
    });

    return session;
  }

  /**
   * Start the SDK agent for a session.
   * Initializes the session in memory if needed, then launches the agent.
   */
  async startSession(
    sessionDbId: number,
    userPrompt?: string,
    promptNumber?: number,
  ): Promise<void> {
    const session = await this.initializeSession(sessionDbId, userPrompt, promptNumber);

    // Don't start a new agent if one is already running
    if (session.generatorPromise) {
      logger.debug('SESSION', 'Agent already running, skipping start', { sessionDbId });
      return;
    }

    if (!this.modeConfig) {
      logger.error('SESSION', 'Cannot start agent: no mode config loaded', { sessionDbId });
      throw new Error('Mode config not loaded — cannot start SDK agent');
    }

    // Build database manager adapter for ResponseProcessor
    const dbManager = this.createDatabaseManager();

    // Create SDK agent
    const sdkAgent = new SDKAgent(dbManager, this);

    // Start agent in background
    session.generatorPromise = sdkAgent
      .startSession(session, this.modeConfig)
      .catch((error) => {
        logger.error('SDK', 'Agent session failed', { sessionDbId }, error as Error);
      })
      .finally(() => {
        session.generatorPromise = null;
      });
  }

  /**
   * Get active session by ID
   */
  getSession(sessionDbId: number): ActiveSession | undefined {
    return this.sessions.get(sessionDbId);
  }

  // ============================================================================
  // Queue Operations
  // ============================================================================

  /**
   * Enqueue an observation for processing.
   * Persists to DB first, then notifies the agent via EventEmitter.
   */
  queueObservation(sessionDbId: number, data: ObservationData): void {
    // Auto-initialize from database if needed
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      // Fire-and-forget initialization — enqueue will still work via DB
      this.initializeSession(sessionDbId).catch((err) => {
        logger.error('SESSION', 'Auto-init failed for observation', { sessionDbId }, err);
      });
    }

    const effectiveSession = session || { contentSessionId: '' };

    const message: PendingMessage = {
      type: 'observation',
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      prompt_number: data.prompt_number,
      cwd: data.cwd,
    };

    // Persist to DB first
    const db = getDb();
    const contentSessionId = session?.contentSessionId;

    if (!contentSessionId) {
      // Look up from DB synchronously is not possible with async — log and skip
      logger.warn('SESSION', 'Cannot enqueue observation: session not in memory', { sessionDbId });
      return;
    }

    enqueue(db, sessionDbId, contentSessionId, {
      session_db_id: sessionDbId,
      content_session_id: contentSessionId,
      message_type: 'observation',
      tool_name: data.tool_name,
      tool_input: typeof data.tool_input === 'string' ? data.tool_input : JSON.stringify(data.tool_input),
      tool_response: typeof data.tool_response === 'string' ? data.tool_response : JSON.stringify(data.tool_response),
      prompt_number: data.prompt_number,
      cwd: data.cwd,
    }).then((messageId) => {
      const toolSummary = logger.formatTool(data.tool_name, data.tool_input);
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=observation | tool=${toolSummary}`, {
        sessionId: sessionDbId,
      });

      // Notify agent immediately
      const emitter = this.sessionQueues.get(sessionDbId);
      emitter?.emit('message');
    }).catch((error) => {
      logger.error('SESSION', 'Failed to persist observation to DB', {
        sessionId: sessionDbId,
        tool: data.tool_name,
      }, error);
    });
  }

  /**
   * Enqueue a summary request.
   * Persists to DB first, then notifies the agent.
   */
  queueSummarize(sessionDbId: number, lastAssistantMessage?: string): void {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      this.initializeSession(sessionDbId).catch((err) => {
        logger.error('SESSION', 'Auto-init failed for summarize', { sessionDbId }, err);
      });
    }

    const contentSessionId = session?.contentSessionId;
    if (!contentSessionId) {
      logger.warn('SESSION', 'Cannot enqueue summarize: session not in memory', { sessionDbId });
      return;
    }

    const db = getDb();

    enqueue(db, sessionDbId, contentSessionId, {
      session_db_id: sessionDbId,
      content_session_id: contentSessionId,
      message_type: 'summarize',
      last_assistant_message: lastAssistantMessage,
    }).then((messageId) => {
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=summarize`, {
        sessionId: sessionDbId,
      });

      const emitter = this.sessionQueues.get(sessionDbId);
      emitter?.emit('message');
    }).catch((error) => {
      logger.error('SESSION', 'Failed to persist summarize to DB', { sessionId: sessionDbId }, error);
    });
  }

  // ============================================================================
  // SDKSessionManager Interface (for SDKAgent)
  // ============================================================================

  /**
   * Get message iterator for SDKAgent consumption (event-driven).
   * Claims messages from the persistent PendingMessageStore.
   */
  async *getMessageIterator(
    sessionDbId: number,
  ): AsyncIterable<{
    _persistentId: number;
    type: 'observation' | 'summarize';
    tool_name?: string;
    tool_input?: any;
    tool_response?: any;
    prompt_number?: number;
    cwd?: string;
    last_assistant_message?: string;
  }> {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      throw new Error(`No active session for ${sessionDbId}`);
    }

    const emitter = this.sessionQueues.get(sessionDbId);
    if (!emitter) {
      throw new Error(`No emitter for session ${sessionDbId}`);
    }

    const db = getDb();
    let lastActivity = Date.now();

    while (!session.abortController.signal.aborted) {
      // Try to claim next pending message
      const claimed = await claimNextMessage(db, sessionDbId);

      if (claimed) {
        lastActivity = Date.now();
        session.lastGeneratorActivity = lastActivity;

        // Track earliest timestamp for accurate observation timestamps
        if (session.earliestPendingTimestamp === null) {
          session.earliestPendingTimestamp = claimed.created_at_epoch;
        } else {
          session.earliestPendingTimestamp = Math.min(
            session.earliestPendingTimestamp,
            claimed.created_at_epoch,
          );
        }

        // Parse tool_input and tool_response from JSON strings
        let toolInput = claimed.tool_input;
        let toolResponse = claimed.tool_response;
        try {
          if (typeof toolInput === 'string') toolInput = JSON.parse(toolInput);
        } catch { /* keep as string */ }
        try {
          if (typeof toolResponse === 'string') toolResponse = JSON.parse(toolResponse);
        } catch { /* keep as string */ }

        yield {
          _persistentId: claimed.id,
          type: claimed.message_type,
          tool_name: claimed.tool_name || undefined,
          tool_input: toolInput,
          tool_response: toolResponse,
          prompt_number: claimed.prompt_number || undefined,
          cwd: claimed.cwd || undefined,
          last_assistant_message: claimed.last_assistant_message || undefined,
        };
      } else {
        // No message available — wait for notification or poll timeout
        const idleTime = Date.now() - lastActivity;
        if (idleTime > GENERATOR_IDLE_TIMEOUT_MS) {
          logger.info('SESSION', 'Generator idle timeout, exiting', { sessionDbId });
          session.idleTimedOut = true;
          session.abortController.abort();
          return;
        }

        // Wait for either an event notification or poll interval
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, CLAIM_POLL_INTERVAL_MS);
          const onMessage = () => {
            clearTimeout(timeout);
            resolve();
          };
          emitter.once('message', onMessage);

          // If aborted, resolve immediately
          if (session.abortController.signal.aborted) {
            clearTimeout(timeout);
            emitter.removeListener('message', onMessage);
            resolve();
          }
        });
      }
    }
  }

  /**
   * Get the PendingMessageStore interface (for ResponseProcessor)
   */
  getPendingMessageStore(): PendingMessageStoreRef {
    const db = getDb();
    return {
      confirmProcessed(messageId: number): void {
        // Fire-and-forget — errors are logged but don't block
        confirmProcessed(db, messageId).catch((error) => {
          logger.error('QUEUE', 'confirmProcessed failed', { messageId }, error as Error);
        });
      },
    };
  }

  // ============================================================================
  // DatabaseManager Adapter (for ResponseProcessor)
  // ============================================================================

  /**
   * Create a DatabaseManagerRef adapter that ResponseProcessor expects
   */
  private createDatabaseManager(): DatabaseManagerRef {
    const embedFn = this.embedFn;
    const self = this;

    return {
      getSessionStore(): SessionStoreRef {
        const db = getDb();

        return {
          ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string): void {
            // Fire-and-forget — persist memory session ID to DB
            updateMemorySessionId(db, sessionDbId, memorySessionId).catch((error) => {
              logger.error('DB', 'Failed to update memorySessionId', {
                sessionDbId,
                memorySessionId,
              }, error as Error);
            });
          },

          storeObservations(
            memorySessionId: string,
            project: string,
            observations: ParsedObservation[],
            summary: NormalizedSummary | null,
            promptNumber: number,
            discoveryTokens: number,
            originalTimestamp?: number,
          ): StorageResult {
            const now = originalTimestamp || Date.now();
            const createdAt = new Date(now).toISOString();

            // Convert parsed observations to ObservationInput[]
            const obsInputs: ObservationInput[] = observations.map((obs) => ({
              memory_session_id: memorySessionId,
              project,
              type: obs.type as ObservationInput['type'],
              title: obs.title || undefined,
              subtitle: obs.subtitle || undefined,
              narrative: obs.narrative || undefined,
              facts: obs.facts ? JSON.stringify(obs.facts) : undefined,
              concepts: obs.concepts ? JSON.stringify(obs.concepts) : undefined,
              files_read: obs.files_read ? JSON.stringify(obs.files_read) : undefined,
              files_modified: obs.files_modified ? JSON.stringify(obs.files_modified) : undefined,
              prompt_number: promptNumber,
              discovery_tokens: discoveryTokens,
              created_at: createdAt,
            }));

            // Convert summary
            const summaryInput: SessionSummaryInput | undefined = summary
              ? {
                  memory_session_id: memorySessionId,
                  project,
                  request: summary.request,
                  investigated: summary.investigated,
                  learned: summary.learned,
                  completed: summary.completed,
                  next_steps: summary.next_steps,
                  notes: summary.notes || undefined,
                  prompt_number: promptNumber,
                  discovery_tokens: discoveryTokens,
                  created_at: createdAt,
                }
              : undefined;

            // Store asynchronously but return a placeholder result
            // The actual IDs will be available after the promise resolves
            const resultPromise = storeObservations(
              db,
              obsInputs,
              memorySessionId,
              embedFn,
              summaryInput,
            );

            // Block on the result (this is called from an async context)
            // We return a "pending" result and the caller handles the async nature
            // For compatibility with the sync interface, we use a trick:
            // store the promise and let the caller await it
            const pendingResult: StorageResult = {
              observationIds: [],
              summaryId: null,
              createdAtEpoch: now,
            };

            // Attach the promise for the caller to await
            (pendingResult as any)._promise = resultPromise.then((result) => {
              pendingResult.observationIds = result.observationIds;
              pendingResult.summaryId = result.summaryId;
              pendingResult.createdAtEpoch = result.createdAtEpoch;

              // Broadcast SSE events for the viewer
              for (let i = 0; i < obsInputs.length; i++) {
                const obs = obsInputs[i];
                const obsId = result.observationIds[i];
                if (obsId) {
                  self.broadcastEvent({
                    type: 'new_observation',
                    observation: {
                      id: obsId,
                      memory_session_id: obs.memory_session_id,
                      project: obs.project || project,
                      type: obs.type,
                      title: obs.title || null,
                      subtitle: obs.subtitle || null,
                      narrative: obs.narrative || null,
                      text: null,
                      facts: obs.facts || null,
                      concepts: obs.concepts || null,
                      files_read: obs.files_read || null,
                      files_modified: obs.files_modified || null,
                      prompt_number: obs.prompt_number || 0,
                      created_at: obs.created_at || createdAt,
                      created_at_epoch: now,
                    },
                  });
                }
              }
              if (summaryInput && result.summaryId) {
                self.broadcastEvent({
                  type: 'new_summary',
                  summary: {
                    id: result.summaryId,
                    session_id: memorySessionId,
                    project,
                    request: summaryInput.request || null,
                    investigated: summaryInput.investigated || null,
                    learned: summaryInput.learned || null,
                    completed: summaryInput.completed || null,
                    next_steps: summaryInput.next_steps || null,
                    notes: summaryInput.notes || null,
                    created_at: summaryInput.created_at || createdAt,
                    created_at_epoch: now,
                  },
                });
              }
            }).catch((error) => {
              logger.error('DB', 'storeObservations failed', { memorySessionId }, error as Error);
            });

            return pendingResult;
          },
        };
      },
    };
  }

  // ============================================================================
  // Session Cleanup
  // ============================================================================

  /**
   * Delete a session — abort agent, cleanup subprocess, remove from maps
   */
  async deleteSession(sessionDbId: number): Promise<void> {
    const session = this.sessions.get(sessionDbId);
    if (!session) return;

    const sessionDuration = Date.now() - session.startTime;

    // 1. Abort the SDK agent
    session.abortController.abort();

    // 2. Wait for generator to finish (30s timeout)
    if (session.generatorPromise) {
      const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      await Promise.race([
        session.generatorPromise.catch(() => {}),
        timeoutPromise,
      ]);
    }

    // 3. Verify subprocess exit
    const tracked = getProcessBySession(sessionDbId);
    if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
      await ensureProcessExit(tracked, 5000);
    }

    // 4. Cleanup maps
    this.sessions.delete(sessionDbId);
    this.sessionQueues.delete(sessionDbId);

    logger.info('SESSION', 'Session deleted', {
      sessionId: sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      project: session.project,
    });
  }

  /**
   * Shutdown all active sessions (called during graceful shutdown)
   */
  async shutdownAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map((id) => this.deleteSession(id)));
  }

  /**
   * Get number of active sessions
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Check if any session is actively processing
   */
  async isAnySessionProcessing(): Promise<boolean> {
    const db = getDb();
    return await hasAnyPendingWork(db);
  }

  /**
   * Get total active work items (active sessions as a proxy)
   */
  async getTotalActiveWork(): Promise<number> {
    return this.sessions.size;
  }

  /**
   * Get set of active session IDs (for orphan reaper)
   */
  getActiveSessionIds(): Set<number> {
    return new Set(this.sessions.keys());
  }
}
