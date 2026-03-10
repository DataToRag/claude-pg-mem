/**
 * Timeline module — time-based context queries for observations, sessions, and prompts.
 *
 * Ported from claude-mem's SQLite Timeline.ts / timeline/queries.ts.
 * Each function takes a `db` (Drizzle instance) as its first argument.
 */

import { eq, and, gte, lte, desc, asc, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  observations,
  sessionSummaries,
  userPrompts,
  sdkSessions,
} from './schema.js';
import type { ObservationRow, SessionSummaryRow, UserPromptRow } from './types.js';

// ---------------------------------------------------------------------------
// Column selections — exclude embedding and search_vector from results
// ---------------------------------------------------------------------------

const observationColumns = {
  id: observations.id,
  memory_session_id: observations.memory_session_id,
  project: observations.project,
  text: observations.text,
  type: observations.type,
  title: observations.title,
  subtitle: observations.subtitle,
  facts: observations.facts,
  narrative: observations.narrative,
  concepts: observations.concepts,
  files_read: observations.files_read,
  files_modified: observations.files_modified,
  prompt_number: observations.prompt_number,
  discovery_tokens: observations.discovery_tokens,
  content_hash: observations.content_hash,
  created_at: observations.created_at,
  created_at_epoch: observations.created_at_epoch,
};

const sessionSummaryColumns = {
  id: sessionSummaries.id,
  memory_session_id: sessionSummaries.memory_session_id,
  project: sessionSummaries.project,
  request: sessionSummaries.request,
  investigated: sessionSummaries.investigated,
  learned: sessionSummaries.learned,
  completed: sessionSummaries.completed,
  next_steps: sessionSummaries.next_steps,
  files_read: sessionSummaries.files_read,
  files_edited: sessionSummaries.files_edited,
  notes: sessionSummaries.notes,
  prompt_number: sessionSummaries.prompt_number,
  discovery_tokens: sessionSummaries.discovery_tokens,
  created_at: sessionSummaries.created_at,
  created_at_epoch: sessionSummaries.created_at_epoch,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimelineResult {
  observations: ObservationRow[];
  sessions: Array<{
    id: number;
    memory_session_id: string;
    project: string;
    request: string | null;
    completed: string | null;
    next_steps: string | null;
    created_at: string;
    created_at_epoch: number;
  }>;
  prompts: Array<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string | null;
    created_at: string;
    created_at_epoch: number;
  }>;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get timeline around a specific observation ID.
 *
 * Uses the observation's created_at_epoch as the anchor, then fetches all
 * record types (observations, session summaries, user prompts) within the
 * time window determined by `before` and `after` counts.
 *
 * @param db          Drizzle database instance
 * @param observationId  Observation ID to anchor around
 * @param before      Number of observations to include before the anchor (default 10)
 * @param after       Number of observations to include after the anchor (default 10)
 * @param project     Optional project filter
 */
export async function getTimeline(
  db: Database,
  observationId: number,
  before: number = 10,
  after: number = 10,
  project?: string,
): Promise<TimelineResult> {
  // Step 1: Get the anchor observation's timestamp
  const anchorRows = await db
    .select({ created_at_epoch: observations.created_at_epoch })
    .from(observations)
    .where(eq(observations.id, observationId))
    .limit(1);

  if (anchorRows.length === 0) {
    return { observations: [], sessions: [], prompts: [] };
  }
  const anchorEpoch = anchorRows[0].created_at_epoch;

  return getTimelineAroundEpoch(db, anchorEpoch, before, after, project);
}

/**
 * Get project timeline — recent observations, summaries, and prompts for a project.
 *
 * Returns items ordered chronologically (oldest first).
 */
export async function getProjectTimeline(
  db: Database,
  project: string,
  limit: number = 50,
): Promise<TimelineResult> {
  // Get observations
  const obs = await db
    .select(observationColumns)
    .from(observations)
    .where(eq(observations.project, project))
    .orderBy(desc(observations.created_at_epoch))
    .limit(limit);

  // Get summaries
  const sums = await db
    .select(sessionSummaryColumns)
    .from(sessionSummaries)
    .where(eq(sessionSummaries.project, project))
    .orderBy(desc(sessionSummaries.created_at_epoch))
    .limit(limit);

  // Get prompts with project join
  const proms = await db
    .select({
      id: userPrompts.id,
      content_session_id: userPrompts.content_session_id,
      prompt_number: userPrompts.prompt_number,
      prompt_text: userPrompts.prompt_text,
      project: sdkSessions.project,
      created_at: userPrompts.created_at,
      created_at_epoch: userPrompts.created_at_epoch,
    })
    .from(userPrompts)
    .innerJoin(sdkSessions, eq(userPrompts.content_session_id, sdkSessions.content_session_id))
    .where(eq(sdkSessions.project, project))
    .orderBy(desc(userPrompts.created_at_epoch))
    .limit(limit);

  // Reverse to oldest-first for chronological order
  return {
    observations: (obs as ObservationRow[]).reverse(),
    sessions: (sums as SessionSummaryRow[])
      .reverse()
      .map((s) => ({
        id: s.id,
        memory_session_id: s.memory_session_id,
        project: s.project,
        request: s.request,
        completed: s.completed,
        next_steps: s.next_steps,
        created_at: s.created_at,
        created_at_epoch: s.created_at_epoch,
      })),
    prompts: proms.reverse().map((p) => ({
      id: p.id,
      content_session_id: p.content_session_id,
      prompt_number: p.prompt_number,
      prompt_text: p.prompt_text,
      project: p.project,
      created_at: p.created_at,
      created_at_epoch: p.created_at_epoch,
    })),
  };
}

/**
 * Get all unique projects.
 */
export async function getAllProjects(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ project: sdkSessions.project })
    .from(sdkSessions)
    .where(
      and(
        sql`${sdkSessions.project} IS NOT NULL`,
        sql`${sdkSessions.project} != ''`,
      ),
    )
    .orderBy(asc(sdkSessions.project));

  return rows.map((r) => r.project);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getTimelineAroundEpoch(
  db: Database,
  anchorEpoch: number,
  depthBefore: number,
  depthAfter: number,
  project?: string,
): Promise<TimelineResult> {
  // Find time boundaries by looking at observation timestamps
  const projectFilter = project ? eq(observations.project, project) : undefined;

  // Before boundary
  const beforeRows = await db
    .select({ created_at_epoch: observations.created_at_epoch })
    .from(observations)
    .where(
      projectFilter
        ? and(lte(observations.created_at_epoch, anchorEpoch), projectFilter)
        : lte(observations.created_at_epoch, anchorEpoch),
    )
    .orderBy(desc(observations.created_at_epoch))
    .limit(depthBefore);

  // After boundary
  const afterRows = await db
    .select({ created_at_epoch: observations.created_at_epoch })
    .from(observations)
    .where(
      projectFilter
        ? and(gte(observations.created_at_epoch, anchorEpoch), projectFilter)
        : gte(observations.created_at_epoch, anchorEpoch),
    )
    .orderBy(asc(observations.created_at_epoch))
    .limit(depthAfter + 1);

  if (beforeRows.length === 0 && afterRows.length === 0) {
    return { observations: [], sessions: [], prompts: [] };
  }

  const startEpoch =
    beforeRows.length > 0
      ? beforeRows[beforeRows.length - 1].created_at_epoch
      : anchorEpoch;
  const endEpoch =
    afterRows.length > 0
      ? afterRows[afterRows.length - 1].created_at_epoch
      : anchorEpoch;

  // Fetch all record types within the time window
  const timeWindow = and(
    gte(observations.created_at_epoch, startEpoch),
    lte(observations.created_at_epoch, endEpoch),
  );
  const obsWhere = projectFilter
    ? and(timeWindow, projectFilter)
    : timeWindow;

  const obs = await db
    .select(observationColumns)
    .from(observations)
    .where(obsWhere)
    .orderBy(asc(observations.created_at_epoch));

  const summaryProjectFilter = project
    ? eq(sessionSummaries.project, project)
    : undefined;
  const summaryTimeWindow = and(
    gte(sessionSummaries.created_at_epoch, startEpoch),
    lte(sessionSummaries.created_at_epoch, endEpoch),
  );
  const sumWhere = summaryProjectFilter
    ? and(summaryTimeWindow, summaryProjectFilter)
    : summaryTimeWindow;

  const sums = await db
    .select(sessionSummaryColumns)
    .from(sessionSummaries)
    .where(sumWhere)
    .orderBy(asc(sessionSummaries.created_at_epoch));

  const promptProjectFilter = project
    ? eq(sdkSessions.project, project)
    : undefined;

  let promptsQuery = db
    .select({
      id: userPrompts.id,
      content_session_id: userPrompts.content_session_id,
      prompt_number: userPrompts.prompt_number,
      prompt_text: userPrompts.prompt_text,
      project: sdkSessions.project,
      created_at: userPrompts.created_at,
      created_at_epoch: userPrompts.created_at_epoch,
    })
    .from(userPrompts)
    .innerJoin(sdkSessions, eq(userPrompts.content_session_id, sdkSessions.content_session_id))
    .where(
      promptProjectFilter
        ? and(
            gte(userPrompts.created_at_epoch, startEpoch),
            lte(userPrompts.created_at_epoch, endEpoch),
            promptProjectFilter,
          )
        : and(
            gte(userPrompts.created_at_epoch, startEpoch),
            lte(userPrompts.created_at_epoch, endEpoch),
          ),
    )
    .orderBy(asc(userPrompts.created_at_epoch));

  const proms = await promptsQuery;

  return {
    observations: obs as ObservationRow[],
    sessions: (sums as SessionSummaryRow[]).map((s) => ({
      id: s.id,
      memory_session_id: s.memory_session_id,
      project: s.project,
      request: s.request,
      completed: s.completed,
      next_steps: s.next_steps,
      created_at: s.created_at,
      created_at_epoch: s.created_at_epoch,
    })),
    prompts: proms.map((p) => ({
      id: p.id,
      content_session_id: p.content_session_id,
      prompt_number: p.prompt_number,
      prompt_text: p.prompt_text,
      project: p.project,
      created_at: p.created_at,
      created_at_epoch: p.created_at_epoch,
    })),
  };
}
