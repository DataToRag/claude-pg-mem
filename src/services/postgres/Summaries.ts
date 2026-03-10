/**
 * Summaries module — Drizzle ORM operations for the session_summaries table.
 *
 * Ported from claude-mem's SQLite Summaries.ts / summaries/*.ts.
 * Each function takes a `db` (Drizzle instance) as its first argument.
 */

import { eq, desc, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { sessionSummaries } from './schema.js';
import type { SessionSummaryRow, SessionSummaryInput } from './types.js';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoreSummaryResult {
  id: number;
  createdAtEpoch: number;
}

/**
 * Store a session summary with an optional embedding vector.
 */
export async function storeSummary(
  db: Database,
  input: SessionSummaryInput,
  embedding?: number[],
): Promise<StoreSummaryResult> {
  const timestampEpoch = new Date(input.created_at).getTime();

  // Build search_vector text from summary fields
  const searchText = [
    input.request,
    input.investigated,
    input.learned,
    input.completed,
    input.next_steps,
    input.notes,
  ]
    .filter(Boolean)
    .join(' ');

  const [row] = await db
    .insert(sessionSummaries)
    .values({
      memory_session_id: input.memory_session_id,
      project: input.project,
      request: input.request ?? null,
      investigated: input.investigated ?? null,
      learned: input.learned ?? null,
      completed: input.completed ?? null,
      next_steps: input.next_steps ?? null,
      files_read: input.files_read ?? null,
      files_edited: input.files_edited ?? null,
      notes: input.notes ?? null,
      prompt_number: input.prompt_number ?? null,
      discovery_tokens: input.discovery_tokens ?? 0,
      created_at: input.created_at,
      created_at_epoch: timestampEpoch,
      embedding: embedding ?? input.embedding ?? null,
      search_vector: searchText
        ? sql`to_tsvector('english', ${searchText})`
        : null,
    })
    .returning({ id: sessionSummaries.id, created_at_epoch: sessionSummaries.created_at_epoch });

  return { id: row.id, createdAtEpoch: row.created_at_epoch };
}

// ---------------------------------------------------------------------------
// Column selection — exclude embedding and search_vector from results
// ---------------------------------------------------------------------------

const summaryColumns = {
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
// Get
// ---------------------------------------------------------------------------

/**
 * Get the most recent summary for a session (by memory_session_id).
 */
export async function getSummary(
  db: Database,
  memorySessionId: string,
): Promise<SessionSummaryRow | null> {
  const rows = await db
    .select(summaryColumns)
    .from(sessionSummaries)
    .where(eq(sessionSummaries.memory_session_id, memorySessionId))
    .orderBy(desc(sessionSummaries.created_at_epoch))
    .limit(1);

  return (rows[0] as SessionSummaryRow) ?? null;
}

/**
 * Get a summary by its numeric id.
 */
export async function getSummaryById(
  db: Database,
  id: number,
): Promise<SessionSummaryRow | null> {
  const rows = await db
    .select(summaryColumns)
    .from(sessionSummaries)
    .where(eq(sessionSummaries.id, id))
    .limit(1);

  return (rows[0] as SessionSummaryRow) ?? null;
}

// ---------------------------------------------------------------------------
// Recent
// ---------------------------------------------------------------------------

/**
 * Get recent summaries for a project.
 */
export async function getRecentSummaries(
  db: Database,
  project: string,
  limit: number = 10,
): Promise<SessionSummaryRow[]> {
  const rows = await db
    .select(summaryColumns)
    .from(sessionSummaries)
    .where(eq(sessionSummaries.project, project))
    .orderBy(desc(sessionSummaries.created_at_epoch))
    .limit(limit);

  return rows as SessionSummaryRow[];
}
