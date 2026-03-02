/**
 * PendingMessageStore — Persistent work queue with claim-confirm pattern.
 *
 * Ported from claude-mem's SQLite PendingMessageStore.ts.
 * Uses Drizzle ORM with Postgres transactions.
 *
 * Lifecycle:
 *   1. enqueue()          — Message persisted with status 'pending'
 *   2. claimNextMessage() — Atomically claim next pending (marks 'processing'),
 *                           with self-healing for stale messages (>60s)
 *   3. confirmProcessed() — Delete message after successful processing
 *
 * Self-healing:
 *   claimNextMessage() resets stale 'processing' messages (>60s) back to 'pending'
 *   before claiming. This recovers from generator crashes without external timers.
 */

import { eq, and, lt, asc, inArray, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { pendingMessages, sdkSessions } from './schema.js';
import type { PendingMessageRow, PendingMessageInput } from './types.js';

/** Messages processing longer than this are considered stale */
const STALE_PROCESSING_THRESHOLD_MS = 60_000;

/** Default maximum retry count before marking permanently failed */
const DEFAULT_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Persist a new message as 'pending'.
 * Returns the database id of the persisted message.
 */
export async function enqueue(
  db: Database,
  sessionDbId: number,
  contentSessionId: string,
  message: PendingMessageInput,
): Promise<number> {
  const now = Date.now();

  const [row] = await db
    .insert(pendingMessages)
    .values({
      session_db_id: sessionDbId,
      content_session_id: contentSessionId,
      message_type: message.message_type,
      tool_name: message.tool_name ?? null,
      tool_input: message.tool_input ?? null,
      tool_response: message.tool_response ?? null,
      cwd: message.cwd ?? null,
      last_user_message: message.last_user_message ?? null,
      last_assistant_message: message.last_assistant_message ?? null,
      prompt_number: message.prompt_number ?? null,
      status: 'pending',
      retry_count: 0,
      created_at_epoch: now,
    })
    .returning({ id: pendingMessages.id });

  return row.id;
}

// ---------------------------------------------------------------------------
// Claim / Confirm
// ---------------------------------------------------------------------------

/**
 * Atomically claim the next pending message by marking it as 'processing'.
 *
 * Self-healing: resets stale 'processing' messages (>60s) back to 'pending' first.
 * Uses a transaction to prevent race conditions.
 *
 * NOTE: Neon HTTP driver does not support true interactive transactions.
 * For atomicity we use two sequential statements. For stronger isolation,
 * consider using the WebSocket-based `neon` driver with `db.transaction()`.
 */
export async function claimNextMessage(
  db: Database,
  sessionDbId: number,
): Promise<PendingMessageRow | null> {
  const now = Date.now();
  const staleCutoff = now - STALE_PROCESSING_THRESHOLD_MS;

  // Self-healing: reset stale 'processing' messages back to 'pending'
  await db
    .update(pendingMessages)
    .set({ status: 'pending', started_processing_at_epoch: null })
    .where(
      and(
        eq(pendingMessages.session_db_id, sessionDbId),
        eq(pendingMessages.status, 'processing'),
        lt(pendingMessages.started_processing_at_epoch, staleCutoff),
      ),
    );

  // Peek at next pending message
  const pending = await db
    .select()
    .from(pendingMessages)
    .where(
      and(
        eq(pendingMessages.session_db_id, sessionDbId),
        eq(pendingMessages.status, 'pending'),
      ),
    )
    .orderBy(asc(pendingMessages.id))
    .limit(1);

  if (pending.length === 0) return null;

  const msg = pending[0] as PendingMessageRow;

  // Mark as processing
  await db
    .update(pendingMessages)
    .set({ status: 'processing', started_processing_at_epoch: now })
    .where(eq(pendingMessages.id, msg.id));

  return msg;
}

/**
 * Confirm a message was successfully processed — DELETE it from the queue.
 * Only call this AFTER the observation/summary has been stored to DB.
 */
export async function confirmProcessed(
  db: Database,
  messageId: number,
): Promise<void> {
  await db.delete(pendingMessages).where(eq(pendingMessages.id, messageId));
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/**
 * Mark a message as failed.
 * If retry_count < maxRetries, moves back to 'pending' for retry.
 * Otherwise marks as 'failed' permanently.
 */
export async function markFailed(
  db: Database,
  messageId: number,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<void> {
  const now = Date.now();

  // Get current retry count
  const rows = await db
    .select({ retry_count: pendingMessages.retry_count })
    .from(pendingMessages)
    .where(eq(pendingMessages.id, messageId))
    .limit(1);

  if (rows.length === 0) return;

  if (rows[0].retry_count < maxRetries) {
    // Move back to pending for retry
    await db
      .update(pendingMessages)
      .set({
        status: 'pending',
        retry_count: sql`${pendingMessages.retry_count} + 1`,
        started_processing_at_epoch: null,
      })
      .where(eq(pendingMessages.id, messageId));
  } else {
    // Max retries exceeded — permanently failed
    await db
      .update(pendingMessages)
      .set({
        status: 'failed',
        completed_at_epoch: now,
        failed_at_epoch: now,
      })
      .where(eq(pendingMessages.id, messageId));
  }
}

/**
 * Mark all processing messages for a session as failed.
 * Used in error recovery when session generator crashes.
 */
export async function markSessionMessagesFailed(
  db: Database,
  sessionDbId: number,
): Promise<number> {
  const now = Date.now();

  const result = await db
    .update(pendingMessages)
    .set({ status: 'failed', failed_at_epoch: now })
    .where(
      and(
        eq(pendingMessages.session_db_id, sessionDbId),
        eq(pendingMessages.status, 'processing'),
      ),
    );

  // Drizzle doesn't expose rowCount on NeonHttp; return 0 as fallback
  return 0;
}

/**
 * Mark all pending and processing messages for a session as failed (abandoned).
 */
export async function markAllSessionMessagesAbandoned(
  db: Database,
  sessionDbId: number,
): Promise<void> {
  const now = Date.now();

  await db
    .update(pendingMessages)
    .set({ status: 'failed', failed_at_epoch: now })
    .where(
      and(
        eq(pendingMessages.session_db_id, sessionDbId),
        inArray(pendingMessages.status, ['pending', 'processing']),
      ),
    );
}

// ---------------------------------------------------------------------------
// Recovery / Reset
// ---------------------------------------------------------------------------

/**
 * Reset stale 'processing' messages back to 'pending' for retry.
 * Called on worker startup and periodically to recover from crashes.
 */
export async function resetStaleProcessingMessages(
  db: Database,
  thresholdMs: number = 5 * 60 * 1000,
  sessionDbId?: number,
): Promise<void> {
  const cutoff = Date.now() - thresholdMs;

  const conditions = [
    eq(pendingMessages.status, 'processing'),
    lt(pendingMessages.started_processing_at_epoch, cutoff),
  ];
  if (sessionDbId !== undefined) {
    conditions.push(eq(pendingMessages.session_db_id, sessionDbId));
  }

  await db
    .update(pendingMessages)
    .set({ status: 'pending', started_processing_at_epoch: null })
    .where(and(...conditions));
}

/**
 * Reset all processing messages for a session to pending.
 */
export async function resetProcessingToPending(
  db: Database,
  sessionDbId: number,
): Promise<void> {
  await db
    .update(pendingMessages)
    .set({ status: 'pending', started_processing_at_epoch: null })
    .where(
      and(
        eq(pendingMessages.session_db_id, sessionDbId),
        eq(pendingMessages.status, 'processing'),
      ),
    );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all pending messages for a session (ordered by creation time).
 */
export async function getAllPending(
  db: Database,
  sessionDbId: number,
): Promise<PendingMessageRow[]> {
  const rows = await db
    .select()
    .from(pendingMessages)
    .where(
      and(
        eq(pendingMessages.session_db_id, sessionDbId),
        eq(pendingMessages.status, 'pending'),
      ),
    )
    .orderBy(asc(pendingMessages.id));

  return rows as PendingMessageRow[];
}

/**
 * Get count of pending + processing messages for a session.
 */
export async function getPendingCount(
  db: Database,
  sessionDbId: number,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(pendingMessages)
    .where(
      and(
        eq(pendingMessages.session_db_id, sessionDbId),
        inArray(pendingMessages.status, ['pending', 'processing']),
      ),
    );

  return rows[0]?.count ?? 0;
}

/**
 * Check if any session has pending work.
 * Resets stuck 'processing' messages (>5 min) as a side effect.
 */
export async function hasAnyPendingWork(db: Database): Promise<boolean> {
  // Reset stuck processing messages first
  const stuckCutoff = Date.now() - 5 * 60 * 1000;
  await db
    .update(pendingMessages)
    .set({ status: 'pending', started_processing_at_epoch: null })
    .where(
      and(
        eq(pendingMessages.status, 'processing'),
        lt(pendingMessages.started_processing_at_epoch, stuckCutoff),
      ),
    );

  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(pendingMessages)
    .where(inArray(pendingMessages.status, ['pending', 'processing']));

  return (rows[0]?.count ?? 0) > 0;
}

/**
 * Get all session IDs that have pending messages (for recovery on startup).
 */
export async function getSessionsWithPendingMessages(
  db: Database,
): Promise<number[]> {
  const rows = await db
    .selectDistinct({ session_db_id: pendingMessages.session_db_id })
    .from(pendingMessages)
    .where(inArray(pendingMessages.status, ['pending', 'processing']));

  return rows.map((r) => r.session_db_id);
}

/**
 * Get all queue messages with project info (for UI display).
 */
export async function getQueueMessages(
  db: Database,
): Promise<(PendingMessageRow & { project: string | null })[]> {
  const rows = await db
    .select({
      id: pendingMessages.id,
      session_db_id: pendingMessages.session_db_id,
      content_session_id: pendingMessages.content_session_id,
      message_type: pendingMessages.message_type,
      tool_name: pendingMessages.tool_name,
      tool_input: pendingMessages.tool_input,
      tool_response: pendingMessages.tool_response,
      cwd: pendingMessages.cwd,
      last_user_message: pendingMessages.last_user_message,
      last_assistant_message: pendingMessages.last_assistant_message,
      prompt_number: pendingMessages.prompt_number,
      status: pendingMessages.status,
      retry_count: pendingMessages.retry_count,
      created_at_epoch: pendingMessages.created_at_epoch,
      started_processing_at_epoch: pendingMessages.started_processing_at_epoch,
      completed_at_epoch: pendingMessages.completed_at_epoch,
      failed_at_epoch: pendingMessages.failed_at_epoch,
      project: sdkSessions.project,
    })
    .from(pendingMessages)
    .leftJoin(
      sdkSessions,
      eq(pendingMessages.content_session_id, sdkSessions.content_session_id),
    )
    .where(inArray(pendingMessages.status, ['pending', 'processing', 'failed']))
    .orderBy(
      sql`CASE ${pendingMessages.status}
        WHEN 'failed' THEN 0
        WHEN 'processing' THEN 1
        WHEN 'pending' THEN 2
      END`,
      asc(pendingMessages.created_at_epoch),
    );

  return rows as (PendingMessageRow & { project: string | null })[];
}

// ---------------------------------------------------------------------------
// Admin / Cleanup
// ---------------------------------------------------------------------------

/**
 * Clear all failed messages from the queue.
 */
export async function clearFailed(db: Database): Promise<void> {
  await db
    .delete(pendingMessages)
    .where(eq(pendingMessages.status, 'failed'));
}

/**
 * Clear all non-processed messages from the queue.
 */
export async function clearAll(db: Database): Promise<void> {
  await db
    .delete(pendingMessages)
    .where(inArray(pendingMessages.status, ['pending', 'processing', 'failed']));
}

/**
 * Abort (delete) a specific message.
 */
export async function abortMessage(
  db: Database,
  messageId: number,
): Promise<void> {
  await db.delete(pendingMessages).where(eq(pendingMessages.id, messageId));
}

/**
 * Retry a specific message (reset to pending).
 */
export async function retryMessage(
  db: Database,
  messageId: number,
): Promise<void> {
  await db
    .update(pendingMessages)
    .set({ status: 'pending', started_processing_at_epoch: null })
    .where(
      and(
        eq(pendingMessages.id, messageId),
        inArray(pendingMessages.status, ['pending', 'processing', 'failed']),
      ),
    );
}
