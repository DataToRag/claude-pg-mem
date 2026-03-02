#!/usr/bin/env node
/**
 * claude-pg-memory CLI Entry Point
 *
 * Handles all CLI commands:
 *   claude-pg-memory start      - Start the worker service (daemon mode)
 *   claude-pg-memory stop       - Stop the worker
 *   claude-pg-memory restart    - Restart the worker
 *   claude-pg-memory status     - Show worker status
 *   claude-pg-memory install    - Register hooks with Claude Code
 *   claude-pg-memory uninstall  - Remove hooks from Claude Code
 *   claude-pg-memory mcp        - Start MCP server (stdio mode)
 *   claude-pg-memory hook <platform> <event> - Run a hook (called by Claude Code)
 */

import { logger } from './utils/logger.js';
import {
  readPidFile,
  isProcessAlive,
  removePidFile,
  spawnDaemon,
  cleanStalePidFile,
} from './services/infrastructure/ProcessManager.js';
import { getWorkerPort } from './shared/worker-utils.js';
import { DATA_DIR, ensureAllDataDirs } from './shared/paths.js';

const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case 'start':
      await handleStart();
      break;

    case 'stop':
      await handleStop();
      break;

    case 'restart':
      await handleStop();
      await handleStart();
      break;

    case 'status':
      handleStatus();
      break;

    case 'install': {
      const { install } = await import('./installer/index.js');
      await install();
      break;
    }

    case 'uninstall': {
      const { uninstall } = await import('./installer/index.js');
      await uninstall();
      break;
    }

    case 'mcp': {
      // MCP server mode - stdio transport, spawned by Claude Code
      // The mcp-server.ts module starts itself when imported
      await import('./servers/mcp-server.js');
      break;
    }

    case 'hook': {
      // Hook mode: claude-pg-memory hook <platform> <event>
      const [platform, event] = args;
      if (!platform || !event) {
        console.error('Usage: claude-pg-memory hook <platform> <event>');
        console.error('  platform: claude-code, cursor, raw');
        console.error('  event: context, session-init, observation, summarize, session-complete, user-message, file-edit');
        process.exit(1);
      }
      const { hookCommand } = await import('./cli/hook-command.js');
      await hookCommand(platform, event);
      break;
    }

    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

/**
 * Start the worker service as a daemon
 */
async function handleStart(): Promise<void> {
  ensureAllDataDirs();

  // Check if already running
  cleanStalePidFile();
  const pidInfo = readPidFile();
  if (pidInfo && isProcessAlive(pidInfo.pid)) {
    console.log(`Worker already running (PID ${pidInfo.pid}, port ${pidInfo.port})`);
    return;
  }

  const port = getWorkerPort();
  console.log(`Starting worker on port ${port}...`);

  // Find the worker entry script
  // In development: use tsx to run the TypeScript source directly
  // In production (dist): the compiled JS is used
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');
  const { existsSync } = await import('fs');

  const thisDir = dirname(fileURLToPath(import.meta.url));

  // Look for the compiled worker service first, then fall back to source
  const workerScript = join(thisDir, 'services', 'worker', 'SDKAgent.js');
  const workerScriptTs = join(thisDir, '..', 'src', 'services', 'worker', 'SDKAgent.ts');

  // For now, the worker is the express HTTP server that needs to be built.
  // Spawn the daemon using the current entry point with a special flag.
  // The actual worker startup will be a separate module.
  // For MVP, log that the worker needs to be started via the dev script.
  console.log(`Worker data directory: ${DATA_DIR}`);
  console.log('');
  console.log('To start the worker in development mode:');
  console.log('  pnpm run worker:dev');
  console.log('');
  console.log('To start the worker in production mode:');
  console.log('  pnpm run worker:start');
}

/**
 * Stop the worker service
 */
async function handleStop(): Promise<void> {
  cleanStalePidFile();
  const pidInfo = readPidFile();
  if (!pidInfo) {
    console.log('Worker is not running (no PID file found)');
    return;
  }

  if (!isProcessAlive(pidInfo.pid)) {
    console.log('Worker process is dead, cleaning up PID file');
    removePidFile();
    return;
  }

  console.log(`Stopping worker (PID ${pidInfo.pid})...`);
  try {
    process.kill(pidInfo.pid, 'SIGTERM');
    // Wait for process to exit
    const maxWait = 10000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (!isProcessAlive(pidInfo.pid)) {
        removePidFile();
        console.log('Worker stopped');
        return;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    // Force kill if still alive
    process.kill(pidInfo.pid, 'SIGKILL');
    removePidFile();
    console.log('Worker force-killed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      removePidFile();
      console.log('Worker already stopped');
    } else {
      console.error('Failed to stop worker:', error);
      process.exit(1);
    }
  }
}

/**
 * Show worker status
 */
function handleStatus(): void {
  cleanStalePidFile();
  const pidInfo = readPidFile();
  if (!pidInfo) {
    console.log('Worker: stopped');
    return;
  }

  if (!isProcessAlive(pidInfo.pid)) {
    console.log('Worker: dead (stale PID file)');
    removePidFile();
    return;
  }

  console.log(`Worker: running`);
  console.log(`  PID:     ${pidInfo.pid}`);
  console.log(`  Port:    ${pidInfo.port}`);
  console.log(`  Started: ${pidInfo.startedAt}`);
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
claude-pg-memory - Postgres-native persistent memory for Claude Code

Usage: claude-pg-memory <command>

Commands:
  start       Start the worker service
  stop        Stop the worker service
  restart     Restart the worker service
  status      Show worker status
  install     Register hooks with Claude Code
  uninstall   Remove hooks from Claude Code
  mcp         Start MCP server (stdio mode, for Claude Code)
  hook        Run a hook (called by Claude Code)

Examples:
  npx claude-pg-memory install          # Set up hooks
  npx claude-pg-memory start            # Start worker
  npx claude-pg-memory status           # Check if running
  npx claude-pg-memory hook claude-code context   # Run context hook
`.trim());
}

main().catch(error => {
  logger.error('SYSTEM', 'CLI error', {}, error as Error);
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
