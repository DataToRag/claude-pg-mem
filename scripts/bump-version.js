#!/usr/bin/env node
/**
 * Sync version across all package/plugin JSON files.
 *
 * Called by semantic-release via @semantic-release/exec during the prepare step.
 * Usage: node scripts/bump-version.js <version>
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/bump-version.js <version>');
  process.exit(1);
}

const FILES = [
  'package.json',
  join('plugin', '.claude-plugin', 'plugin.json'),
  join('plugin', 'package.json'),
];

for (const file of FILES) {
  const filepath = join(ROOT, file);
  const json = JSON.parse(readFileSync(filepath, 'utf-8'));
  json.version = version;
  writeFileSync(filepath, JSON.stringify(json, null, 2) + '\n');
  console.log(`  ${file}: ${version}`);
}

console.log(`\nVersion bumped to ${version}`);
