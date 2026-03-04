/**
 * Plugin Installer for claude-pg-mem
 *
 * Registers/unregisters the plugin in Claude Code's plugin marketplace system:
 *   - ~/.claude/plugins/known_marketplaces.json
 *   - ~/.claude/plugins/installed_plugins.json
 *   - ~/.claude/plugins/cache/DataToRag/claude-pg-mem/<version>/
 *   - ~/.claude/settings.json (enabledPlugins)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import {
  CLAUDE_CONFIG_DIR,
  CLAUDE_SETTINGS_PATH,
  DATA_DIR,
  ensureAllDataDirs,
  getPackageRoot,
} from '../shared/paths.js';

const PLUGINS_DIR = join(CLAUDE_CONFIG_DIR, 'plugins');
const MARKETPLACE_DIR = join(PLUGINS_DIR, 'marketplaces', 'DataToRag');
const KNOWN_MARKETPLACES_PATH = join(PLUGINS_DIR, 'known_marketplaces.json');
const INSTALLED_PLUGINS_PATH = join(PLUGINS_DIR, 'installed_plugins.json');

const PLUGIN_ID = 'claude-pg-mem@DataToRag';

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filepath: string): Record<string, any> {
  if (!existsSync(filepath)) return {};
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJson(filepath: string, data: Record<string, any>): void {
  ensureDir(dirname(filepath));
  writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Get the plugin version from plugin.json manifest.
 */
function getPluginVersion(): string {
  const pluginSource = findPluginSource();
  const pluginJsonPath = join(pluginSource, '.claude-plugin', 'plugin.json');
  if (existsSync(pluginJsonPath)) {
    try {
      const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
      if (pluginJson.version) return pluginJson.version;
    } catch { /* fall through */ }
  }
  return '0.1.0';
}

/**
 * Find the plugin source directory.
 * In dev: <repo>/plugin/
 * In bundled: CLAUDE_PLUGIN_ROOT or dirname of the .cjs
 */
function findPluginSource(): string {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  const packageRoot = getPackageRoot();
  // If we're in the repo, plugin/ is a sibling
  const pluginDir = join(packageRoot, '..', 'plugin');
  if (existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))) {
    return pluginDir;
  }
  // If packageRoot IS the plugin directory
  if (existsSync(join(packageRoot, '.claude-plugin', 'plugin.json'))) {
    return packageRoot;
  }
  return pluginDir;
}

/**
 * Install claude-pg-mem as a Claude Code plugin.
 */
export async function install(): Promise<void> {
  const version = getPluginVersion();
  const pluginSource = findPluginSource();
  const pluginCachePath = join(PLUGINS_DIR, 'cache', 'DataToRag', 'claude-pg-mem', version);
  const now = new Date().toISOString();

  console.log(`Installing claude-pg-mem v${version} as Claude Code plugin...\n`);

  // Verify plugin source has bundled .cjs files
  const workerCjs = join(pluginSource, 'scripts', 'worker-service.cjs');
  const mcpCjs = join(pluginSource, 'scripts', 'mcp-server.cjs');
  if (!existsSync(workerCjs) || !existsSync(mcpCjs)) {
    console.error('Error: Bundled plugin scripts not found.');
    console.error('Run `pnpm run build:plugin` first to build the .cjs bundles.');
    process.exit(1);
  }

  // 1. Copy to marketplace directory (plugin contents go directly in the marketplace root)
  console.log(`  Copying to marketplace: ${MARKETPLACE_DIR}/`);
  if (existsSync(MARKETPLACE_DIR)) {
    rmSync(MARKETPLACE_DIR, { recursive: true });
  }
  ensureDir(dirname(MARKETPLACE_DIR));
  cpSync(pluginSource, MARKETPLACE_DIR, { recursive: true });

  // 2. Copy to cache directory
  console.log(`  Copying to cache: ${pluginCachePath}`);
  if (existsSync(pluginCachePath)) {
    rmSync(pluginCachePath, { recursive: true });
  }
  ensureDir(dirname(pluginCachePath));
  cpSync(pluginSource, pluginCachePath, { recursive: true });

  // 3. Register marketplace
  console.log('  Registering marketplace...');
  const knownMarketplaces = readJson(KNOWN_MARKETPLACES_PATH);
  knownMarketplaces['DataToRag'] = {
    source: {
      source: 'github',
      repo: 'DataToRag/claude-pg-mem',
    },
    installLocation: MARKETPLACE_DIR,
    lastUpdated: now,
    autoUpdate: true,
  };
  writeJson(KNOWN_MARKETPLACES_PATH, knownMarketplaces);

  // 4. Register installed plugin
  console.log('  Registering plugin...');
  const installedPlugins = readJson(INSTALLED_PLUGINS_PATH);
  if (!installedPlugins.version) installedPlugins.version = 2;
  if (!installedPlugins.plugins) installedPlugins.plugins = {};
  installedPlugins.plugins[PLUGIN_ID] = [
    {
      scope: 'user',
      installPath: pluginCachePath,
      version,
      installedAt: now,
      lastUpdated: now,
    },
  ];
  writeJson(INSTALLED_PLUGINS_PATH, installedPlugins);

  // 5. Enable plugin in Claude Code settings
  console.log('  Enabling plugin...');
  const settings = readJson(CLAUDE_SETTINGS_PATH);
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins[PLUGIN_ID] = true;
  writeJson(CLAUDE_SETTINGS_PATH, settings);

  // 6. Ensure data directory exists
  ensureAllDataDirs();

  console.log(`\nInstallation complete! (v${version})\n`);
  console.log('Restart Claude Code to activate the plugin.');
}

/**
 * Uninstall claude-pg-mem from Claude Code's plugin system.
 */
export async function uninstall(): Promise<void> {
  console.log('Uninstalling claude-pg-mem plugin...\n');

  // 1. Remove from enabledPlugins
  const settings = readJson(CLAUDE_SETTINGS_PATH);
  if (settings.enabledPlugins) {
    delete settings.enabledPlugins[PLUGIN_ID];
    if (Object.keys(settings.enabledPlugins).length === 0) {
      delete settings.enabledPlugins;
    }
    writeJson(CLAUDE_SETTINGS_PATH, settings);
    console.log('  Removed from enabledPlugins');
  }

  // 2. Remove from installed_plugins.json
  const installedPlugins = readJson(INSTALLED_PLUGINS_PATH);
  if (installedPlugins.plugins?.[PLUGIN_ID]) {
    delete installedPlugins.plugins[PLUGIN_ID];
    writeJson(INSTALLED_PLUGINS_PATH, installedPlugins);
    console.log('  Removed from installed plugins');
  }

  // 3. Remove from known_marketplaces.json
  const knownMarketplaces = readJson(KNOWN_MARKETPLACES_PATH);
  if (knownMarketplaces['DataToRag']) {
    delete knownMarketplaces['DataToRag'];
    writeJson(KNOWN_MARKETPLACES_PATH, knownMarketplaces);
    console.log('  Removed marketplace registration');
  }

  // 4. Remove marketplace directory
  if (existsSync(MARKETPLACE_DIR)) {
    rmSync(MARKETPLACE_DIR, { recursive: true });
    console.log('  Removed marketplace directory');
  }

  // 5. Remove cache directory
  const cacheDir = join(PLUGINS_DIR, 'cache', 'DataToRag');
  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true });
    console.log('  Removed cache directory');
  }

  console.log(`
Uninstall complete!

Note: Your data in ${DATA_DIR} has been preserved.
To remove all data: rm -rf ${DATA_DIR}

Restart Claude Code to deactivate the plugin.
`);
}
