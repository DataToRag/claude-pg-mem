/**
 * ContextConfigLoader - Loads and validates context configuration
 *
 * Handles loading settings from file with type/concept filtering.
 * Ported from claude-mem — simplified to remove ModeManager dependency.
 * Uses only settings-based filtering (code mode pattern).
 */

import path from 'path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import type { ContextConfig } from './types.js';

/**
 * Load all context configuration settings
 * Priority: ~/.claude-pg-mem/settings.json > env var > defaults
 */
export function loadContextConfig(): ContextConfig {
  const settingsPath = path.join(
    SettingsDefaultsManager.get('CLAUDE_PG_MEM_DATA_DIR'),
    'settings.json',
  );
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

  const observationTypes = new Set(
    settings.CLAUDE_PG_MEM_CONTEXT_OBSERVATION_TYPES
      .split(',')
      .map((t: string) => t.trim())
      .filter(Boolean),
  );
  const observationConcepts = new Set(
    settings.CLAUDE_PG_MEM_CONTEXT_OBSERVATION_CONCEPTS
      .split(',')
      .map((c: string) => c.trim())
      .filter(Boolean),
  );

  return {
    totalObservationCount: parseInt(settings.CLAUDE_PG_MEM_CONTEXT_OBSERVATIONS, 10),
    fullObservationCount: parseInt(settings.CLAUDE_PG_MEM_CONTEXT_FULL_COUNT, 10),
    sessionCount: parseInt(settings.CLAUDE_PG_MEM_CONTEXT_SESSION_COUNT, 10),
    showReadTokens: settings.CLAUDE_PG_MEM_CONTEXT_SHOW_READ_TOKENS === 'true',
    showWorkTokens: settings.CLAUDE_PG_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true',
    showSavingsAmount: settings.CLAUDE_PG_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true',
    showSavingsPercent: settings.CLAUDE_PG_MEM_CONTEXT_SHOW_SAVINGS_PERCENT === 'true',
    observationTypes,
    observationConcepts,
    fullObservationField: settings.CLAUDE_PG_MEM_CONTEXT_FULL_FIELD as 'narrative' | 'facts',
    showLastSummary: settings.CLAUDE_PG_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true',
    showLastMessage: settings.CLAUDE_PG_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true',
  };
}
