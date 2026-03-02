/**
 * ResponseProcessor: Shared response processing for all agent implementations
 *
 * Responsibility:
 * - Parse observations and summaries from agent responses
 * - Store to database via worker HTTP calls (Postgres)
 * - Generate embeddings for new observations
 * - Fire SSE events for web UI
 * - Content hash deduplication
 *
 * Ported from claude-mem - adapted for Postgres backend.
 * The ResponseProcessor in claude-mem called SQLite directly;
 * here we use the same interface but the caller provides
 * database manager and session manager abstractions.
 */

import { logger } from '../../../utils/logger.js';
import {
  parseObservations,
  parseSummary,
  type ParsedObservation,
  type ParsedSummary,
} from '../../../sdk/parser.js';
import type { ActiveSession } from '../../worker-types.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { cleanupProcessedMessages } from './SessionCleanupHelper.js';

/**
 * Database manager interface (to avoid circular imports)
 * The actual implementation will provide Postgres-backed storage
 */
export interface DatabaseManagerRef {
  getSessionStore(): SessionStoreRef;
}

/**
 * Session store interface for atomic transaction
 */
export interface SessionStoreRef {
  ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string): void;
  storeObservations(
    memorySessionId: string,
    project: string,
    observations: ParsedObservation[],
    summary: NormalizedSummary | null,
    promptNumber: number,
    discoveryTokens: number,
    originalTimestamp?: number
  ): StorageResult;
}

/**
 * Session manager interface (to avoid circular imports)
 */
export interface SessionManagerRef {
  getPendingMessageStore(): PendingMessageStoreRef;
}

/**
 * Pending message store interface
 */
export interface PendingMessageStoreRef {
  confirmProcessed(messageId: number): void;
}

/**
 * Normalized summary for storage (convert null fields to empty strings)
 */
export interface NormalizedSummary {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

/**
 * Process agent response text (parse XML, save to database, broadcast SSE)
 *
 * This is the unified response processor that handles:
 * 1. Adding response to conversation history (for provider interop)
 * 2. Parsing observations and summaries from XML
 * 3. Atomic database transaction to store observations + summary
 * 4. SSE broadcast to web UI clients
 * 5. Session cleanup
 *
 * @param text - Response text from the agent
 * @param session - Active session being processed
 * @param dbManager - Database manager for storage operations
 * @param sessionManager - Session manager for message tracking
 * @param worker - Worker reference for SSE broadcasting (optional)
 * @param discoveryTokens - Token cost delta for this response
 * @param originalTimestamp - Original epoch when message was queued
 * @param agentName - Name of the agent for logging
 * @param validTypes - Valid observation type IDs from the active mode
 * @param projectRoot - Optional project root path
 */
export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManagerRef,
  sessionManager: SessionManagerRef,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  validTypes: string[],
  projectRoot?: string
): Promise<void> {
  // Track generator activity for stale detection
  session.lastGeneratorActivity = Date.now();

  // Add assistant response to shared conversation history for provider interop
  if (text) {
    session.conversationHistory.push({ role: 'assistant', content: text });
  }

  // Parse observations and summary
  const observations = parseObservations(text, validTypes, session.contentSessionId);
  const summary = parseSummary(text, session.sessionDbId);

  // Convert nullable fields to empty strings for storage (if summary exists)
  const summaryForStore = normalizeSummaryForStorage(summary);

  // Get session store for atomic transaction
  const sessionStore = dbManager.getSessionStore();

  // CRITICAL: Must use memorySessionId (not contentSessionId) for FK constraint
  if (!session.memorySessionId) {
    throw new Error('Cannot store observations: memorySessionId not yet captured');
  }

  // Safety net: ensure memory session ID is registered in DB
  sessionStore.ensureMemorySessionIdRegistered(session.sessionDbId, session.memorySessionId);

  // Log pre-storage with session ID chain for verification
  logger.info(
    'DB',
    `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${observations.length} | hasSummary=${!!summaryForStore}`,
    {
      sessionId: session.sessionDbId,
      memorySessionId: session.memorySessionId,
    }
  );

  // ATOMIC TRANSACTION: Store observations + summary ONCE
  const result = sessionStore.storeObservations(
    session.memorySessionId,
    session.project,
    observations,
    summaryForStore,
    session.lastPromptNumber,
    discoveryTokens,
    originalTimestamp ?? undefined
  );

  // Log storage result with IDs for traceability
  logger.info(
    'DB',
    `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`,
    {
      sessionId: session.sessionDbId,
      memorySessionId: session.memorySessionId,
    }
  );

  // CLAIM-CONFIRM: Now that storage succeeded, confirm all processing messages
  const pendingStore = sessionManager.getPendingMessageStore();
  for (const messageId of session.processingMessageIds) {
    pendingStore.confirmProcessed(messageId);
  }
  if (session.processingMessageIds.length > 0) {
    logger.debug(
      'QUEUE',
      `CONFIRMED_BATCH | sessionDbId=${session.sessionDbId} | count=${session.processingMessageIds.length} | ids=[${session.processingMessageIds.join(',')}]`
    );
  }
  // Clear the tracking array after confirmation
  session.processingMessageIds = [];

  // After transaction: broadcast observations to SSE clients
  for (let i = 0; i < observations.length; i++) {
    const obsId = result.observationIds[i];
    const obs = observations[i];

    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts || []),
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      project: session.project,
      prompt_number: session.lastPromptNumber,
      created_at_epoch: result.createdAtEpoch,
    });
  }

  // Broadcast summary if present
  if (summaryForStore && result.summaryId) {
    broadcastSummary(worker, {
      id: result.summaryId,
      session_id: session.contentSessionId,
      request: summary!.request,
      investigated: summary!.investigated,
      learned: summary!.learned,
      completed: summary!.completed,
      next_steps: summary!.next_steps,
      notes: summary!.notes,
      project: session.project,
      prompt_number: session.lastPromptNumber,
      created_at_epoch: result.createdAtEpoch,
    });
  }

  // Clean up session state
  cleanupProcessedMessages(session, worker);
}

/**
 * Normalize summary for storage (convert null fields to empty strings)
 */
function normalizeSummaryForStorage(summary: ParsedSummary | null): NormalizedSummary | null {
  if (!summary) return null;

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes,
  };
}
