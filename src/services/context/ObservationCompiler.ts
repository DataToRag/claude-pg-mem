/**
 * ObservationCompiler - Query building and data retrieval for context
 *
 * Ported from claude-mem to use Drizzle ORM with Postgres.
 * Handles database queries for observations and summaries, plus transcript extraction.
 */

import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { sql, inArray, desc, and, eq } from 'drizzle-orm';
import type { Database } from '../postgres/client.js';
import { observations, sessionSummaries } from '../postgres/schema.js';
import { CLAUDE_CONFIG_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type {
  ContextConfig,
  Observation,
  SessionSummary,
  SummaryTimelineItem,
  TimelineItem,
  PriorMessages,
} from './types.js';
import { SUMMARY_LOOKAHEAD } from './types.js';

/**
 * Query observations from database with type and concept filtering.
 *
 * Uses Drizzle ORM for Postgres. Concept filtering uses JSON array containment
 * via a subquery on jsonb_array_elements_text.
 */
export async function queryObservations(
  db: Database,
  project: string,
  config: ContextConfig,
): Promise<Observation[]> {
  const typeArray = Array.from(config.observationTypes);
  const conceptArray = Array.from(config.observationConcepts);

  if (typeArray.length === 0 || conceptArray.length === 0) {
    return [];
  }

  // Build the concept overlap condition using Postgres JSON functions.
  // observations.concepts is a TEXT column storing a JSON array like '["how-it-works","pattern"]'.
  // We check if any element of that JSON array is in the concept filter list.
  const conceptPlaceholders = conceptArray.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const conceptCondition = sql`EXISTS (
    SELECT 1 FROM json_array_elements_text(${observations.concepts}::json) AS elem
    WHERE elem IN (${sql.raw(conceptPlaceholders)})
  )`;

  const rows = await db
    .select({
      id: observations.id,
      memory_session_id: observations.memory_session_id,
      type: observations.type,
      title: observations.title,
      subtitle: observations.subtitle,
      narrative: observations.narrative,
      facts: observations.facts,
      concepts: observations.concepts,
      files_read: observations.files_read,
      files_modified: observations.files_modified,
      discovery_tokens: observations.discovery_tokens,
      created_at: observations.created_at,
      created_at_epoch: observations.created_at_epoch,
    })
    .from(observations)
    .where(
      and(
        eq(observations.project, project),
        inArray(observations.type, typeArray),
        conceptCondition,
      ),
    )
    .orderBy(desc(observations.created_at_epoch))
    .limit(config.totalObservationCount);

  return rows as Observation[];
}

/**
 * Query recent session summaries from database
 */
export async function querySummaries(
  db: Database,
  project: string,
  config: ContextConfig,
): Promise<SessionSummary[]> {
  const rows = await db
    .select({
      id: sessionSummaries.id,
      memory_session_id: sessionSummaries.memory_session_id,
      request: sessionSummaries.request,
      investigated: sessionSummaries.investigated,
      learned: sessionSummaries.learned,
      completed: sessionSummaries.completed,
      next_steps: sessionSummaries.next_steps,
      created_at: sessionSummaries.created_at,
      created_at_epoch: sessionSummaries.created_at_epoch,
    })
    .from(sessionSummaries)
    .where(eq(sessionSummaries.project, project))
    .orderBy(desc(sessionSummaries.created_at_epoch))
    .limit(config.sessionCount + SUMMARY_LOOKAHEAD);

  return rows as SessionSummary[];
}

/**
 * Query observations from multiple projects (for worktree support)
 *
 * Returns observations from all specified projects, interleaved chronologically.
 * Used when running in a worktree to show both parent repo and worktree observations.
 */
export async function queryObservationsMulti(
  db: Database,
  projects: string[],
  config: ContextConfig,
): Promise<Observation[]> {
  const typeArray = Array.from(config.observationTypes);
  const conceptArray = Array.from(config.observationConcepts);

  if (typeArray.length === 0 || conceptArray.length === 0 || projects.length === 0) {
    return [];
  }

  const conceptPlaceholders = conceptArray.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const conceptCondition = sql`EXISTS (
    SELECT 1 FROM json_array_elements_text(${observations.concepts}::json) AS elem
    WHERE elem IN (${sql.raw(conceptPlaceholders)})
  )`;

  const rows = await db
    .select({
      id: observations.id,
      memory_session_id: observations.memory_session_id,
      type: observations.type,
      title: observations.title,
      subtitle: observations.subtitle,
      narrative: observations.narrative,
      facts: observations.facts,
      concepts: observations.concepts,
      files_read: observations.files_read,
      files_modified: observations.files_modified,
      discovery_tokens: observations.discovery_tokens,
      created_at: observations.created_at,
      created_at_epoch: observations.created_at_epoch,
      project: observations.project,
    })
    .from(observations)
    .where(
      and(
        inArray(observations.project, projects),
        inArray(observations.type, typeArray),
        conceptCondition,
      ),
    )
    .orderBy(desc(observations.created_at_epoch))
    .limit(config.totalObservationCount);

  return rows as Observation[];
}

/**
 * Query session summaries from multiple projects (for worktree support)
 */
export async function querySummariesMulti(
  db: Database,
  projects: string[],
  config: ContextConfig,
): Promise<SessionSummary[]> {
  if (projects.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: sessionSummaries.id,
      memory_session_id: sessionSummaries.memory_session_id,
      request: sessionSummaries.request,
      investigated: sessionSummaries.investigated,
      learned: sessionSummaries.learned,
      completed: sessionSummaries.completed,
      next_steps: sessionSummaries.next_steps,
      created_at: sessionSummaries.created_at,
      created_at_epoch: sessionSummaries.created_at_epoch,
      project: sessionSummaries.project,
    })
    .from(sessionSummaries)
    .where(inArray(sessionSummaries.project, projects))
    .orderBy(desc(sessionSummaries.created_at_epoch))
    .limit(config.sessionCount + SUMMARY_LOOKAHEAD);

  return rows as SessionSummary[];
}

/**
 * Convert cwd path to dashed format for transcript lookup
 */
function cwdToDashed(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Extract prior messages from transcript file
 */
export function extractPriorMessages(transcriptPath: string): PriorMessages {
  try {
    if (!existsSync(transcriptPath)) {
      return { userMessage: '', assistantMessage: '' };
    }

    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      return { userMessage: '', assistantMessage: '' };
    }

    const lines = content.split('\n').filter(line => line.trim());
    let lastAssistantMessage = '';

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = lines[i];
        if (!line.includes('"type":"assistant"')) {
          continue;
        }

        const entry = JSON.parse(line);
        if (
          entry.type === 'assistant' &&
          entry.message?.content &&
          Array.isArray(entry.message.content)
        ) {
          let text = '';
          for (const block of entry.message.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }
          text = text
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
            .trim();
          if (text) {
            lastAssistantMessage = text;
            break;
          }
        }
      } catch (parseError) {
        logger.debug(
          'PARSER',
          'Skipping malformed transcript line',
          { lineIndex: i },
          parseError as Error,
        );
        continue;
      }
    }

    return { userMessage: '', assistantMessage: lastAssistantMessage };
  } catch (error) {
    logger.error(
      'WORKER',
      `Failed to extract prior messages from transcript`,
      { transcriptPath },
      error as Error,
    );
    return { userMessage: '', assistantMessage: '' };
  }
}

/**
 * Get prior session messages if enabled
 */
export function getPriorSessionMessages(
  observations: Observation[],
  config: ContextConfig,
  currentSessionId: string | undefined,
  cwd: string,
): PriorMessages {
  if (!config.showLastMessage || observations.length === 0) {
    return { userMessage: '', assistantMessage: '' };
  }

  const priorSessionObs = observations.find(
    obs => obs.memory_session_id !== currentSessionId,
  );
  if (!priorSessionObs) {
    return { userMessage: '', assistantMessage: '' };
  }

  const priorSessionId = priorSessionObs.memory_session_id;
  const dashedCwd = cwdToDashed(cwd);
  // Use CLAUDE_CONFIG_DIR to support custom Claude config directories
  const transcriptPath = path.join(
    CLAUDE_CONFIG_DIR,
    'projects',
    dashedCwd,
    `${priorSessionId}.jsonl`,
  );
  return extractPriorMessages(transcriptPath);
}

/**
 * Prepare summaries for timeline display
 */
export function prepareSummariesForTimeline(
  displaySummaries: SessionSummary[],
  allSummaries: SessionSummary[],
): SummaryTimelineItem[] {
  const mostRecentSummaryId = allSummaries[0]?.id;

  return displaySummaries.map((summary, i) => {
    const olderSummary = i === 0 ? null : allSummaries[i + 1];
    return {
      ...summary,
      displayEpoch: olderSummary
        ? olderSummary.created_at_epoch
        : summary.created_at_epoch,
      displayTime: olderSummary
        ? olderSummary.created_at
        : summary.created_at,
      shouldShowLink: summary.id !== mostRecentSummaryId,
    };
  });
}

/**
 * Build unified timeline from observations and summaries
 */
export function buildTimeline(
  observations: Observation[],
  summaries: SummaryTimelineItem[],
): TimelineItem[] {
  const timeline: TimelineItem[] = [
    ...observations.map(obs => ({ type: 'observation' as const, data: obs })),
    ...summaries.map(summary => ({ type: 'summary' as const, data: summary })),
  ];

  // Sort chronologically
  timeline.sort((a, b) => {
    const aEpoch =
      a.type === 'observation' ? a.data.created_at_epoch : a.data.displayEpoch;
    const bEpoch =
      b.type === 'observation' ? b.data.created_at_epoch : b.data.displayEpoch;
    return aEpoch - bEpoch;
  });

  return timeline;
}

/**
 * Get set of observation IDs that should show full details
 */
export function getFullObservationIds(
  observations: Observation[],
  count: number,
): Set<number> {
  return new Set(observations.slice(0, count).map(obs => obs.id));
}
