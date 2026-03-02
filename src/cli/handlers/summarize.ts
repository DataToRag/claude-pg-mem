/**
 * Summarize Handler - Stop (Phase 1)
 *
 * Reads transcript file, extracts last assistant message,
 * POSTs to /api/sessions/summarize.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, fetchWithTimeout } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';

const SUMMARIZE_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.DEFAULT);

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, transcriptPath } = input;

    const port = getWorkerPort();

    // Validate required fields before processing
    if (!transcriptPath) {
      // No transcript available - skip summary gracefully (not an error)
      logger.debug(
        'HOOK',
        `No transcriptPath in Stop hook input for session ${sessionId} - skipping summary`
      );
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Extract last assistant message from transcript (the work Claude did)
    const lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      workerPort: port,
      hasLastAssistantMessage: !!lastAssistantMessage,
    });

    // Send to worker - worker handles privacy check and database operations
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${port}/api/sessions/summarize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId,
          last_assistant_message: lastAssistantMessage,
        }),
      },
      SUMMARIZE_TIMEOUT_MS
    );

    if (!response.ok) {
      return { continue: true, suppressOutput: true };
    }

    logger.debug('HOOK', 'Summary request sent successfully');

    return { continue: true, suppressOutput: true };
  },
};
