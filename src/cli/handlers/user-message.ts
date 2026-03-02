/**
 * User Message Handler - SessionStart (parallel)
 *
 * Displays context info to user via stderr.
 * Uses exit code 0 (SUCCESS) - stderr is not shown to Claude with exit 0.
 */

import { basename } from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';

export const userMessageHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      return { exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const port = getWorkerPort();
    const project = basename(input.cwd ?? process.cwd());

    // Fetch formatted context directly from worker API
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}&colors=true`,
        { method: 'GET' }
      );

      if (!response.ok) {
        return { exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      const output = await response.text();

      // Write to stderr for user visibility
      process.stderr.write(
        '\n\n' +
          String.fromCodePoint(0x1f4dd) +
          ' Claude-PG-Memory Context Loaded\n\n' +
          output +
          '\n\n' +
          String.fromCodePoint(0x1f4a1) +
          ' Wrap any message with <private> ... </private> to prevent storing sensitive information.\n' +
          '\n' +
          String.fromCodePoint(0x1f4fa) +
          ` Watch live in browser http://localhost:${port}/\n`
      );
    } catch (_error) {
      // Worker unreachable - skip user message gracefully
    }

    return { exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
