/**
 * CLI Hook Entry Point
 *
 * Bridge between the main entry point and the hook-command module.
 * When claude-pg-mem is called with `hook <platform> <event>`:
 *
 * 1. Read JSON from stdin (Claude Code sends hook data)
 * 2. Pick the adapter (claude-code, cursor, raw)
 * 3. Route to the correct handler
 * 4. Write JSON response to stdout
 * 5. Exit with appropriate code
 *
 * This module re-exports hookCommand for direct import by src/index.ts.
 * It also provides a standalone entry point for testing.
 */

export { hookCommand, isWorkerUnavailableError } from './hook-command.js';
export type { HookCommandOptions } from './hook-command.js';
export type { EventType } from './handlers/index.js';
export type { NormalizedHookInput, HookResult, PlatformAdapter, EventHandler } from './types.js';

/**
 * Run the hook CLI from process.argv when called directly.
 *
 * Usage: node dist/cli/index.js <platform> <event>
 */
async function runCli(): Promise<void> {
  const [platform, event] = process.argv.slice(2);

  if (!platform || !event) {
    console.error('Usage: claude-pg-mem hook <platform> <event>');
    console.error('');
    console.error('Platforms: claude-code, cursor, raw');
    console.error('Events:    context, session-init, observation, summarize,');
    console.error('           session-complete, user-message, file-edit');
    process.exit(1);
  }

  const { hookCommand } = await import('./hook-command.js');
  await hookCommand(platform, event);
}

// Run if this module is the entry point
const isMainModule = process.argv[1]?.endsWith('cli/index.js') ||
                     process.argv[1]?.endsWith('cli/index.ts');

if (isMainModule) {
  runCli().catch((error) => {
    console.error('CLI error:', error);
    process.exit(1);
  });
}
