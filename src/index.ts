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

    case 'logs':
      await handleLogs(args);
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

    case 'search': {
      await handleQuery('search', args);
      break;
    }

    case 'recent': {
      await handleQuery('recent', args);
      break;
    }

    case 'projects': {
      await handleQuery('projects', args);
      break;
    }

    case 'stats': {
      await handleQuery('stats', args);
      break;
    }

    case 'timeline': {
      await handleQuery('timeline', args);
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
      process.exit(1);
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
 * Parse CLI flags from args array.
 * Supports --flag value and --flag=value forms.
 */
function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = args[++i];
      } else {
        flags[arg.slice(2)] = 'true';
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short flags: -n 10, -p project
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags[arg.slice(1)] = args[++i];
      } else {
        flags[arg.slice(1)] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/**
 * Handle query subcommands: search, recent, projects, stats, timeline
 */
async function handleQuery(subcommand: string, queryArgs: string[]): Promise<void> {
  const { getWorkerPort, getWorkerHost } = await import('./shared/worker-utils.js');
  const base = `http://${getWorkerHost()}:${getWorkerPort()}`;

  const { flags, positional } = parseFlags(queryArgs);
  const limit = flags.limit || flags.n || '';
  const project = flags.project || flags.p || '';

  switch (subcommand) {
    case 'search': {
      const query = positional.join(' ');
      const params = new URLSearchParams();
      if (query) params.set('query', query);
      if (project) params.set('project', project);
      if (limit) params.set('limit', limit);
      if (flags.type) params.set('type', flags.type);
      if (flags['obs-type']) params.set('obs_type', flags['obs-type']);
      if (flags.since) params.set('dateStart', flags.since);
      if (flags.until) params.set('dateEnd', flags.until);
      if (flags.order) params.set('orderBy', flags.order);

      const results = unwrapMcpResponse(await fetchWorker(`${base}/api/search?${params}`));

      if (results.observations?.length) {
        console.log(`\nObservations (${results.observations.length}):\n`);
        for (const obs of results.observations) {
          const date = new Date(obs.created_at_epoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const typeTag = (obs.type || '').padEnd(10);
          console.log(`  #${String(obs.id).padEnd(5)} ${date.padEnd(7)} ${typeTag} ${obs.project || ''}`);
          console.log(`         ${obs.title}`);
          if (obs.subtitle) console.log(`         ${dim(obs.subtitle)}`);
          console.log('');
        }
      }
      if (results.sessions?.length) {
        console.log(`Sessions (${results.sessions.length}):\n`);
        for (const s of results.sessions) {
          const date = new Date(s.created_at_epoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          console.log(`  ${date}  ${s.project || ''}  ${(s.request || '').slice(0, 80)}`);
        }
        console.log('');
      }
      if (!results.observations?.length && !results.sessions?.length) {
        console.log('No results found.');
      }
      if (results.strategy) console.log(dim(`Strategy: ${results.strategy}`));
      break;
    }

    case 'recent': {
      const params = new URLSearchParams();
      params.set('limit', limit || '15');
      if (project) params.set('project', project);

      const data = await fetchWorker(`${base}/api/observations?${params}`);

      if (!data.items?.length) {
        console.log('No observations found.');
        break;
      }

      console.log('');
      let lastDate = '';
      for (const obs of data.items) {
        const date = obs.created_at.slice(0, 10);
        if (date !== lastDate) {
          if (lastDate) console.log('');
          console.log(bold(date));
          lastDate = date;
        }
        const typeTag = (obs.type || '').padEnd(10);
        console.log(`  #${String(obs.id).padEnd(5)} ${typeTag} ${(obs.project || '').padEnd(22)} ${obs.title.slice(0, 60)}`);
      }
      console.log('');
      if (data.items.length >= parseInt(limit || '15', 10)) {
        console.log(dim(`Showing ${data.items.length} results. Use --limit N to see more.`));
      }
      break;
    }

    case 'projects': {
      const data = await fetchWorker(`${base}/api/projects`);
      const list = Array.isArray(data) ? data : (data.projects || []);
      if (!list.length) {
        console.log('No projects found.');
        break;
      }
      console.log(`\nProjects (${list.length}):\n`);
      for (const p of list) {
        console.log(`  ${p}`);
      }
      console.log('');
      break;
    }

    case 'stats': {
      const data = await fetchWorker(`${base}/api/stats`);
      console.log(`\nWorker Stats:\n`);
      printObject(data, 1);
      console.log('');
      break;
    }

    case 'timeline': {
      const params = new URLSearchParams();
      if (positional[0]) params.set('anchor', positional[0]);
      if (project) params.set('project', project);
      if (flags.before) params.set('depth_before', flags.before);
      if (flags.after) params.set('depth_after', flags.after);

      if (!positional[0] && !project) {
        console.error('Usage: claude-pg-mem timeline [observation-id] --project <name>');
        console.error('  At least one of observation ID or --project is required.');
        process.exit(1);
      }

      const results = unwrapMcpResponse(await fetchWorker(`${base}/api/timeline?${params}`));

      if (results.observations?.length) {
        console.log('');
        for (const obs of results.observations) {
          const date = new Date(obs.created_at_epoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const typeTag = (obs.type || '').padEnd(10);
          console.log(`  #${String(obs.id).padEnd(5)} ${date.padEnd(18)} ${typeTag} ${obs.title}`);
          if (obs.narrative) console.log(`         ${dim(obs.narrative.slice(0, 120))}`);
          console.log('');
        }
      } else {
        console.log('No timeline entries found.');
      }
      break;
    }
  }
}

/**
 * Fetch JSON from worker, with friendly error on connection failure.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchWorker(url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    console.error('Worker is not running. Start it with: claude-pg-mem start');
    process.exit(1);
  }
  return res.json();
}

/**
 * Unwrap MCP-style { content: [{ text: JSON }] } responses.
 * Returns the inner results object, or the data as-is if not wrapped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapMcpResponse(data: any): any {
  try {
    const parsed = data?.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
    return parsed.results || parsed;
  } catch {
    return data;
  }
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

function printObject(obj: Record<string, unknown>, indent: number): void {
  const pad = '  '.repeat(indent);
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      console.log(`${pad}${key}:`);
      printObject(value as Record<string, unknown>, indent + 1);
    } else if (Array.isArray(value)) {
      console.log(`${pad}${key}: [${value.join(', ')}]`);
    } else {
      console.log(`${pad}${key}: ${value}`);
    }
  }
}

/**
 * Start the worker service as a daemon
 */
async function handleStart(): Promise<void> {
  ensureAllDataDirs();
  const { WorkerService } = await import('./services/worker-service.js');

  const before = await WorkerService.status();
  if (before.running) {
    console.log(`Worker already running (PID ${before.pid}, port ${before.port})`);
    return;
  }

  console.log(`Starting worker on port ${before.port}...`);
  await WorkerService.start();

  const after = await WorkerService.status();
  if (after.running) {
    console.log(`Worker started (PID ${after.pid}, port ${after.port})`);
    console.log(`  UI: http://127.0.0.1:${after.port}`);
  } else {
    console.error(`Worker failed to start. Check logs: ~/.claude-pg-mem/logs/`);
    process.exit(1);
  }
}

/**
 * Stop the worker service
 */
async function handleStop(): Promise<void> {
  const { WorkerService } = await import('./services/worker-service.js');

  const before = await WorkerService.status();
  if (!before.running) {
    console.log(`Worker not running (port ${before.port})`);
    return;
  }

  console.log(`Stopping worker (PID ${before.pid}, port ${before.port})...`);
  await WorkerService.stop();

  const after = await WorkerService.status();
  if (!after.running) {
    console.log('Worker stopped');
  } else {
    console.error('Worker failed to stop cleanly');
    process.exit(1);
  }
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
  console.log(`  UI:      http://127.0.0.1:${info.port}`);
}

/**
 * Show recent logs, optionally filtered to errors/warnings
 */
async function handleLogs(logArgs: string[]): Promise<void> {
  const { existsSync, readdirSync, readFileSync } = await import('fs');
  const { join } = await import('path');
  const { LOGS_DIR } = await import('./shared/paths.js');

  if (!existsSync(LOGS_DIR)) {
    console.log('No logs directory found');
    return;
  }

  const errorsOnly = logArgs.includes('--errors') || logArgs.includes('-e');
  const numLines = (() => {
    const nIdx = logArgs.indexOf('-n');
    if (nIdx !== -1 && logArgs[nIdx + 1]) return parseInt(logArgs[nIdx + 1], 10);
    return errorsOnly ? 100 : 50;
  })();

  // Find the most recent log file
  const logFiles = readdirSync(LOGS_DIR)
    .filter(f => f.startsWith('claude-pg-mem-') && f.endsWith('.log'))
    .sort()
    .reverse();

  if (logFiles.length === 0) {
    console.log('No log files found');
    return;
  }

  const logFile = join(LOGS_DIR, logFiles[0]);
  const content = readFileSync(logFile, 'utf-8');
  let lines = content.split('\n').filter(l => l.length > 0);

  if (errorsOnly) {
    lines = lines.filter(l => l.includes('[ERROR]') || l.includes('[WARN ]'));
  }

  const tail = lines.slice(-numLines);

  console.log(`${logFiles[0]}${errorsOnly ? ' (errors/warnings only)' : ''}:`);
  console.log('');
  for (const line of tail) {
    console.log(line);
  }

  if (lines.length > numLines) {
    console.log(`\n... ${lines.length - numLines} more lines (use -n <count> to show more)`);
  }
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
  logs        Show recent logs (--errors for errors only, -n <count>)
  install     Register as Claude Code plugin
  uninstall   Remove Claude Code plugin
  mcp         Start MCP server (stdio mode, for Claude Code)
  hook        Run a hook (called by Claude Code)

Query:
  search [query]             Search observations (semantic + keyword)
    --project, -p <name>       Filter by project
    --limit, -n <count>        Max results (default 20)
    --type <type>              Filter: observations, sessions, prompts
    --obs-type <types>         Filter: bugfix,feature,discovery,decision,change
    --since <date>             Start date (ISO or epoch)
    --until <date>             End date (ISO or epoch)
    --order <order>            Sort: date_desc, date_asc, relevance

  recent                     Show recent observations
    --project, -p <name>       Filter by project
    --limit, -n <count>        Max results (default 15)

  timeline [obs-id]          Show timeline around an observation or project
    --project, -p <name>       Filter by project
    --before <n>               Observations before anchor (default 3)
    --after <n>                Observations after anchor (default 3)

  projects                   List all known projects
  stats                      Show worker and database statistics

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
