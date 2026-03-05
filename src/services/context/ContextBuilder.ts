/**
 * ContextBuilder - Main orchestrator for context generation
 *
 * Coordinates all context generation components to build the final output.
 * This is the primary entry point for context generation.
 *
 * Ported from claude-mem to use Drizzle ORM with Postgres (Neon).
 * The database connection is obtained from the shared client module.
 */

import { logger } from '../../utils/logger.js';
import { getCurrentProjectName } from '../../shared/paths.js';
import { getDb } from '../postgres/client.js';

import type { ContextInput, ContextConfig, Observation, SessionSummary } from './types.js';
import { loadContextConfig } from './ContextConfigLoader.js';
import { calculateTokenEconomics } from './TokenCalculator.js';
import {
  queryObservations,
  queryObservationsMulti,
  querySummaries,
  querySummariesMulti,
  getPriorSessionMessages,
  prepareSummariesForTimeline,
  buildTimeline,
  getFullObservationIds,
} from './ObservationCompiler.js';
import { renderHeader } from './sections/HeaderRenderer.js';
import { renderTimeline } from './sections/TimelineRenderer.js';
import { shouldShowSummary, renderSummaryFields } from './sections/SummaryRenderer.js';
import { renderPreviouslySection, renderFooter } from './sections/FooterRenderer.js';
import { renderMarkdownEmptyState } from './formatters/MarkdownFormatter.js';
import { renderColorEmptyState } from './formatters/ColorFormatter.js';

/**
 * Render empty state when no data exists
 */
function renderEmptyState(project: string, useColors: boolean): string {
  return useColors
    ? renderColorEmptyState(project)
    : renderMarkdownEmptyState(project);
}

/**
 * Build context output from loaded data
 */
function buildContextOutput(
  project: string,
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  cwd: string,
  sessionId: string | undefined,
  useColors: boolean,
): string {
  const output: string[] = [];

  // Calculate token economics
  const economics = calculateTokenEconomics(observations);

  // Render header section
  output.push(...renderHeader(project, economics, config, useColors));

  // Prepare timeline data
  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(
    displaySummaries,
    summaries,
  );
  const timeline = buildTimeline(observations, summariesForTimeline);
  const fullObservationIds = getFullObservationIds(
    observations,
    config.fullObservationCount,
  );

  // Render timeline
  output.push(
    ...renderTimeline(timeline, fullObservationIds, config, cwd, useColors),
  );

  // Render most recent summary if applicable
  const mostRecentSummary = summaries[0];
  const mostRecentObservation = observations[0];

  if (shouldShowSummary(config, mostRecentSummary, mostRecentObservation)) {
    output.push(...renderSummaryFields(mostRecentSummary, useColors));
  }

  // Render previously section (prior assistant message)
  const priorMessages = getPriorSessionMessages(
    observations,
    config,
    sessionId,
    cwd,
  );
  output.push(...renderPreviouslySection(priorMessages, useColors));

  // Render footer
  output.push(...renderFooter(economics, config, useColors));

  return output.join('\n').trimEnd();
}

/**
 * Generate context for a project
 *
 * Main entry point for context generation. Orchestrates loading config,
 * querying data, and rendering the final context string.
 */
export async function generateContext(
  input?: ContextInput,
  useColors: boolean = false,
): Promise<string> {
  const config = loadContextConfig();
  const cwd = input?.cwd ?? process.cwd();

  // Use provided projects array (from hook's getProjectContext) or fall back to worker's cwd.
  // The hook passes the correct project name based on the user's actual working directory,
  // not the worker's cwd (which is always the claude-pg-mem repo).
  const fallbackProject = getCurrentProjectName();
  const projects = input?.projects || [fallbackProject];
  const project = projects[0];

  try {
    const db = getDb();

    // Query data for all projects (supports worktree: parent + worktree combined)
    const observations =
      projects.length > 1
        ? await queryObservationsMulti(db, projects, config)
        : await queryObservations(db, project, config);
    const summaries =
      projects.length > 1
        ? await querySummariesMulti(db, projects, config)
        : await querySummaries(db, project, config);

    // Handle empty state
    if (observations.length === 0 && summaries.length === 0) {
      return renderEmptyState(project, useColors);
    }

    // Build and return context
    return buildContextOutput(
      project,
      observations,
      summaries,
      config,
      cwd,
      input?.session_id,
      useColors,
    );
  } catch (error) {
    logger.error(
      'SYSTEM',
      'Context generation failed',
      {},
      error as Error,
    );
    // Return empty state on any DB error
    return renderEmptyState(project, useColors);
  }
}
