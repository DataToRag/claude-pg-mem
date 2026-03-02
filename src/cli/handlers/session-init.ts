/**
 * Session Init Handler - UserPromptSubmit
 *
 * Initializes session and starts SDK agent.
 * POST /api/sessions/init to create session + check privacy
 * POST /sessions/{sessionDbId}/init to start observer agent (Claude Code only, not Cursor)
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd, prompt: rawPrompt } = input;

    // Guard: Codex CLI and other platforms may not provide a session_id
    if (!sessionId) {
      logger.warn('HOOK', 'session-init: No sessionId provided, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Check if project is excluded from tracking
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (cwd && isProjectExcluded(cwd, settings.CLAUDE_PG_MEM_EXCLUDED_PROJECTS)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    // Handle image-only prompts (where text prompt is empty/undefined)
    const prompt = !rawPrompt || !rawPrompt.trim() ? '[media prompt]' : rawPrompt;

    const project = getProjectName(cwd);
    const port = getWorkerPort();

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', {
      contentSessionId: sessionId,
      project,
    });

    // Initialize session via HTTP - handles DB operations and privacy checks
    const initResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        project,
        prompt,
      }),
    });

    if (!initResponse.ok) {
      logger.failure(
        'HOOK',
        `Session initialization failed: ${initResponse.status}`,
        { contentSessionId: sessionId, project }
      );
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const initResult = (await initResponse.json()) as {
      sessionDbId: number;
      promptNumber: number;
      skipped?: boolean;
      reason?: string;
      contextInjected?: boolean;
    };
    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', {
      sessionDbId,
      promptNumber,
      skipped: initResult.skipped,
      contextInjected: initResult.contextInjected,
    });

    // Check if prompt was entirely private (worker performs privacy check)
    if (initResult.skipped && initResult.reason === 'private') {
      logger.info(
        'HOOK',
        `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`,
        { sessionId: sessionDbId }
      );
      return { continue: true, suppressOutput: true };
    }

    // Skip SDK agent re-initialization if context was already injected for this session
    if (initResult.contextInjected) {
      logger.info(
        'HOOK',
        `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped_agent_init=true | reason=context_already_injected`,
        { sessionId: sessionDbId }
      );
      return { continue: true, suppressOutput: true };
    }

    // Only initialize SDK agent for Claude Code (not Cursor)
    if (input.platform !== 'cursor' && sessionDbId) {
      // Strip leading slash from commands for memory agent
      const cleanedPrompt = prompt.startsWith('/') ? prompt.substring(1) : prompt;

      logger.debug('HOOK', 'session-init: Calling /sessions/{sessionDbId}/init', {
        sessionDbId,
        promptNumber,
      });

      // Initialize SDK agent session via HTTP (starts the agent!)
      const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber }),
      });

      if (!response.ok) {
        logger.failure('HOOK', `SDK agent start failed: ${response.status}`, {
          sessionDbId,
          promptNumber,
        });
      }
    } else if (input.platform === 'cursor') {
      logger.debug('HOOK', 'session-init: Skipping SDK agent init for Cursor platform', {
        sessionDbId,
        promptNumber,
      });
    }

    logger.info(
      'HOOK',
      `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`,
      { sessionId: sessionDbId }
    );

    return { continue: true, suppressOutput: true };
  },
};
