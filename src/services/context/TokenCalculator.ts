/**
 * TokenCalculator - Token budget calculations for context economics
 *
 * Handles estimation of token counts for observations and context economics.
 * Ported from claude-mem — removed ModeManager dependency.
 */

import type { Observation, TokenEconomics, ContextConfig } from './types.js';
import { CHARS_PER_TOKEN_ESTIMATE } from './types.js';

/**
 * Calculate token count for a single observation
 */
export function calculateObservationTokens(obs: Observation): number {
  const obsSize =
    (obs.title?.length || 0) +
    (obs.subtitle?.length || 0) +
    (obs.narrative?.length || 0) +
    JSON.stringify(obs.facts || []).length;
  return Math.ceil(obsSize / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Calculate context economics for a set of observations
 */
export function calculateTokenEconomics(observations: Observation[]): TokenEconomics {
  const totalObservations = observations.length;

  const totalReadTokens = observations.reduce((sum, obs) => {
    return sum + calculateObservationTokens(obs);
  }, 0);

  const totalDiscoveryTokens = observations.reduce((sum, obs) => {
    return sum + (obs.discovery_tokens || 0);
  }, 0);

  const savings = totalDiscoveryTokens - totalReadTokens;
  const savingsPercent =
    totalDiscoveryTokens > 0
      ? Math.round((savings / totalDiscoveryTokens) * 100)
      : 0;

  return {
    totalObservations,
    totalReadTokens,
    totalDiscoveryTokens,
    savings,
    savingsPercent,
  };
}

/**
 * Default type-to-emoji mapping for observation types
 */
const TYPE_ICONS: Record<string, string> = {
  bugfix: 'B',
  feature: 'F',
  refactor: 'R',
  discovery: 'D',
  decision: 'X',
  change: 'C',
};

const WORK_EMOJIS: Record<string, string> = {
  bugfix: 'W',
  feature: 'W',
  refactor: 'W',
  discovery: 'W',
  decision: 'W',
  change: 'W',
};

/**
 * Get type icon for an observation type
 */
export function getTypeIcon(obsType: string): string {
  return TYPE_ICONS[obsType] || obsType.charAt(0).toUpperCase();
}

/**
 * Get work emoji for an observation type
 */
export function getWorkEmoji(obsType: string): string {
  return WORK_EMOJIS[obsType] || 'W';
}

/**
 * Format token display for an observation
 */
export function formatObservationTokenDisplay(
  obs: Observation,
  config: ContextConfig,
): {
  readTokens: number;
  discoveryTokens: number;
  discoveryDisplay: string;
  workEmoji: string;
} {
  const readTokens = calculateObservationTokens(obs);
  const discoveryTokens = obs.discovery_tokens || 0;
  const workEmoji = getWorkEmoji(obs.type);
  const discoveryDisplay =
    discoveryTokens > 0 ? `${workEmoji} ${discoveryTokens.toLocaleString()}` : '-';

  return { readTokens, discoveryTokens, discoveryDisplay, workEmoji };
}

/**
 * Check if context economics should be shown
 */
export function shouldShowContextEconomics(config: ContextConfig): boolean {
  return (
    config.showReadTokens ||
    config.showWorkTokens ||
    config.showSavingsAmount ||
    config.showSavingsPercent
  );
}
