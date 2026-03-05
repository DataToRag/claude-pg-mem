/**
 * Path Configuration for claude-pg-mem
 * Standard paths based on Claude Code conventions
 *
 * Ported from claude-mem — changed default data dir from ~/.claude-mem to ~/.claude-pg-mem
 */

import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '../utils/logger.js';

// Base directories
export const DATA_DIR = process.env.CLAUDE_PG_MEM_DATA_DIR || join(homedir(), '.claude-pg-mem');
// Note: CLAUDE_CONFIG_DIR is a Claude Code setting, not claude-pg-mem, so leave as env var
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// Data subdirectories
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const MODES_DIR = join(DATA_DIR, 'modes');
export const USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json');

// Observer sessions directory - used as cwd for SDK queries
// Sessions here won't appear in user's `claude --resume` for their actual projects
export const OBSERVER_SESSIONS_DIR = join(DATA_DIR, 'observer-sessions');

// Claude integration paths
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_CONFIG_DIR, 'settings.json');
export const CLAUDE_COMMANDS_DIR = join(CLAUDE_CONFIG_DIR, 'commands');
export const CLAUDE_MD_PATH = join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');

/**
 * Ensure a directory exists
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

/**
 * Ensure all data directories exist
 */
export function ensureAllDataDirs(): void {
  ensureDir(DATA_DIR);
  ensureDir(LOGS_DIR);
  ensureDir(MODES_DIR);
}

/**
 * Ensure modes directory exists
 */
export function ensureModesDir(): void {
  ensureDir(MODES_DIR);
}

/**
 * Ensure all Claude integration directories exist
 */
export function ensureAllClaudeDirs(): void {
  ensureDir(CLAUDE_CONFIG_DIR);
  ensureDir(CLAUDE_COMMANDS_DIR);
}

/**
 * Get current project name from git root or cwd.
 * Includes parent directory to avoid collisions when repos share a folder name
 * (e.g., ~/work/monorepo -> "work/monorepo" vs ~/personal/monorepo -> "personal/monorepo").
 */
export function getCurrentProjectName(): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    }).trim();
    return basename(dirname(gitRoot)) + '/' + basename(gitRoot);
  } catch (error) {
    logger.debug('SYSTEM', 'Git root detection failed, using cwd basename', {
      cwd: process.cwd()
    }, error as Error);
    const cwd = process.cwd();
    return basename(dirname(cwd)) + '/' + basename(cwd);
  }
}

/**
 * Find package root directory.
 * Plugin context: CLAUDE_PLUGIN_ROOT set by Claude Code.
 * CLI context: derive from DATA_DIR (~/.claude-pg-mem/cli/plugin/).
 */
export function getPackageRoot(): string {
  return process.env.CLAUDE_PLUGIN_ROOT
    || join(DATA_DIR, 'cli', 'plugin');
}

/**
 * Find commands directory in the installed package
 */
export function getPackageCommandsDir(): string {
  const packageRoot = getPackageRoot();
  return join(packageRoot, 'commands');
}

/**
 * Create a timestamped backup filename
 */
export function createBackupFilename(originalPath: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  return `${originalPath}.backup.${timestamp}`;
}
