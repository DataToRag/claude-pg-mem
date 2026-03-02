#!/usr/bin/env node
/**
 * Smart Install Script for claude-pg-mem
 *
 * Ensures native dependencies (node_modules) are installed in the plugin directory.
 * Runs on Setup and SessionStart hooks.
 *
 * Uses a version marker file to skip reinstall on subsequent runs.
 * All errors exit 0 (never block Claude Code).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// Early exit if plugin is disabled in Claude Code settings
function isPluginDisabled() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(configDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings?.enabledPlugins?.['claude-pg-mem@mannyyang'] === false;
  } catch {
    return false;
  }
}

if (isPluginDisabled()) {
  process.exit(0);
}

/**
 * Resolve plugin root directory.
 * Priority: CLAUDE_PLUGIN_ROOT env > script location > legacy path
 */
function resolveRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }

  // Derive from script location (this file is in <root>/scripts/)
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {
    // import.meta.url not available in CJS
  }

  // Fallback
  return join(homedir(), '.claude', 'plugins', 'marketplaces', 'mannyyang', 'plugin');
}

try {
  const ROOT = resolveRoot();
  const MARKER = join(ROOT, '.install-version');
  const PKG_PATH = join(ROOT, 'package.json');

  if (!existsSync(PKG_PATH)) {
    // No package.json means no deps to install
    process.exit(0);
  }

  // Read current version
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  const currentVersion = pkg.version || '0.0.0';

  // Check if already installed for this version
  if (existsSync(MARKER)) {
    const installedVersion = readFileSync(MARKER, 'utf-8').trim();
    if (installedVersion === currentVersion && existsSync(join(ROOT, 'node_modules'))) {
      // Already up to date
      process.exit(0);
    }
  }

  // Ensure data directory exists
  const dataDir = process.env.CLAUDE_PG_MEM_DATA_DIR || join(homedir(), '.claude-pg-mem');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Install dependencies
  console.error('claude-pg-mem: Installing native dependencies...');
  execSync('npm install --production --no-audit --no-fund', {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000,
  });

  // Write version marker
  writeFileSync(MARKER, currentVersion, 'utf-8');
  console.error('claude-pg-mem: Dependencies installed.');
} catch (error) {
  // Never block Claude Code
  console.error(`claude-pg-mem: smart-install warning: ${error.message || error}`);
  process.exit(0);
}
