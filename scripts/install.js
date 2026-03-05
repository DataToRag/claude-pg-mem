#!/usr/bin/env node
/**
 * Install claude-pg-mem as a Claude Code plugin.
 *
 * Registers the plugin in Claude Code's plugin system:
 *   1. Copies plugin/ to ~/.claude/plugins/cache/DataToRag/claude-pg-mem/<version>/
 *   2. Registers in ~/.claude/plugins/known_marketplaces.json
 *   3. Registers in ~/.claude/plugins/installed_plugins.json
 *   4. Enables in ~/.claude/settings.json (enabledPlugins)
 *
 * Usage:
 *   node scripts/install.js          # Install
 *   node scripts/install.js --remove # Uninstall
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PLUGIN_SOURCE = join(ROOT, 'plugin');

const CLAUDE_DIR = join(homedir(), '.claude');
const PLUGINS_DIR = join(CLAUDE_DIR, 'plugins');
const MARKETPLACE_DIR = join(PLUGINS_DIR, 'marketplaces', 'DataToRag');
const CLAUDE_SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const KNOWN_MARKETPLACES_PATH = join(PLUGINS_DIR, 'known_marketplaces.json');
const INSTALLED_PLUGINS_PATH = join(PLUGINS_DIR, 'installed_plugins.json');

const PLUGIN_ID = 'claude-pg-mem@DataToRag';

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filepath) {
  if (!existsSync(filepath)) return {};
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJson(filepath, data) {
  ensureDir(dirname(filepath));
  writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function getPluginVersion() {
  const pluginJsonPath = join(PLUGIN_SOURCE, '.claude-plugin', 'plugin.json');
  if (existsSync(pluginJsonPath)) {
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version ?? '0.1.0';
  }
  const pkgPath = join(ROOT, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.1.0';
  }
  return '0.1.0';
}

// ── Install ──────────────────────────────────────────────────────────

function install() {
  const version = getPluginVersion();
  const pluginCachePath = join(PLUGINS_DIR, 'cache', 'DataToRag', 'claude-pg-mem', version);
  const now = new Date().toISOString();

  console.log(`Installing claude-pg-mem v${version} as Claude Code plugin...\n`);

  // 1. Verify plugin/scripts/ has the bundled script files
  const workerMjs = join(PLUGIN_SOURCE, 'scripts', 'worker-service.mjs');
  const mcpCjs = join(PLUGIN_SOURCE, 'scripts', 'mcp-server.cjs');
  if (!existsSync(workerMjs) || !existsSync(mcpCjs)) {
    console.error('Error: Bundled plugin scripts not found.');
    console.error('Run `pnpm run build:plugin` first to build the plugin bundles.');
    process.exit(1);
  }

  // 2. Copy plugin/ to marketplace directory
  console.log(`  Copying to marketplace: ${MARKETPLACE_DIR}/plugin/`);
  ensureDir(MARKETPLACE_DIR);
  const marketplacePlugin = join(MARKETPLACE_DIR, 'plugin');
  if (existsSync(marketplacePlugin)) {
    rmSync(marketplacePlugin, { recursive: true });
  }
  cpSync(PLUGIN_SOURCE, marketplacePlugin, { recursive: true });

  // Also copy root package.json for version resolution
  cpSync(join(ROOT, 'package.json'), join(MARKETPLACE_DIR, 'package.json'));

  // 3. Copy plugin/ to cache directory
  console.log(`  Copying to cache: ${pluginCachePath}`);
  ensureDir(pluginCachePath);
  if (existsSync(pluginCachePath)) {
    rmSync(pluginCachePath, { recursive: true });
  }
  cpSync(PLUGIN_SOURCE, pluginCachePath, { recursive: true });

  // 4. Register marketplace
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

  // 5. Register installed plugin
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

  // 6. Enable plugin in Claude Code settings
  console.log('  Enabling plugin...');
  const settings = readJson(CLAUDE_SETTINGS_PATH);
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins[PLUGIN_ID] = true;
  writeJson(CLAUDE_SETTINGS_PATH, settings);

  // 7. Ensure data directory exists
  const dataDir = process.env.CLAUDE_PG_MEM_DATA_DIR || join(homedir(), '.claude-pg-mem');
  ensureDir(dataDir);

  console.log(`
Installation complete! (v${version})

Next steps:
  1. Set your database connection in ~/.claude-pg-mem/settings.json:
     { "CLAUDE_PG_MEM_DATABASE_URL": "postgres://user:pass@host/dbname" }

     Or set the DATABASE_URL environment variable.

  2. Push the database schema:
     pnpm run db:push

  3. Restart Claude Code to activate the plugin.

The plugin will auto-install native dependencies on first session start.
`);
}

// ── Uninstall ────────────────────────────────────────────────────────

function uninstall() {
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
  if (installedPlugins.plugins) {
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

Note: Your data in ~/.claude-pg-mem/ has been preserved.
To remove all data: rm -rf ~/.claude-pg-mem

Restart Claude Code to deactivate the plugin.
`);
}

// ── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--remove') || args.includes('--uninstall')) {
  uninstall();
} else {
  install();
}
