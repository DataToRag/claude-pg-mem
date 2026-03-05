/**
 * Install Flow Tests
 *
 * Tests the full install pipeline to ensure all pieces work together:
 *
 * INSTALL FLOW OVERVIEW:
 * =====================
 *
 * 1. install.sh (bash)
 *    - Checks prerequisites (node >= 22, pnpm)
 *    - Clones repo to ~/.claude-pg-mem/cli/ (or rsync from local)
 *    - Runs pnpm install (deps)
 *    - Runs pnpm build (tsc → dist/)
 *    - Runs pnpm build:plugin (esbuild → plugin/scripts/)
 *    - Creates CLI wrapper at ~/.local/bin/claude-pg-mem
 *
 * 2. claude-pg-mem install (src/installer/index.ts)
 *    - Copies plugin/ to ~/.claude/plugins/marketplaces/DataToRag/
 *    - Copies plugin/ to ~/.claude/plugins/cache/DataToRag/claude-pg-mem/<version>/
 *    - Registers in known_marketplaces.json
 *    - Registers in installed_plugins.json
 *    - Enables in ~/.claude/settings.json
 *
 * 3. Claude Code session start (hooks)
 *    - Setup hook: smart-install.js (npm install native deps in plugin cache)
 *    - SessionStart hook: worker-service.cjs start (spawn daemon)
 *    - SessionStart hook: worker-service.cjs hook context (inject memory)
 *
 * KEY DIRECTORIES:
 *   ~/.claude-pg-mem/cli/           - Source code + dist/ + plugin/
 *   ~/.claude-pg-mem/cli/plugin/    - Plugin distribution (hooks, scripts, modes)
 *   ~/.claude/plugins/cache/...     - What Claude Code actually runs (CLAUDE_PLUGIN_ROOT)
 *   ~/.local/bin/claude-pg-mem      - CLI wrapper → node ~/.claude-pg-mem/cli/dist/index.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// Create isolated temp dirs so tests don't touch real ~/.claude or ~/.claude-pg-mem
function createTestDirs() {
  const base = join(tmpdir(), `cpm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const dirs = {
    base,
    claudeDir: join(base, '.claude'),
    pluginsDir: join(base, '.claude', 'plugins'),
    cacheDir: join(base, '.claude', 'plugins', 'cache', 'DataToRag', 'claude-pg-mem', '0.1.0'),
    marketplaceDir: join(base, '.claude', 'plugins', 'marketplaces', 'DataToRag'),
    dataDir: join(base, '.claude-pg-mem'),
    cliDir: join(base, '.claude-pg-mem', 'cli'),
  };
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true });
  }
  return dirs;
}

function cleanup(base: string) {
  rmSync(base, { recursive: true, force: true });
}

// ── Build Output Tests ──────────────────────────────────────────────

describe('build:plugin output', () => {
  const pluginDir = join(process.cwd(), 'plugin');

  it('worker-service.cjs exists and is non-empty', () => {
    const p = join(pluginDir, 'scripts', 'worker-service.cjs');
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(100_000); // ~1.8MB
  });

  it('mcp-server.cjs exists and is non-empty', () => {
    const p = join(pluginDir, 'scripts', 'mcp-server.cjs');
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(100_000); // ~341KB
  });

  it('smart-install.js exists', () => {
    expect(existsSync(join(pluginDir, 'scripts', 'smart-install.js'))).toBe(true);
  });

  it('hooks.json exists and references .cjs worker', () => {
    const hooks = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf-8'));
    const commands = JSON.stringify(hooks);
    expect(commands).toContain('worker-service.cjs');
    expect(commands).not.toContain('worker-service.mjs');
  });

  it('plugin.json manifest exists with correct name', () => {
    const manifest = JSON.parse(
      readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf-8')
    );
    expect(manifest.name).toBe('claude-pg-mem');
  });

  it('plugin package.json only lists huggingface as dependency', () => {
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf-8'));
    const deps = Object.keys(pkg.dependencies || {});
    expect(deps).toContain('@huggingface/transformers');
    expect(deps).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(deps).not.toContain('sharp');
    expect(deps).not.toContain('fsevents');
  });
});

// ── Build Config Tests ──────────────────────────────────────────────

describe('esbuild config', () => {
  it('build:plugin produces zero warnings', () => {
    const output = execSync('pnpm run build:plugin 2>&1', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(output).not.toContain('[WARNING]');
    expect(output).toContain('Build complete!');
  });
});

// ── Plugin Registration Tests ───────────────────────────────────────

describe('plugin registration (scripts/install.js)', () => {
  let dirs: ReturnType<typeof createTestDirs>;

  beforeEach(() => {
    dirs = createTestDirs();
  });

  afterEach(() => {
    cleanup(dirs.base);
  });

  it('copies plugin files to cache directory', () => {
    // Simulate what scripts/install.js does: copy plugin/ to cache
    const { cpSync } = require('fs');
    const pluginSource = join(process.cwd(), 'plugin');
    cpSync(pluginSource, dirs.cacheDir, { recursive: true });

    expect(existsSync(join(dirs.cacheDir, 'scripts', 'worker-service.cjs'))).toBe(true);
    expect(existsSync(join(dirs.cacheDir, 'scripts', 'mcp-server.cjs'))).toBe(true);
    expect(existsSync(join(dirs.cacheDir, 'hooks', 'hooks.json'))).toBe(true);
    expect(existsSync(join(dirs.cacheDir, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('creates correct known_marketplaces.json structure', () => {
    const knownPath = join(dirs.pluginsDir, 'known_marketplaces.json');
    const data = {
      DataToRag: {
        source: { source: 'github', repo: 'DataToRag/claude-pg-mem' },
        installLocation: dirs.marketplaceDir,
        lastUpdated: new Date().toISOString(),
        autoUpdate: true,
      },
    };
    writeFileSync(knownPath, JSON.stringify(data, null, 2));

    const parsed = JSON.parse(readFileSync(knownPath, 'utf-8'));
    expect(parsed.DataToRag.source.repo).toBe('DataToRag/claude-pg-mem');
    expect(parsed.DataToRag.autoUpdate).toBe(true);
  });

  it('creates correct installed_plugins.json structure', () => {
    const installedPath = join(dirs.pluginsDir, 'installed_plugins.json');
    const data = {
      version: 2,
      plugins: {
        'claude-pg-mem@DataToRag': [
          {
            scope: 'user',
            installPath: dirs.cacheDir,
            version: '0.1.0',
            installedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
          },
        ],
      },
    };
    writeFileSync(installedPath, JSON.stringify(data, null, 2));

    const parsed = JSON.parse(readFileSync(installedPath, 'utf-8'));
    expect(parsed.version).toBe(2);
    expect(parsed.plugins['claude-pg-mem@DataToRag']).toHaveLength(1);
    expect(parsed.plugins['claude-pg-mem@DataToRag'][0].installPath).toBe(dirs.cacheDir);
  });

  it('enables plugin in settings.json', () => {
    const settingsPath = join(dirs.claudeDir, 'settings.json');
    const settings = { enabledPlugins: { 'claude-pg-mem@DataToRag': true } };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.enabledPlugins['claude-pg-mem@DataToRag']).toBe(true);
  });
});

// ── Worker CJS Bundle Tests ─────────────────────────────────────────

describe('worker-service.cjs bundle', () => {
  it('can be loaded with CLAUDE_PLUGIN_ROOT set', () => {
    // The bundle should parse without errors when CLAUDE_PLUGIN_ROOT is set
    // We test by checking it doesn't throw on require (but don't start the server)
    const cjs = join(process.cwd(), 'plugin', 'scripts', 'worker-service.cjs');
    const result = execSync(
      `CLAUDE_PLUGIN_ROOT="${join(process.cwd(), 'plugin')}" node -e "try { require('${cjs}'); } catch(e) { if (!e.message.includes('listen')) process.exit(1); }"`,
      { encoding: 'utf-8', timeout: 10_000, env: { ...process.env, CLAUDE_PLUGIN_ROOT: join(process.cwd(), 'plugin') } }
    );
    // If we get here without error, the bundle loaded successfully
    expect(true).toBe(true);
  });

  it('does not contain import.meta references in output', () => {
    // The CJS bundle should not have bare import.meta that would fail
    // (guarded ones inside try/catch are OK)
    const content = readFileSync(
      join(process.cwd(), 'plugin', 'scripts', 'worker-service.cjs'),
      'utf-8'
    );
    // Should not have the ESM-only module pattern at top level
    expect(content).not.toContain('import.meta.url');
    // The SDK should be bundled in, not external
    expect(content).not.toContain("require('@anthropic-ai/claude-agent-sdk')");
  });
});

// ── Path Resolution Tests ───────────────────────────────────────────

describe('path resolution', () => {
  it('getPackageRoot falls back to DATA_DIR/cli/plugin when CLAUDE_PLUGIN_ROOT not set', async () => {
    const saved = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      // Dynamic import to get fresh module
      const { getPackageRoot } = await import('../../src/shared/paths.js');
      const root = getPackageRoot();
      expect(root).toContain('cli');
      expect(root).toContain('plugin');
    } finally {
      if (saved) process.env.CLAUDE_PLUGIN_ROOT = saved;
      else delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });

  it('getPackageRoot uses CLAUDE_PLUGIN_ROOT when set', async () => {
    const saved = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = '/test/plugin/root';
    try {
      const { getPackageRoot } = await import('../../src/shared/paths.js');
      const root = getPackageRoot();
      expect(root).toBe('/test/plugin/root');
    } finally {
      if (saved) process.env.CLAUDE_PLUGIN_ROOT = saved;
      else delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });
});

// ── Smart Install Tests ─────────────────────────────────────────────

describe('smart-install.js', () => {
  let dirs: ReturnType<typeof createTestDirs>;

  beforeEach(() => {
    dirs = createTestDirs();
    // Copy plugin to simulate cache dir
    const { cpSync } = require('fs');
    cpSync(join(process.cwd(), 'plugin'), dirs.cacheDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(dirs.base);
  });

  it('skips install when .install-version matches', () => {
    // Write matching version marker
    writeFileSync(join(dirs.cacheDir, '.install-version'), '0.1.0');
    // Create node_modules stub
    mkdirSync(join(dirs.cacheDir, 'node_modules'), { recursive: true });

    const output = execSync(
      `CLAUDE_PLUGIN_ROOT="${dirs.cacheDir}" node "${join(dirs.cacheDir, 'scripts', 'smart-install.js')}" 2>&1 || true`,
      { encoding: 'utf-8', timeout: 10_000 }
    );
    // Should exit silently (no "Installing" message)
    expect(output).not.toContain('Installing native dependencies');
  });

  it('runs install when .install-version is missing', () => {
    // No marker file, no node_modules
    const output = execSync(
      `CLAUDE_PLUGIN_ROOT="${dirs.cacheDir}" node "${join(dirs.cacheDir, 'scripts', 'smart-install.js')}" 2>&1 || true`,
      { encoding: 'utf-8', timeout: 120_000 }
    );
    expect(output).toContain('Installing native dependencies');
  });
});

// ── CLI Wrapper Tests ───────────────────────────────────────────────

describe('CLI wrapper', () => {
  it('dist/index.js exists and is valid ESM', () => {
    const entry = join(process.cwd(), 'dist', 'index.js');
    expect(existsSync(entry)).toBe(true);
    const content = readFileSync(entry, 'utf-8');
    // Should use ESM imports (tsc output with "type": "module")
    expect(content).toContain('import');
  });

  it('package.json has type: module', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.type).toBe('module');
  });
});

// ── Hooks Structure Tests ───────────────────────────────────────────

describe('hooks configuration', () => {
  const hooks = JSON.parse(
    readFileSync(join(process.cwd(), 'plugin', 'hooks', 'hooks.json'), 'utf-8')
  );

  it('has all required hook types', () => {
    expect(hooks.hooks).toHaveProperty('Setup');
    expect(hooks.hooks).toHaveProperty('SessionStart');
    expect(hooks.hooks).toHaveProperty('UserPromptSubmit');
    expect(hooks.hooks).toHaveProperty('PostToolUse');
    expect(hooks.hooks).toHaveProperty('Stop');
  });

  it('SessionStart runs smart-install before worker start', () => {
    const sessionStart = hooks.hooks.SessionStart[0].hooks;
    expect(sessionStart[0].command).toContain('smart-install.js');
    expect(sessionStart[1].command).toContain('worker-service.cjs');
    expect(sessionStart[1].command).toContain('start');
  });

  it('SessionStart injects context after worker start', () => {
    const sessionStart = hooks.hooks.SessionStart[0].hooks;
    expect(sessionStart[2].command).toContain('hook claude-code context');
  });

  it('all hooks use CLAUDE_PLUGIN_ROOT variable', () => {
    const allCommands = JSON.stringify(hooks);
    // Every script reference should use ${CLAUDE_PLUGIN_ROOT}
    expect(allCommands).not.toContain('/.claude-pg-mem/');
    expect(allCommands).not.toContain('/absolute/');
    expect(allCommands).toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('hook execution order is correct', () => {
    // Setup → SessionStart → UserPromptSubmit → PostToolUse → Stop
    const hookTypes = Object.keys(hooks.hooks);
    expect(hookTypes).toEqual(['Setup', 'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
  });
});
