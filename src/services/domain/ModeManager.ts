/**
 * ModeManager - Loads and manages mode configurations
 *
 * Mode configs define observation types, concepts, and prompts for different
 * usage patterns (e.g., 'code' for software development).
 *
 * Mode configuration files are loaded from:
 *   1. plugin/modes/<name>.json (bundled defaults)
 *   2. ~/.claude-pg-memory/modes/<name>.json (user overrides)
 *
 * The active mode is determined by CLAUDE_PG_MEMORY_MODE setting (default: 'code').
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import { MODES_DIR } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import type { ModeConfig, ObservationType } from './types.js';

// Resolve paths for bundled mode configs
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Find the bundled modes directory.
 *
 * In development (src/services/domain/), this is ../../../plugin/modes/
 * In production (dist/services/domain/), this is ../../../plugin/modes/
 * Both resolve the same relative to the package root.
 */
function getBundledModesDir(): string {
  // Walk up from src/services/domain or dist/services/domain to package root
  const packageRoot = join(__dirname, '..', '..', '..');
  return join(packageRoot, 'plugin', 'modes');
}

/**
 * Cache for loaded mode configs to avoid repeated file reads.
 */
const modeCache = new Map<string, ModeConfig>();

/**
 * Load a mode configuration by name.
 *
 * Lookup order:
 *   1. User override: ~/.claude-pg-memory/modes/<name>.json
 *   2. Bundled default: plugin/modes/<name>.json
 *
 * @param name - Mode name (e.g., 'code')
 * @returns ModeConfig object
 * @throws Error if mode config cannot be found or parsed
 */
export function loadMode(name: string): ModeConfig {
  // Check cache first
  const cached = modeCache.get(name);
  if (cached) {
    return cached;
  }

  const fileName = `${name}.json`;

  // 1. Check user override directory
  const userPath = join(MODES_DIR, fileName);
  if (existsSync(userPath)) {
    try {
      const content = readFileSync(userPath, 'utf-8');
      const config = JSON.parse(content) as ModeConfig;
      validateModeConfig(config, userPath);
      modeCache.set(name, config);
      logger.debug('SYSTEM', `Loaded mode from user directory: ${name}`, { path: userPath });
      return config;
    } catch (error) {
      logger.warn('SYSTEM', `Failed to load user mode ${name}, falling back to bundled`, {
        path: userPath,
      }, error as Error);
    }
  }

  // 2. Check bundled modes directory
  const bundledDir = getBundledModesDir();
  const bundledPath = join(bundledDir, fileName);
  if (existsSync(bundledPath)) {
    try {
      const content = readFileSync(bundledPath, 'utf-8');
      const config = JSON.parse(content) as ModeConfig;
      validateModeConfig(config, bundledPath);
      modeCache.set(name, config);
      logger.debug('SYSTEM', `Loaded mode from bundled directory: ${name}`, { path: bundledPath });
      return config;
    } catch (error) {
      throw new Error(
        `Failed to parse bundled mode config ${bundledPath}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  throw new Error(
    `Mode '${name}' not found. Searched: ${userPath}, ${bundledPath}`,
  );
}

/**
 * Get the currently active mode name from settings.
 * Defaults to 'code' if not configured.
 */
export function getActiveModeName(): string {
  const settingsPath = join(
    SettingsDefaultsManager.get('CLAUDE_PG_MEMORY_DATA_DIR'),
    'settings.json',
  );
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_PG_MEMORY_MODE || 'code';
}

/**
 * Load the active mode configuration.
 * Convenience function that combines getActiveModeName() and loadMode().
 */
export function getActiveMode(): ModeConfig {
  const name = getActiveModeName();
  return loadMode(name);
}

/**
 * Get valid observation type IDs for the active mode.
 */
export function getValidTypes(): string[] {
  const mode = getActiveMode();
  return mode.observation_types.map((t: ObservationType) => t.id);
}

/**
 * Clear the mode cache. Useful when settings change.
 */
export function clearModeCache(): void {
  modeCache.clear();
}

/**
 * Validate that a mode config has the required fields.
 */
function validateModeConfig(config: ModeConfig, source: string): void {
  if (!config.name) {
    throw new Error(`Mode config missing 'name' field: ${source}`);
  }
  if (!Array.isArray(config.observation_types)) {
    throw new Error(`Mode config missing 'observation_types' array: ${source}`);
  }
  if (config.observation_types.length === 0) {
    throw new Error(`Mode config has empty 'observation_types': ${source}`);
  }
  if (!config.prompts) {
    throw new Error(`Mode config missing 'prompts' object: ${source}`);
  }
  // Validate each observation type has required fields
  for (const type of config.observation_types) {
    if (!type.id || !type.label) {
      throw new Error(
        `Observation type missing 'id' or 'label' in ${source}: ${JSON.stringify(type)}`,
      );
    }
  }
}
