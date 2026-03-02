#!/usr/bin/env node
/**
 * Worker service control script for plugin hooks.
 *
 * This script bridges the hooks.json command format to the main CLI.
 * Claude Code spawns this script with JSON on stdin and expects JSON on stdout.
 *
 * Usage from hooks.json:
 *   node plugin/scripts/worker-service.js hook claude-code context
 *   node plugin/scripts/worker-service.js hook claude-code observation
 *   node plugin/scripts/worker-service.js start
 *
 * The script delegates to the compiled dist/index.js entry point, which handles
 * reading stdin, processing the hook, and writing stdout.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const args = process.argv.slice(2);

// Find the package root (two levels up from plugin/scripts/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..', '..');
const entryPoint = join(packageRoot, 'dist', 'index.js');

// Spawn the main entry point, piping stdin/stdout/stderr through
const child = spawn(process.execPath, [entryPoint, ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', () => {
  // If the compiled entry point fails, try npx as fallback
  const fallback = spawn('npx', ['claude-pg-memory', ...args], {
    stdio: 'inherit',
    env: process.env,
  });

  fallback.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  fallback.on('error', () => {
    // Silent failure - hooks should not block Claude Code
    process.exit(0);
  });
});
