/**
 * Sessions module — Drizzle ORM operations for sessions + sdk_sessions tables.
 *
 * Ported from claude-mem's SQLite Sessions.ts / sessions/*.ts.
 * Each function takes a `db` (Drizzle instance) as its first argument.
 */

import { eq, and, desc, asc, isNull, isNotNull, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { sessions, sdkSessions, sessionSummaries } from './schema.js';
import type { SessionRow, SDKSessionRow } from './types.js';

// ---------------------------------------------------------------------------
// sessions table
// ---------------------------------------------------------------------------

/**
 * Create a new session record.
 * Returns the inserted row.
 */
export async function createSession(
  db: Database,
  input: {
    session_id: string;
    project: string;
    created_at: string;
    source?: string;
    archive_path?: string;
    archive_bytes?: number;
    archive_checksum?: string;
    archived_at?: string;
    metadata_json?: string;
  },
): Promise<SessionRow> {
  const epoch = new Date(input.created_at).getTime();

  const [row] = await db
    .insert(sessions)
    .values({
      session_id: input.session_id,
      project: input.project,
      created_at: input.created_at,
      created_at_epoch: epoch,
      source: (input.source as 'compress' | 'save' | 'legacy-jsonl') ?? 'compress',
      archive_path: input.archive_path ?? null,
      archive_bytes: input.archive_bytes ?? null,
      archive_checksum: input.archive_checksum ?? null,
      archived_at: input.archived_at ?? null,
      metadata_json: input.metadata_json ?? null,
    })
    .returning();

  return row as SessionRow;
}

/**
 * Get a session by session_id.
 */
export async function getSession(
  db: Database,
  sessionId: string,
): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.session_id, sessionId))
    .limit(1);

  return (rows[0] as SessionRow) ?? null;
}

/**
 * Get recent sessions for a project, ordered newest-first.
 */
export async function getRecentSessions(
  db: Database,
  project: string,
  limit: number = 10,
): Promise<SessionRow[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.project, project))
    .orderBy(desc(sessions.created_at_epoch))
    .limit(limit);

  return rows as SessionRow[];
}

// ---------------------------------------------------------------------------
// sdk_sessions table
// ---------------------------------------------------------------------------

/**
 * Create a new SDK session (idempotent — returns existing session ID if it already exists).
 *
 * Matches the SQLite behaviour:
 *   - If content_session_id already exists, backfill project/custom_title if needed, return existing id.
 *   - Otherwise insert a fresh row with memory_session_id = NULL and status = 'active'.
 *
 * Returns the database id (sdk_sessions.id).
 */
export async function createSdkSession(
  db: Database,
  contentSessionId: string,
  project: string,
  userPrompt: string,
  customTitle?: string,
): Promise<number> {
  // Check for existing session
  const existing = await db
    .select({ id: sdkSessions.id })
    .from(sdkSessions)
    .where(eq(sdkSessions.content_session_id, contentSessionId))
    .limit(1);

  if (existing.length > 0) {
    // Backfill project if empty
    if (project) {
      await db
        .update(sdkSessions)
        .set({ project })
        .where(
          and(
            eq(sdkSessions.content_session_id, contentSessionId),
            sql`(${sdkSessions.project} IS NULL OR ${sdkSessions.project} = '')`,
          ),
        );
    }
    // Backfill custom_title if provided and not yet set
    if (customTitle) {
      await db
        .update(sdkSessions)
        .set({ custom_title: customTitle })
        .where(
          and(
            eq(sdkSessions.content_session_id, contentSessionId),
            isNull(sdkSessions.custom_title),
          ),
        );
    }
    return existing[0].id;
  }

  // Insert new session
  const now = new Date();
  const [row] = await db
    .insert(sdkSessions)
    .values({
      content_session_id: contentSessionId,
      memory_session_id: null,
      project,
      user_prompt: userPrompt,
      custom_title: customTitle ?? null,
      started_at: now.toISOString(),
      started_at_epoch: now.getTime(),
      status: 'active',
    })
    .returning({ id: sdkSessions.id });

  return row.id;
}

/**
 * Get an SDK session by content_session_id.
 */
export async function getSdkSession(
  db: Database,
  contentSessionId: string,
): Promise<SDKSessionRow | null> {
  const rows = await db
    .select()
    .from(sdkSessions)
    .where(eq(sdkSessions.content_session_id, contentSessionId))
    .limit(1);

  return (rows[0] as SDKSessionRow) ?? null;
}

/**
 * Get an SDK session by its numeric id.
 */
export async function getSdkSessionById(
  db: Database,
  id: number,
): Promise<SDKSessionRow | null> {
  const rows = await db
    .select()
    .from(sdkSessions)
    .where(eq(sdkSessions.id, id))
    .limit(1);

  return (rows[0] as SDKSessionRow) ?? null;
}

/**
 * Update arbitrary fields on an SDK session.
 */
export async function updateSdkSession(
  db: Database,
  contentSessionId: string,
  data: Partial<{
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
    custom_title: string | null;
    worker_port: number | null;
    prompt_counter: number | null;
    status: 'active' | 'completed' | 'failed';
    completed_at: string | null;
    completed_at_epoch: number | null;
  }>,
): Promise<void> {
  await db
    .update(sdkSessions)
    .set(data)
    .where(eq(sdkSessions.content_session_id, contentSessionId));
}

/**
 * Update memory_session_id for an SDK session by database id.
 */
export async function updateMemorySessionId(
  db: Database,
  sessionDbId: number,
  memorySessionId: string | null,
): Promise<void> {
  await db
    .update(sdkSessions)
    .set({ memory_session_id: memorySessionId })
    .where(eq(sdkSessions.id, sessionDbId));
}

/**
 * Mark an SDK session as completed.
 */
export async function completeSdkSession(
  db: Database,
  contentSessionId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(sdkSessions)
    .set({
      status: 'completed',
      completed_at: now.toISOString(),
      completed_at_epoch: now.getTime(),
    })
    .where(eq(sdkSessions.content_session_id, contentSessionId));
}

/**
 * Get recent SDK sessions with summary status (for display).
 * Returns sessions ordered oldest-first.
 */
export async function getRecentSessionsWithStatus(
  db: Database,
  project: string,
  limit: number = 3,
): Promise<
  Array<{
    memory_session_id: string | null;
    status: string;
    started_at: string;
    started_at_epoch: number;
    user_prompt: string | null;
    has_summary: boolean;
  }>
> {
  const rows = await db
    .select({
      memory_session_id: sdkSessions.memory_session_id,
      status: sdkSessions.status,
      started_at: sdkSessions.started_at,
      started_at_epoch: sdkSessions.started_at_epoch,
      user_prompt: sdkSessions.user_prompt,
      has_summary: sql<boolean>`CASE WHEN ${sessionSummaries.memory_session_id} IS NOT NULL THEN true ELSE false END`,
    })
    .from(sdkSessions)
    .leftJoin(
      sessionSummaries,
      eq(sdkSessions.memory_session_id, sessionSummaries.memory_session_id),
    )
    .where(
      and(
        eq(sdkSessions.project, project),
        isNotNull(sdkSessions.memory_session_id),
      ),
    )
    .groupBy(
      sdkSessions.memory_session_id,
      sdkSessions.status,
      sdkSessions.started_at,
      sdkSessions.started_at_epoch,
      sdkSessions.user_prompt,
      sessionSummaries.memory_session_id,
    )
    .orderBy(desc(sdkSessions.started_at_epoch))
    .limit(limit);

  // Reverse to oldest-first for display
  return rows.reverse();
}
