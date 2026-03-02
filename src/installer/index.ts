/**
 * Installer for claude-pg-memory
 *
 * Registers/unregisters hooks and MCP server entries in Claude Code's
 * settings.json (~/.claude/settings.json).
 *
 * Hook commands use `npx claude-pg-memory hook <platform> <event>` so they
 * work regardless of where the package is installed (global, local, npx).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  CLAUDE_SETTINGS_PATH,
  CLAUDE_CONFIG_DIR,
  DATA_DIR,
  ensureAllDataDirs,
} from '../shared/paths.js';
import { logger } from '../utils/logger.js';

/**
 * Hook configuration matching Claude Code's hooks spec.
 * Each hook entry defines when and how to call claude-pg-memory.
 */
const HOOK_CONFIG = {
  SessionStart: [
    {
      matcher: 'startup|clear|compact',
      hooks: [
        {
          type: 'command',
          command: 'npx claude-pg-memory hook claude-code context',
          timeout: 60,
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: 'command',
          command: 'npx claude-pg-memory hook claude-code session-init',
          timeout: 60,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      hooks: [
        {
          type: 'command',
          command: 'npx claude-pg-memory hook claude-code observation',
          timeout: 120,
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: 'command',
          command: 'npx claude-pg-memory hook claude-code summarize',
          timeout: 120,
        },
        {
          type: 'command',
          command: 'npx claude-pg-memory hook claude-code session-complete',
          timeout: 30,
        },
      ],
    },
  ],
} as const;

/**
 * MCP server configuration for Claude Code
 */
const MCP_SERVER_CONFIG = {
  command: 'npx',
  args: ['claude-pg-memory', 'mcp'],
  env: {},
};

const PLUGIN_NAME = 'claude-pg-memory';

/**
 * Read the Claude Code settings file.
 * Returns an empty object if the file does not exist or is malformed.
 */
function readClaudeSettings(): Record<string, any> {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) {
    return {};
  }
  try {
    const content = readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    logger.warn('SYSTEM', 'Failed to parse Claude settings, treating as empty', {
      path: CLAUDE_SETTINGS_PATH,
    }, error as Error);
    return {};
  }
}

/**
 * Write the Claude Code settings file, creating the directory if needed.
 */
function writeClaudeSettings(settings: Record<string, any>): void {
  if (!existsSync(CLAUDE_CONFIG_DIR)) {
    mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Check whether a hook entry belongs to claude-pg-memory.
 */
function isOurHookEntry(entry: any): boolean {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h: any) => typeof h.command === 'string' && h.command.includes(PLUGIN_NAME),
  );
}

/**
 * Install claude-pg-memory into Claude Code settings.
 *
 * 1. Add hook entries for all lifecycle events
 * 2. Add MCP server entry
 * 3. Create data directory
 */
export async function install(): Promise<void> {
  console.log('Installing claude-pg-memory...\n');

  // 1. Ensure data directory exists
  ensureAllDataDirs();
  console.log(`  Data directory: ${DATA_DIR}`);

  // 2. Read existing settings
  const settings = readClaudeSettings();

  // 3. Add hook entries (merge, don't overwrite other plugins)
  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const [eventName, hookEntries] of Object.entries(HOOK_CONFIG)) {
    if (!settings.hooks[eventName]) {
      settings.hooks[eventName] = [];
    }

    // Remove any existing claude-pg-memory entries for this event
    settings.hooks[eventName] = (settings.hooks[eventName] as any[]).filter(
      (entry: any) => !isOurHookEntry(entry),
    );

    // Add our entries
    settings.hooks[eventName].push(...hookEntries);
  }

  console.log('  Hooks registered: SessionStart, UserPromptSubmit, PostToolUse, Stop');

  // 4. Add MCP server entry
  if (!settings.mcpServers) {
    settings.mcpServers = {};
  }
  settings.mcpServers[PLUGIN_NAME] = MCP_SERVER_CONFIG;
  console.log(`  MCP server registered: ${PLUGIN_NAME}`);

  // 5. Write back settings
  writeClaudeSettings(settings);
  console.log(`  Settings written: ${CLAUDE_SETTINGS_PATH}`);

  // 6. Print success and next steps
  console.log(`
Installation complete!

Next steps:
  1. Set your database connection:
     export DATABASE_URL="postgres://user:pass@host:5432/dbname"
     (or set CLAUDE_PG_MEMORY_DATABASE_URL in ~/.claude-pg-memory/settings.json)

  2. Run database migrations:
     npx claude-pg-memory db:push

  3. Start the worker:
     npx claude-pg-memory start

  4. Restart Claude Code to activate hooks.

  Embeddings run locally via Nomic Embed Text v1 — no API key needed.
`);
}

/**
 * Uninstall claude-pg-memory from Claude Code settings.
 *
 * 1. Remove all claude-pg-memory hook entries
 * 2. Remove MCP server entry
 */
export async function uninstall(): Promise<void> {
  console.log('Uninstalling claude-pg-memory...\n');

  const settings = readClaudeSettings();

  // 1. Remove hook entries
  if (settings.hooks) {
    let removedHooks = 0;
    for (const eventName of Object.keys(settings.hooks)) {
      const before = settings.hooks[eventName]?.length ?? 0;
      settings.hooks[eventName] = (settings.hooks[eventName] as any[]).filter(
        (entry: any) => !isOurHookEntry(entry),
      );
      const after = settings.hooks[eventName].length;
      removedHooks += before - after;

      // Clean up empty arrays
      if (settings.hooks[eventName].length === 0) {
        delete settings.hooks[eventName];
      }
    }

    // Clean up empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    console.log(`  Removed ${removedHooks} hook entries`);
  } else {
    console.log('  No hooks to remove');
  }

  // 2. Remove MCP server entry
  if (settings.mcpServers && settings.mcpServers[PLUGIN_NAME]) {
    delete settings.mcpServers[PLUGIN_NAME];
    console.log(`  Removed MCP server: ${PLUGIN_NAME}`);

    // Clean up empty mcpServers object
    if (Object.keys(settings.mcpServers).length === 0) {
      delete settings.mcpServers;
    }
  } else {
    console.log('  No MCP server entry to remove');
  }

  // 3. Write back settings
  writeClaudeSettings(settings);
  console.log(`  Settings written: ${CLAUDE_SETTINGS_PATH}`);

  console.log(`
Uninstall complete!

Note: Your data in ${DATA_DIR} has been preserved.
To remove all data, run: rm -rf ${DATA_DIR}

Restart Claude Code to deactivate hooks.
`);
}
