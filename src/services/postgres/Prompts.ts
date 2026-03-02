/**
 * Prompts module — Drizzle ORM operations for the user_prompts table.
 *
 * Ported from claude-mem's SQLite Prompts.ts / prompts/*.ts.
 * Each function takes a `db` (Drizzle instance) as its first argument.
 */

import { eq, desc, asc, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { userPrompts, sdkSessions } from './schema.js';
import type { UserPromptRow, UserPromptInput } from './types.js';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Store a user prompt.
 * Returns the inserted row id.
 */
export async function storeUserPrompt(
  db: Database,
  input: UserPromptInput,
): Promise<number> {
  const epoch = new Date(input.created_at).getTime();

  const [row] = await db
    .insert(userPrompts)
    .values({
      content_session_id: input.content_session_id,
      prompt_number: input.prompt_number,
      prompt_text: input.prompt_text,
      created_at: input.created_at,
      created_at_epoch: epoch,
    })
    .returning({ id: userPrompts.id });

  return row.id;
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

/**
 * Get all user prompts for a content session, ordered by prompt number ascending.
 */
export async function getUserPrompts(
  db: Database,
  contentSessionId: string,
): Promise<UserPromptRow[]> {
  const rows = await db
    .select()
    .from(userPrompts)
    .where(eq(userPrompts.content_session_id, contentSessionId))
    .orderBy(asc(userPrompts.prompt_number));

  return rows as UserPromptRow[];
}

/**
 * Get a single user prompt by session and prompt number.
 */
export async function getUserPrompt(
  db: Database,
  contentSessionId: string,
  promptNumber: number,
): Promise<string | null> {
  const rows = await db
    .select({ prompt_text: userPrompts.prompt_text })
    .from(userPrompts)
    .where(
      sql`${userPrompts.content_session_id} = ${contentSessionId}
          AND ${userPrompts.prompt_number} = ${promptNumber}`,
    )
    .limit(1);

  return rows[0]?.prompt_text ?? null;
}

/**
 * Get prompt count for a session (replaces prompt_counter column).
 */
export async function getPromptCount(
  db: Database,
  contentSessionId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(userPrompts)
    .where(eq(userPrompts.content_session_id, contentSessionId));

  return rows[0]?.count ?? 0;
}

/**
 * Get the latest user prompt with project info for a content session.
 */
export async function getLatestUserPrompt(
  db: Database,
  contentSessionId: string,
): Promise<(UserPromptRow & { memory_session_id: string | null; project: string }) | null> {
  const rows = await db
    .select({
      id: userPrompts.id,
      content_session_id: userPrompts.content_session_id,
      prompt_number: userPrompts.prompt_number,
      prompt_text: userPrompts.prompt_text,
      created_at: userPrompts.created_at,
      created_at_epoch: userPrompts.created_at_epoch,
      memory_session_id: sdkSessions.memory_session_id,
      project: sdkSessions.project,
    })
    .from(userPrompts)
    .innerJoin(sdkSessions, eq(userPrompts.content_session_id, sdkSessions.content_session_id))
    .where(eq(userPrompts.content_session_id, contentSessionId))
    .orderBy(desc(userPrompts.created_at_epoch))
    .limit(1);

  return (rows[0] as (UserPromptRow & { memory_session_id: string | null; project: string })) ?? null;
}

/**
 * Get recent user prompts across all sessions (for web UI).
 */
export async function getAllRecentUserPrompts(
  db: Database,
  limit: number = 100,
): Promise<Array<UserPromptRow & { project: string | null }>> {
  const rows = await db
    .select({
      id: userPrompts.id,
      content_session_id: userPrompts.content_session_id,
      prompt_number: userPrompts.prompt_number,
      prompt_text: userPrompts.prompt_text,
      created_at: userPrompts.created_at,
      created_at_epoch: userPrompts.created_at_epoch,
      project: sdkSessions.project,
    })
    .from(userPrompts)
    .leftJoin(sdkSessions, eq(userPrompts.content_session_id, sdkSessions.content_session_id))
    .orderBy(desc(userPrompts.created_at_epoch))
    .limit(limit);

  return rows as Array<UserPromptRow & { project: string | null }>;
}
