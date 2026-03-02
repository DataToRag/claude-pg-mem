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
import { readFileSync, chmodSync, statSync, mkdirSync, existsSync } from 'fs';
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

// Native dependencies that cannot be bundled (contain .node binaries)
const NATIVE_EXTERNALS = [
  '@huggingface/transformers',
  'onnxruntime-node',
  'onnxruntime-web',
  'sharp',
  '@anthropic-ai/claude-agent-sdk',
  'fsevents',
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
  banner: { js: '#!/usr/bin/env node' },
  external: NATIVE_EXTERNALS,
  define: {
    '__PLUGIN_VERSION__': JSON.stringify(VERSION),
  },
  mainFields: ['module', 'main'],
  conditions: ['import', 'node', 'default'],
});

const workerSize = statSync(join(SCRIPTS_DIR, 'worker-service.cjs')).size;
chmodSync(join(SCRIPTS_DIR, 'worker-service.cjs'), 0o755);
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
  banner: { js: '#!/usr/bin/env node' },
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

console.log('\nBuild complete!');
