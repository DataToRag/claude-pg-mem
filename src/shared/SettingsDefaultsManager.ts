/**
 * SettingsDefaultsManager
 *
 * Single source of truth for all default configuration values.
 * Provides methods to get defaults with optional environment variable overrides.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { DEFAULT_OBSERVATION_TYPES_STRING, DEFAULT_OBSERVATION_CONCEPTS_STRING } from '../constants/observation-metadata.js';
// NOTE: Do NOT import logger here - it creates a circular dependency
// logger.ts depends on SettingsDefaultsManager for its initialization

export interface SettingsDefaults {
  CLAUDE_PG_MEM_MODEL: string;
  CLAUDE_PG_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_PG_MEM_WORKER_PORT: string;
  CLAUDE_PG_MEM_WORKER_HOST: string;
  CLAUDE_PG_MEM_SKIP_TOOLS: string;
  // AI Provider Configuration
  CLAUDE_PG_MEM_PROVIDER: string;  // 'claude' | 'gemini' | 'openrouter'
  CLAUDE_PG_MEM_CLAUDE_AUTH_METHOD: string;  // 'cli' | 'api' - how Claude provider authenticates
  CLAUDE_PG_MEM_GEMINI_API_KEY: string;
  CLAUDE_PG_MEM_GEMINI_MODEL: string;
  CLAUDE_PG_MEM_GEMINI_RATE_LIMITING_ENABLED: string;
  CLAUDE_PG_MEM_OPENROUTER_API_KEY: string;
  CLAUDE_PG_MEM_OPENROUTER_MODEL: string;
  CLAUDE_PG_MEM_OPENROUTER_SITE_URL: string;
  CLAUDE_PG_MEM_OPENROUTER_APP_NAME: string;
  CLAUDE_PG_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: string;
  CLAUDE_PG_MEM_OPENROUTER_MAX_TOKENS: string;
  // System Configuration
  CLAUDE_PG_MEM_DATA_DIR: string;
  CLAUDE_PG_MEM_LOG_LEVEL: string;
  CLAUDE_CODE_PATH: string;
  CLAUDE_PG_MEM_MODE: string;
  // Token Economics
  CLAUDE_PG_MEM_CONTEXT_SHOW_READ_TOKENS: string;
  CLAUDE_PG_MEM_CONTEXT_SHOW_WORK_TOKENS: string;
  CLAUDE_PG_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: string;
  CLAUDE_PG_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: string;
  // Observation Filtering
  CLAUDE_PG_MEM_CONTEXT_OBSERVATION_TYPES: string;
  CLAUDE_PG_MEM_CONTEXT_OBSERVATION_CONCEPTS: string;
  // Display Configuration
  CLAUDE_PG_MEM_CONTEXT_FULL_COUNT: string;
  CLAUDE_PG_MEM_CONTEXT_FULL_FIELD: string;
  CLAUDE_PG_MEM_CONTEXT_SESSION_COUNT: string;
  // Feature Toggles
  CLAUDE_PG_MEM_CONTEXT_SHOW_LAST_SUMMARY: string;
  CLAUDE_PG_MEM_CONTEXT_SHOW_LAST_MESSAGE: string;
  CLAUDE_PG_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: string;
  CLAUDE_PG_MEM_FOLDER_CLAUDEMD_ENABLED: string;
  // Process Management
  CLAUDE_PG_MEM_MAX_CONCURRENT_AGENTS: string;
  // Exclusion Settings
  CLAUDE_PG_MEM_EXCLUDED_PROJECTS: string;
  CLAUDE_PG_MEM_FOLDER_MD_EXCLUDE: string;
  // Postgres Configuration
  CLAUDE_PG_MEM_DATABASE_URL: string;
}

export class SettingsDefaultsManager {
  /**
   * Default values for all settings
   */
  private static readonly DEFAULTS: SettingsDefaults = {
    CLAUDE_PG_MEM_MODEL: 'claude-sonnet-4-5',
    CLAUDE_PG_MEM_CONTEXT_OBSERVATIONS: '50',
    CLAUDE_PG_MEM_WORKER_PORT: '37778',
    CLAUDE_PG_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_PG_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
    // AI Provider Configuration
    CLAUDE_PG_MEM_PROVIDER: 'claude',
    CLAUDE_PG_MEM_CLAUDE_AUTH_METHOD: 'cli',
    CLAUDE_PG_MEM_GEMINI_API_KEY: '',
    CLAUDE_PG_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
    CLAUDE_PG_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',
    CLAUDE_PG_MEM_OPENROUTER_API_KEY: '',
    CLAUDE_PG_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
    CLAUDE_PG_MEM_OPENROUTER_SITE_URL: '',
    CLAUDE_PG_MEM_OPENROUTER_APP_NAME: 'claude-pg-mem',
    CLAUDE_PG_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '20',
    CLAUDE_PG_MEM_OPENROUTER_MAX_TOKENS: '100000',
    // System Configuration
    CLAUDE_PG_MEM_DATA_DIR: join(homedir(), '.claude-pg-mem'),
    CLAUDE_PG_MEM_LOG_LEVEL: 'INFO',
    CLAUDE_CODE_PATH: '',
    CLAUDE_PG_MEM_MODE: 'code',
    // Token Economics
    CLAUDE_PG_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
    CLAUDE_PG_MEM_CONTEXT_SHOW_WORK_TOKENS: 'false',
    CLAUDE_PG_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
    CLAUDE_PG_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
    // Observation Filtering
    CLAUDE_PG_MEM_CONTEXT_OBSERVATION_TYPES: DEFAULT_OBSERVATION_TYPES_STRING,
    CLAUDE_PG_MEM_CONTEXT_OBSERVATION_CONCEPTS: DEFAULT_OBSERVATION_CONCEPTS_STRING,
    // Display Configuration
    CLAUDE_PG_MEM_CONTEXT_FULL_COUNT: '0',
    CLAUDE_PG_MEM_CONTEXT_FULL_FIELD: 'narrative',
    CLAUDE_PG_MEM_CONTEXT_SESSION_COUNT: '10',
    // Feature Toggles
    CLAUDE_PG_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
    CLAUDE_PG_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
    CLAUDE_PG_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
    CLAUDE_PG_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    // Process Management
    CLAUDE_PG_MEM_MAX_CONCURRENT_AGENTS: '2',
    // Exclusion Settings
    CLAUDE_PG_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_PG_MEM_FOLDER_MD_EXCLUDE: '[]',
    // Postgres Configuration
    CLAUDE_PG_MEM_DATABASE_URL: '',
  };

  /**
   * Get all defaults as an object
   */
  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  /**
   * Get a default value from defaults (no environment variable override)
   */
  static get(key: keyof SettingsDefaults): string {
    return this.DEFAULTS[key];
  }

  /**
   * Get an integer default value
   */
  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  /**
   * Get a boolean default value
   * Handles both string 'true' and boolean true from JSON
   */
  static getBool(key: keyof SettingsDefaults): boolean {
    const value = this.get(key);
    return value === 'true' || (value as unknown) === true;
  }

  /**
   * Apply environment variable overrides to settings
   * Environment variables take highest priority over file and defaults
   */
  private static applyEnvOverrides(settings: SettingsDefaults): SettingsDefaults {
    const result = { ...settings };
    for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
    return result;
  }

  /**
   * Load settings from file with fallback to defaults
   * Returns merged settings with proper priority: process.env > settings file > defaults
   * Handles all errors (missing file, corrupted JSON, permissions) gracefully
   *
   * Configuration Priority:
   *   1. Environment variables (highest priority)
   *   2. Settings file (~/.claude-pg-mem/settings.json)
   *   3. Default values (lowest priority)
   */
  static loadFromFile(settingsPath: string): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
          // Use console instead of logger to avoid circular dependency
          console.log('[SETTINGS] Created settings file with defaults:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to create settings file, using in-memory defaults:', settingsPath, error);
        }
        // Still apply env var overrides even when file doesn't exist
        return this.applyEnvOverrides(defaults);
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);

      // MIGRATION: Handle old nested schema { env: {...} }
      let flatSettings = settings;
      if (settings.env && typeof settings.env === 'object') {
        // Migrate from nested to flat schema
        flatSettings = settings.env;

        // Auto-migrate the file to flat schema
        try {
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), 'utf-8');
          console.log('[SETTINGS] Migrated settings file from nested to flat schema:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to auto-migrate settings file:', settingsPath, error);
          // Continue with in-memory migration even if write fails
        }
      }

      // Merge file settings with defaults (flat schema)
      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      // Apply environment variable overrides (highest priority)
      return this.applyEnvOverrides(result);
    } catch (error) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', settingsPath, error);
      // Still apply env var overrides even on error
      return this.applyEnvOverrides(this.getAllDefaults());
    }
  }
}
