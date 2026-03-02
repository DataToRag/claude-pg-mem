/**
 * SDKAgent: SDK query loop handler
 *
 * Responsibility:
 * - Spawn Claude subprocess via Agent SDK
 * - Run event-driven query loop (no polling)
 * - Process SDK responses (observations, summaries)
 * - Store to database (Postgres)
 *
 * Ported from claude-mem - adapted for Postgres backend.
 * Removed Chroma sync (not used in PG version).
 * Uses same process registry and agent pool logic.
 */

import { execSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { logger } from '../../utils/logger.js';
import {
  buildInitPrompt,
  buildObservationPrompt,
  buildSummaryPrompt,
  buildContinuationPrompt,
} from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, OBSERVER_SESSIONS_DIR, ensureDir } from '../../shared/paths.js';
import { buildIsolatedEnv, getAuthMethodDescription } from '../../shared/EnvManager.js';
import type { ActiveSession, SDKUserMessage } from '../worker-types.js';
import type { ModeConfig } from '../domain/types.js';
import {
  processAgentResponse,
  type DatabaseManagerRef,
  type SessionManagerRef,
} from './agents/ResponseProcessor.js';
import type { WorkerRef } from './agents/types.js';
import {
  createPidCapturingSpawn,
  getProcessBySession,
  ensureProcessExit,
  waitForSlot,
} from './ProcessRegistry.js';

// Import Agent SDK (assumes it's installed)
// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Session manager interface (provides message iteration)
 */
export interface SDKSessionManager extends SessionManagerRef {
  getMessageIterator(
    sessionDbId: number
  ): AsyncIterable<{
    _persistentId: number;
    type: 'observation' | 'summarize';
    tool_name?: string;
    tool_input?: any;
    tool_response?: any;
    prompt_number?: number;
    cwd?: string;
    last_assistant_message?: string;
  }>;
}

export class SDKAgent {
  private dbManager: DatabaseManagerRef;
  private sessionManager: SDKSessionManager;

  constructor(dbManager: DatabaseManagerRef, sessionManager: SDKSessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Start SDK agent for a session (event-driven, no polling)
   * @param session Active session to process
   * @param mode Active mode configuration (provides observation types and prompts)
   * @param worker WorkerService reference for SSE broadcasting (optional)
   */
  async startSession(session: ActiveSession, mode: ModeConfig, worker?: WorkerRef): Promise<void> {
    // Track cwd from messages for worktree support
    const cwdTracker = { lastCwd: undefined as string | undefined };

    // Find Claude executable
    const claudePath = this.findClaudeExecutable();

    // Get model ID
    const modelId = this.getModelId();

    // Memory agent is OBSERVER ONLY - no tools allowed
    const disallowedTools = [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
      'Task',
      'NotebookEdit',
      'AskUserQuestion',
      'TodoWrite',
    ];

    // Create message generator (event-driven)
    const messageGenerator = this.createMessageGenerator(session, mode, cwdTracker);

    // Resume logic: only resume if memorySessionId exists, not first prompt, not forceInit
    const hasRealMemorySessionId = !!session.memorySessionId;
    const shouldResume =
      hasRealMemorySessionId && session.lastPromptNumber > 1 && !session.forceInit;

    if (session.forceInit) {
      logger.info('SDK', 'forceInit flag set, starting fresh SDK session', {
        sessionDbId: session.sessionDbId,
        previousMemorySessionId: session.memorySessionId,
      });
      session.forceInit = false;
    }

    // Wait for agent pool slot
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxConcurrent =
      parseInt(settings.CLAUDE_PG_MEMORY_MAX_CONCURRENT_AGENTS, 10) || 2;
    await waitForSlot(maxConcurrent);

    // Build isolated environment
    const isolatedEnv = buildIsolatedEnv();
    const authMethod = getAuthMethodDescription();

    logger.info('SDK', 'Starting SDK query', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      memorySessionId: session.memorySessionId ?? undefined,
      shouldResume,
      resume_parameter: shouldResume ? (session.memorySessionId ?? '(none)') : '(none - fresh start)',
      lastPromptNumber: session.lastPromptNumber,
      authMethod,
    });

    // Run Agent SDK query loop
    ensureDir(OBSERVER_SESSIONS_DIR);
    const queryResult = query({
      prompt: messageGenerator,
      options: {
        model: modelId,
        cwd: OBSERVER_SESSIONS_DIR,
        ...(shouldResume && session.memorySessionId ? { resume: session.memorySessionId } : {}),
        disallowedTools,
        abortController: session.abortController,
        pathToClaudeCodeExecutable: claudePath,
        spawnClaudeCodeProcess: createPidCapturingSpawn(session.sessionDbId),
        env: isolatedEnv,
      },
    });

    // Extract valid type IDs from mode config
    const validTypes = mode.observation_types.map((t) => t.id);

    // Process SDK messages
    try {
      for await (const message of queryResult) {
        // Capture or update memory session ID from SDK message
        if (message.session_id && message.session_id !== session.memorySessionId) {
          const previousId = session.memorySessionId;
          session.memorySessionId = message.session_id;
          // Persist to database IMMEDIATELY for FK constraint compliance
          this.dbManager
            .getSessionStore()
            .ensureMemorySessionIdRegistered(session.sessionDbId, message.session_id);

          const logMessage = previousId
            ? `MEMORY_ID_CHANGED | sessionDbId=${session.sessionDbId} | from=${previousId} | to=${message.session_id}`
            : `MEMORY_ID_CAPTURED | sessionDbId=${session.sessionDbId} | memorySessionId=${message.session_id}`;
          logger.info('SESSION', logMessage, {
            sessionId: session.sessionDbId,
            memorySessionId: message.session_id,
            previousId,
          });
        }

        // Handle assistant messages
        if (message.type === 'assistant') {
          const content = message.message.content;
          const textContent = Array.isArray(content)
            ? content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('\n')
            : typeof content === 'string'
              ? content
              : '';

          // Check for context overflow
          if (
            textContent.includes('prompt is too long') ||
            textContent.includes('context window')
          ) {
            logger.error('SDK', 'Context overflow detected - terminating session');
            session.abortController.abort();
            return;
          }

          const responseSize = textContent.length;

          // Capture token state BEFORE updating (for delta calculation)
          const tokensBeforeResponse =
            session.cumulativeInputTokens + session.cumulativeOutputTokens;

          // Extract and track token usage
          const usage = message.message.usage;
          if (usage) {
            session.cumulativeInputTokens += usage.input_tokens || 0;
            session.cumulativeOutputTokens += usage.output_tokens || 0;

            if (usage.cache_creation_input_tokens) {
              session.cumulativeInputTokens += usage.cache_creation_input_tokens;
            }
          }

          // Calculate discovery tokens
          const discoveryTokens =
            session.cumulativeInputTokens +
            session.cumulativeOutputTokens -
            tokensBeforeResponse;

          // Capture earliest timestamp BEFORE processing
          const originalTimestamp = session.earliestPendingTimestamp;

          if (responseSize > 0) {
            const truncatedResponse =
              responseSize > 100 ? textContent.substring(0, 100) + '...' : textContent;
            logger.dataOut('SDK', `Response received (${responseSize} chars)`, {
              sessionId: session.sessionDbId,
              promptNumber: session.lastPromptNumber,
            });
          }

          // Detect fatal context overflow
          if (typeof textContent === 'string' && textContent.includes('Prompt is too long')) {
            throw new Error('Claude session context overflow: prompt is too long');
          }

          // Detect invalid API key
          if (typeof textContent === 'string' && textContent.includes('Invalid API key')) {
            throw new Error(
              'Invalid API key: check your API key configuration in ~/.claude-pg-memory/settings.json or ~/.claude-pg-memory/.env'
            );
          }

          // Parse and process response using shared ResponseProcessor
          await processAgentResponse(
            textContent,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            discoveryTokens,
            originalTimestamp,
            'SDK',
            validTypes,
            cwdTracker.lastCwd
          );
        }
      }
    } finally {
      // Ensure subprocess is terminated after query completes (or on error)
      const tracked = getProcessBySession(session.sessionDbId);
      if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
        await ensureProcessExit(tracked, 5000);
      }
    }

    // Mark session complete
    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
    });
  }

  /**
   * Create event-driven message generator
   */
  private async *createMessageGenerator(
    session: ActiveSession,
    mode: ModeConfig,
    cwdTracker: { lastCwd: string | undefined }
  ): AsyncIterableIterator<SDKUserMessage> {
    // Build initial prompt
    const isInitPrompt = session.lastPromptNumber === 1;
    logger.info('SDK', 'Creating message generator', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      lastPromptNumber: session.lastPromptNumber,
      isInitPrompt,
      promptType: isInitPrompt ? 'INIT' : 'CONTINUATION',
    });

    const initPrompt = isInitPrompt
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(
          session.userPrompt,
          session.lastPromptNumber,
          session.contentSessionId,
          mode
        );

    // Add to shared conversation history
    session.conversationHistory.push({ role: 'user', content: initPrompt });

    // Yield initial user prompt
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: initPrompt,
      },
      session_id: session.contentSessionId,
      parent_tool_use_id: null,
      isSynthetic: true,
    };

    // Consume pending messages from SessionManager (event-driven)
    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      // Track message ID for confirmProcessed() after successful storage
      session.processingMessageIds.push(message._persistentId);

      // Capture cwd from each message for worktree support
      if (message.cwd) {
        cwdTracker.lastCwd = message.cwd;
      }

      if (message.type === 'observation') {
        // Update last prompt number
        if (message.prompt_number !== undefined) {
          session.lastPromptNumber = message.prompt_number;
        }

        const obsPrompt = buildObservationPrompt({
          id: 0, // Not used in prompt
          tool_name: message.tool_name!,
          tool_input: JSON.stringify(message.tool_input),
          tool_output: JSON.stringify(message.tool_response),
          created_at_epoch: Date.now(),
          cwd: message.cwd,
        });

        // Add to shared conversation history
        session.conversationHistory.push({ role: 'user', content: obsPrompt });

        yield {
          type: 'user',
          message: {
            role: 'user',
            content: obsPrompt,
          },
          session_id: session.contentSessionId,
          parent_tool_use_id: null,
          isSynthetic: true,
        };
      } else if (message.type === 'summarize') {
        const summaryPrompt = buildSummaryPrompt(
          {
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || '',
          },
          mode
        );

        // Add to shared conversation history
        session.conversationHistory.push({ role: 'user', content: summaryPrompt });

        yield {
          type: 'user',
          message: {
            role: 'user',
            content: summaryPrompt,
          },
          session_id: session.contentSessionId,
          parent_tool_use_id: null,
          isSynthetic: true,
        };
      }
    }
  }

  // ============================================================================
  // Configuration Helpers
  // ============================================================================

  /**
   * Find Claude executable
   */
  private findClaudeExecutable(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // 1. Check configured path
    if (settings.CLAUDE_CODE_PATH) {
      const { existsSync: fsExistsSync } = require('fs');
      if (!fsExistsSync(settings.CLAUDE_CODE_PATH)) {
        throw new Error(
          `CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but the file does not exist.`
        );
      }
      return settings.CLAUDE_CODE_PATH;
    }

    // 2. On Windows, prefer "claude.cmd" via PATH
    if (process.platform === 'win32') {
      try {
        execSync('where claude.cmd', {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return 'claude.cmd';
      } catch {
        // Fall through
      }
    }

    // 3. Try auto-detection
    try {
      const claudePath = execSync(
        process.platform === 'win32' ? 'where claude' : 'which claude',
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      )
        .trim()
        .split('\n')[0]
        .trim();

      if (claudePath) return claudePath;
    } catch (error) {
      logger.debug('SDK', 'Claude executable auto-detection failed', {}, error as Error);
    }

    throw new Error(
      'Claude executable not found. Please either:\n1. Add "claude" to your system PATH, or\n2. Set CLAUDE_CODE_PATH in ~/.claude-pg-memory/settings.json'
    );
  }

  /**
   * Get model ID from settings
   */
  private getModelId(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return settings.CLAUDE_PG_MEMORY_MODEL;
  }
}
