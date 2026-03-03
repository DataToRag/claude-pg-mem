#!/usr/bin/env node
/**
 * claude-pg-mem CLI Entry Point
 *
 * Handles all CLI commands:
 *   claude-pg-mem start      - Start the worker service (daemon mode)
 *   claude-pg-mem stop       - Stop the worker
 *   claude-pg-mem restart    - Restart the worker
 *   claude-pg-mem status     - Show worker status
 *   claude-pg-mem install    - Register hooks with Claude Code
 *   claude-pg-mem uninstall  - Remove hooks from Claude Code
 *   claude-pg-mem mcp        - Start MCP server (stdio mode)
 *   claude-pg-mem hook <platform> <event> - Run a hook (called by Claude Code)
 *   claude-pg-mem config set <key> <value> - Set a config value
 *   claude-pg-mem config get <key>          - Get a config value
 *   claude-pg-mem config list               - List all config values
 *   claude-pg-mem config reset              - Reset config to defaults
 */

import { logger } from './utils/logger.js';
import { USER_SETTINGS_PATH, ensureAllDataDirs } from './shared/paths.js';

const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
  // Daemon mode: spawned by `start` command via spawnDaemon()
  if (command === '--daemon') {
    const { WorkerService } = await import('./services/worker-service.js');
    const worker = new WorkerService();
    await worker.startDaemon();
    return;
  }

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
      await handleStatus();
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

    case 'config': {
      await handleConfig(args);
      break;
    }

    case 'db': {
      await handleDb(args);
      break;
    }

    case 'hook': {
      // Hook mode: claude-pg-mem hook <platform> <event>
      const [platform, event] = args;
      if (!platform || !event) {
        console.error('Usage: claude-pg-mem hook <platform> <event>');
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
 * Handle config subcommands: set, get, list, reset
 */
async function handleConfig(configArgs: string[]): Promise<void> {
  const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('fs');
  const { dirname } = await import('path');
  const { SettingsDefaultsManager } = await import('./shared/SettingsDefaultsManager.js');

  const [subcommand, key, ...rest] = configArgs;

  // Ensure settings file exists
  if (!existsSync(dirname(USER_SETTINGS_PATH))) {
    mkdirSync(dirname(USER_SETTINGS_PATH), { recursive: true });
  }

  function readSettings(): Record<string, string> {
    if (!existsSync(USER_SETTINGS_PATH)) return {};
    try {
      return JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }

  function writeSettings(settings: Record<string, string>): void {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  // Normalize key: allow shorthand (e.g. "DATABASE_URL" -> "CLAUDE_PG_MEM_DATABASE_URL")
  function normalizeKey(k: string): string {
    if (!k) return k;
    // Already has prefix
    if (k.startsWith('CLAUDE_PG_MEM_')) return k;
    // Special case: DATABASE_URL -> CLAUDE_PG_MEM_DATABASE_URL
    const prefixed = `CLAUDE_PG_MEM_${k}`;
    const defaults = SettingsDefaultsManager.getAllDefaults();
    if (prefixed in defaults) return prefixed;
    // Also check without prefix in case they typed the full key for a non-prefixed one
    if (k in defaults) return k;
    // Default to prefixed
    return prefixed;
  }

  switch (subcommand) {
    case 'set': {
      if (!key || rest.length === 0) {
        console.error('Usage: claude-pg-mem config set <key> <value>');
        console.error('');
        console.error('Examples:');
        console.error('  claude-pg-mem config set DATABASE_URL "postgres://user:pass@host/db"');
        console.error('  claude-pg-mem config set WORKER_PORT 37778');
        console.error('  claude-pg-mem config set LOG_LEVEL DEBUG');
        process.exit(1);
      }
      const normalizedKey = normalizeKey(key);
      const value = rest.join(' ');
      const settings = readSettings();
      settings[normalizedKey] = value;
      writeSettings(settings);
      console.log(`Set ${normalizedKey} = ${value}`);
      console.log(`Saved to ${USER_SETTINGS_PATH}`);
      break;
    }

    case 'get': {
      if (!key) {
        console.error('Usage: claude-pg-mem config get <key>');
        process.exit(1);
      }
      const normalizedKey = normalizeKey(key);
      const merged = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const value = (merged as unknown as Record<string, string>)[normalizedKey];
      if (value !== undefined) {
        // Mask sensitive values
        const isSensitive = normalizedKey.includes('DATABASE_URL') ||
          normalizedKey.includes('API_KEY') ||
          normalizedKey.includes('PASSWORD');
        if (isSensitive && value) {
          // Show first 20 chars then mask the rest
          const visible = value.slice(0, 20);
          console.log(`${normalizedKey} = ${visible}${'*'.repeat(Math.max(0, value.length - 20))}`);
        } else {
          console.log(`${normalizedKey} = ${value}`);
        }
      } else {
        console.log(`${normalizedKey} is not set`);
      }
      break;
    }

    case 'list': {
      const merged = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const fileSettings = readSettings();

      console.log(`Settings (${USER_SETTINGS_PATH}):\n`);
      for (const [k, v] of Object.entries(merged as unknown as Record<string, string>)) {
        // Skip empty defaults to reduce noise
        if (!v && !(k in fileSettings)) continue;

        const isSensitive = k.includes('DATABASE_URL') || k.includes('API_KEY') || k.includes('PASSWORD');
        const displayValue = isSensitive && v ? v.slice(0, 20) + '*'.repeat(Math.max(0, v.length - 20)) : v;
        const source = process.env[k] !== undefined ? ' (env)' :
          k in fileSettings ? ' (file)' :
          ' (default)';
        console.log(`  ${k} = ${displayValue || '(empty)'}${source}`);
      }
      break;
    }

    case 'reset': {
      const defaults = SettingsDefaultsManager.getAllDefaults();
      const defaultsObj: Record<string, string> = {};
      for (const [k, v] of Object.entries(defaults)) defaultsObj[k] = v;
      writeSettings(defaultsObj);
      console.log(`Reset all settings to defaults.`);
      console.log(`Saved to ${USER_SETTINGS_PATH}`);
      break;
    }

    default:
      console.error('Usage: claude-pg-mem config <subcommand>');
      console.error('');
      console.error('Subcommands:');
      console.error('  set <key> <value>   Set a configuration value');
      console.error('  get <key>           Get a configuration value');
      console.error('  list                List all configuration values');
      console.error('  reset               Reset all settings to defaults');
      console.error('');
      console.error('Keys can use shorthand (omit CLAUDE_PG_MEM_ prefix):');
      console.error('  DATABASE_URL, WORKER_PORT, LOG_LEVEL, etc.');
      process.exit(subcommand ? 1 : 1);
  }
}

/**
 * Handle db subcommands: push, status
 */
async function handleDb(dbArgs: string[]): Promise<void> {
  const { resolveDatabaseUrl } = await import('./services/postgres/client.js');
  const { pushSchema, getDbStatus } = await import('./services/postgres/schema-push.js');

  const [subcommand] = dbArgs;

  const url = resolveDatabaseUrl();
  if (!url) {
    console.error('Error: DATABASE_URL is not configured.');
    console.error('');
    console.error('Set it with:');
    console.error('  claude-pg-mem config set DATABASE_URL "postgres://user:pass@host/db"');
    process.exit(1);
  }

  switch (subcommand) {
    case 'push': {
      console.log('Pushing schema to database...\n');
      try {
        await pushSchema(url);
        console.log('\nSchema push complete. All tables and indexes are up to date.');
      } catch (error) {
        console.error('\nSchema push failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      console.log('Checking database status...\n');
      const status = await getDbStatus(url);
      if (!status.connected) {
        console.error('  Connection: FAILED');
        console.error(`  Error: ${status.error}`);
        process.exit(1);
      }
      console.log('  Connection: OK');
      console.log('');
      console.log('  Tables:');
      for (const table of status.tables) {
        if (table.count === -1) {
          console.log(`    ${table.name.padEnd(22)} (not created)`);
        } else {
          console.log(`    ${table.name.padEnd(22)} ${table.count} rows`);
        }
      }
      break;
    }

    default:
      console.error('Usage: claude-pg-mem db <subcommand>');
      console.error('');
      console.error('Subcommands:');
      console.error('  push     Create/update tables and indexes');
      console.error('  status   Check connection and show table counts');
      process.exit(subcommand ? 1 : 0);
  }
}

/**
 * Start the worker service as a daemon
 */
async function handleStart(): Promise<void> {
  ensureAllDataDirs();
  const { WorkerService } = await import('./services/worker-service.js');
  await WorkerService.start();
}

/**
 * Stop the worker service
 */
async function handleStop(): Promise<void> {
  const { WorkerService } = await import('./services/worker-service.js');
  await WorkerService.stop();
}

/**
 * Show worker status
 */
async function handleStatus(): Promise<void> {
  const { WorkerService } = await import('./services/worker-service.js');
  const info = await WorkerService.status();
  if (!info.running) {
    console.log('Worker: stopped');
    return;
  }
  console.log('Worker: running');
  if (info.pid) console.log(`  PID:     ${info.pid}`);
  console.log(`  Port:    ${info.port}`);
  if (info.version) console.log(`  Version: ${info.version}`);
  if (info.uptime) console.log(`  Uptime:  ${Math.round(info.uptime)}s`);
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
claude-pg-mem - Postgres-native persistent memory for Claude Code

Usage: claude-pg-mem <command>

Commands:
  config      Manage configuration settings
  db          Database operations (push schema, check status)
  start       Start the worker service
  stop        Stop the worker service
  restart     Restart the worker service
  status      Show worker status
  install     Register as Claude Code plugin
  uninstall   Remove Claude Code plugin
  mcp         Start MCP server (stdio mode, for Claude Code)
  hook        Run a hook (called by Claude Code)

Config:
  config set <key> <value>   Set a configuration value
  config get <key>           Get a configuration value
  config list                List all configuration values
  config reset               Reset all settings to defaults

Database:
  db push                    Create/update tables and indexes
  db status                  Check connection and show table counts

Setup:
  claude-pg-mem config set DATABASE_URL "postgres://..."
  claude-pg-mem db push
  claude-pg-mem install
  claude-pg-mem start
`.trim());
}

main().catch(error => {
  logger.error('SYSTEM', 'CLI error', {}, error as Error);
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
