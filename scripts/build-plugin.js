#!/usr/bin/env node
/**
 * Build plugin distribution bundles.
 *
 * Produces:
 *   plugin/scripts/worker-service.cjs  - Worker + hooks + CLI (all-in-one)
 *   plugin/scripts/mcp-server.cjs      - MCP server (stdio, self-contained)
 *
 * Native deps are externalized and declared in plugin/package.json.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, chmodSync, statSync, mkdirSync, existsSync, cpSync, rmSync, readdirSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PLUGIN_DIR = join(ROOT, 'plugin');
const SCRIPTS_DIR = join(PLUGIN_DIR, 'scripts');

// Ensure output directory exists
if (!existsSync(SCRIPTS_DIR)) {
  mkdirSync(SCRIPTS_DIR, { recursive: true });
}

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

console.log(`Building claude-pg-mem plugin v${VERSION}...\n`);

// Dependencies that must stay external:
// - @huggingface/transformers: ~8MB, dynamically loads ONNX runtime at startup
// - onnxruntime-node: native .node addon loaded by transformers at runtime
const NATIVE_EXTERNALS = [
  '@huggingface/transformers',
  'onnxruntime-node',
];

// ── Build 1: Worker Service ──────────────────────────────────────────
console.log('Building worker-service.cjs...');
await build({
  entryPoints: [join(ROOT, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(SCRIPTS_DIR, 'worker-service.cjs'),
  minify: true,
  banner: {},
  external: NATIVE_EXTERNALS,
  define: {
    '__PLUGIN_VERSION__': JSON.stringify(VERSION),
  },
  mainFields: ['module', 'main'],
  conditions: ['import', 'node', 'default'],
});

const workerPath = join(SCRIPTS_DIR, 'worker-service.cjs');
const workerSize = statSync(workerPath).size;
chmodSync(workerPath, 0o755);
console.log(`  worker-service.cjs: ${(workerSize / 1024).toFixed(0)} KB`);

// ── Build 2: MCP Server ─────────────────────────────────────────────
console.log('Building mcp-server.cjs...');
await build({
  entryPoints: [join(ROOT, 'src/servers/mcp-server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(SCRIPTS_DIR, 'mcp-server.cjs'),
  minify: true,
  banner: {},
  external: [],
  define: {
    '__PLUGIN_VERSION__': JSON.stringify(VERSION),
  },
  mainFields: ['module', 'main'],
  conditions: ['import', 'node', 'default'],
});

const mcpSize = statSync(join(SCRIPTS_DIR, 'mcp-server.cjs')).size;
chmodSync(join(SCRIPTS_DIR, 'mcp-server.cjs'), 0o755);
console.log(`  mcp-server.cjs: ${(mcpSize / 1024).toFixed(0)} KB`);

// ── Build 3: Viewer Bundle ────────────────────────────────────────────
const UI_DIR = join(PLUGIN_DIR, 'ui');
const VIEWER_SRC = join(ROOT, 'src', 'ui');
const VIEWER_ENTRY = join(VIEWER_SRC, 'viewer', 'index.tsx');

if (existsSync(VIEWER_ENTRY)) {
  console.log('Building viewer-bundle.js...');

  if (!existsSync(UI_DIR)) {
    mkdirSync(UI_DIR, { recursive: true });
  }

  await build({
    entryPoints: [VIEWER_ENTRY],
    bundle: true,
    minify: true,
    sourcemap: false,
    target: ['es2020'],
    format: 'iife',
    outfile: join(UI_DIR, 'viewer-bundle.js'),
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css' },
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  const viewerSize = statSync(join(UI_DIR, 'viewer-bundle.js')).size;
  console.log(`  viewer-bundle.js: ${(viewerSize / 1024).toFixed(0)} KB`);

  // Copy viewer template HTML
  const viewerTemplatePath = join(VIEWER_SRC, 'viewer-template.html');
  if (existsSync(viewerTemplatePath)) {
    cpSync(viewerTemplatePath, join(UI_DIR, 'viewer.html'));
    console.log('  viewer.html: copied');
  }

  // Copy icon SVGs
  for (const svg of ['icon-thick-completed.svg', 'icon-thick-investigated.svg', 'icon-thick-learned.svg', 'icon-thick-next-steps.svg']) {
    const svgSrc = join(VIEWER_SRC, svg);
    if (existsSync(svgSrc)) {
      cpSync(svgSrc, join(UI_DIR, svg));
    }
  }
  console.log('  icons: copied');

  // Copy logo image
  const logoSrc = join(UI_DIR, 'claude-pg-mem-logomark.webp');
  if (!existsSync(logoSrc)) {
    // Try to copy from claude-mem if available
    const claudeMemLogo = '/tmp/claude-mem/plugin/ui/claude-mem-logomark.webp';
    if (existsSync(claudeMemLogo)) {
      cpSync(claudeMemLogo, join(UI_DIR, 'claude-pg-mem-logomark.webp'));
      console.log('  logo: copied from claude-mem');
    }
  }

  // Copy font files
  const fontsSrc = join(VIEWER_SRC, 'viewer', 'assets', 'fonts');
  const fontsDest = join(UI_DIR, 'assets', 'fonts');
  if (existsSync(fontsSrc)) {
    mkdirSync(fontsDest, { recursive: true });
    cpSync(fontsSrc, fontsDest, { recursive: true });
    console.log('  fonts: copied');
  }
} else {
  console.log('Skipping viewer build (src/ui/viewer/index.tsx not found)');
}

// Write build version to .install-version for cache invalidation
writeFileSync(join(PLUGIN_DIR, '.install-version'), VERSION + '\n');

// Auto-install: sync plugin to all install locations so worker daemon finds it
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const realPluginDir = realpathSync(PLUGIN_DIR);

function syncTo(targetDir, label) {
  try {
    // Skip if source and target are the same (e.g., running from ~/.claude-pg-mem/cli/)
    if (existsSync(targetDir) && realpathSync(targetDir) === realPluginDir) return;
  } catch { /* target doesn't exist yet, that's fine */ }
  mkdirSync(targetDir, { recursive: true });
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(PLUGIN_DIR, targetDir, { recursive: true });
  console.log(`Auto-installed to ${label}: ${targetDir}`);
}

// 0. CLI dist path (~/.claude-pg-mem/cli/dist/) — used by `claude-pg-mem` CLI commands
const cliDistSrc = join(ROOT, 'dist');
const cliDistDest = join(HOME, '.claude-pg-mem', 'cli', 'dist');
if (existsSync(cliDistSrc) && existsSync(cliDistDest) &&
    realpathSync(cliDistSrc) !== realpathSync(cliDistDest)) {
  cpSync(cliDistSrc, cliDistDest, { recursive: true });
  console.log(`Synced CLI dist → ${cliDistDest}`);
}

// 1. CLI plugin path (~/.claude-pg-mem/cli/plugin/) — used by `claude-pg-mem start`
syncTo(join(HOME, '.claude-pg-mem', 'cli', 'plugin'), 'CLI path');

// 2. CC plugin cache (~/.claude/plugins/cache/...) — used by Claude Code hooks
const cacheDir = join(HOME, '.claude', 'plugins', 'cache', 'DataToRag', 'claude-pg-mem');
if (existsSync(cacheDir)) {
  const versions = readdirSync(cacheDir).filter(f => !f.startsWith('.'));
  if (versions.length > 0) {
    syncTo(join(cacheDir, versions[0]), 'CC cache');
  }
}

console.log(`\nBuild complete! (${VERSION})`);
