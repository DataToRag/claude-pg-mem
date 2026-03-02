/**
 * Cross-boundary database transactions.
 *
 * Atomic operations that span observations, summaries, and pending messages.
 * Ported from claude-mem's SQLite transactions.ts.
 *
 * NOTE: The Neon HTTP driver does NOT support true interactive transactions.
 * These functions perform sequential inserts. For strict transactional guarantees,
 * use a Neon WebSocket driver and wrap calls in `db.transaction()`.
 */

import { eq, and, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { observations, sessionSummaries, pendingMessages } from './schema.js';
import {
  computeObservationContentHash,
  findDuplicateObservation,
} from './Observations.js';
import type { ObservationInput, SessionSummaryInput } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoreObservationsResult {
  observationIds: number[];
  summaryId: number | null;
  createdAtEpoch: number;
}

/** Legacy alias */
export type StoreAndMarkCompleteResult = StoreObservationsResult;

// ---------------------------------------------------------------------------
// Embed function type
// ---------------------------------------------------------------------------

/**
 * An optional function that computes an embedding vector for text content.
 * Callers can inject their own embedding provider.
 */
export type EmbedFn = (text: string) => Promise<number[]>;

// ---------------------------------------------------------------------------
// storeObservations (no message tracking)
// ---------------------------------------------------------------------------

/**
 * Store multiple observations (+ optional summary) in a batch.
 * Content-hash deduplication is applied per observation.
 *
 * @param db            Drizzle database instance
 * @param obsInputs     Array of observation inputs
 * @param sessionId     memory_session_id for all observations
 * @param embedFn       Optional function to generate embedding vectors
 * @param summaryInput  Optional summary to store
 */
export async function storeObservations(
  db: Database,
  obsInputs: ObservationInput[],
  sessionId: string,
  embedFn?: EmbedFn,
  summaryInput?: SessionSummaryInput,
): Promise<StoreObservationsResult> {
  const observationIds: number[] = [];
  let createdAtEpoch = Date.now();

  for (const input of obsInputs) {
    const timestampEpoch = new Date(input.created_at).getTime();
    createdAtEpoch = timestampEpoch;

    const contentHash =
      input.content_hash ??
      computeObservationContentHash(input.memory_session_id, input.title, input.narrative);

    // Dedup check
    const existing = await findDuplicateObservation(db, contentHash, timestampEpoch);
    if (existing) {
      observationIds.push(existing.id);
      continue;
    }

    // Compute embedding if function provided
    let embedding: number[] | undefined;
    if (embedFn) {
      const text = [input.title, input.subtitle, input.narrative, input.text]
        .filter(Boolean)
        .join(' ');
      if (text) {
        embedding = await embedFn(text);
      }
    }

    const searchText = [input.title, input.subtitle, input.narrative, input.text]
      .filter(Boolean)
      .join(' ');

    const [row] = await db
      .insert(observations)
      .values({
        memory_session_id: input.memory_session_id,
        project: input.project,
        text: input.text ?? null,
        type: input.type,
        title: input.title ?? null,
        subtitle: input.subtitle ?? null,
        facts: input.facts ?? null,
        narrative: input.narrative ?? null,
        concepts: input.concepts ?? null,
        files_read: input.files_read ?? null,
        files_modified: input.files_modified ?? null,
        prompt_number: input.prompt_number ?? null,
        discovery_tokens: input.discovery_tokens ?? 0,
        content_hash: contentHash,
        created_at: input.created_at,
        created_at_epoch: timestampEpoch,
        embedding: embedding ?? input.embedding ?? null,
        search_vector: searchText
          ? sql`to_tsvector('english', ${searchText})`
          : null,
      })
      .returning({ id: observations.id });

    observationIds.push(row.id);
  }

  // Store summary if provided
  let summaryId: number | null = null;
  if (summaryInput) {
    const summaryEpoch = new Date(summaryInput.created_at).getTime();

    let summaryEmbedding: number[] | undefined;
    if (embedFn) {
      const text = [
        summaryInput.request,
        summaryInput.investigated,
        summaryInput.learned,
        summaryInput.completed,
        summaryInput.next_steps,
        summaryInput.notes,
      ]
        .filter(Boolean)
        .join(' ');
      if (text) {
        summaryEmbedding = await embedFn(text);
      }
    }

    const searchText = [
      summaryInput.request,
      summaryInput.investigated,
      summaryInput.learned,
      summaryInput.completed,
      summaryInput.next_steps,
      summaryInput.notes,
    ]
      .filter(Boolean)
      .join(' ');

    const [row] = await db
      .insert(sessionSummaries)
      .values({
        memory_session_id: summaryInput.memory_session_id,
        project: summaryInput.project,
        request: summaryInput.request ?? null,
        investigated: summaryInput.investigated ?? null,
        learned: summaryInput.learned ?? null,
        completed: summaryInput.completed ?? null,
        next_steps: summaryInput.next_steps ?? null,
        files_read: summaryInput.files_read ?? null,
        files_edited: summaryInput.files_edited ?? null,
        notes: summaryInput.notes ?? null,
        prompt_number: summaryInput.prompt_number ?? null,
        discovery_tokens: summaryInput.discovery_tokens ?? 0,
        created_at: summaryInput.created_at,
        created_at_epoch: summaryEpoch,
        embedding: summaryEmbedding ?? summaryInput.embedding ?? null,
        search_vector: searchText
          ? sql`to_tsvector('english', ${searchText})`
          : null,
      })
      .returning({ id: sessionSummaries.id });

    summaryId = row.id;
  }

  return { observationIds, summaryId, createdAtEpoch };
}

// ---------------------------------------------------------------------------
// storeObservationsAndMarkComplete (with pending message tracking)
// ---------------------------------------------------------------------------

/**
 * Store observations + summary + mark pending message as processed.
 *
 * Wraps observation storage, summary storage, and message completion
 * in sequential operations. If using a transactional driver, wrap the
 * call in `db.transaction()` for true atomicity.
 *
 * @param db            Drizzle database instance
 * @param obsInputs     Array of observation inputs
 * @param summaryInput  Optional summary to store
 * @param sessionId     memory_session_id
 * @param messageId     Pending message ID to mark as processed
 * @param embedFn       Optional embedding function
 */
export async function storeObservationsAndMarkComplete(
  db: Database,
  obsInputs: ObservationInput[],
  summaryInput: SessionSummaryInput | null,
  sessionId: string,
  messageId: number,
  embedFn?: EmbedFn,
): Promise<StoreAndMarkCompleteResult> {
  // Store observations and optional summary
  const result = await storeObservations(
    db,
    obsInputs,
    sessionId,
    embedFn,
    summaryInput ?? undefined,
  );

  // Mark pending message as processed
  const now = Date.now();
  await db
    .update(pendingMessages)
    .set({
      status: 'processed',
      completed_at_epoch: now,
      tool_input: null,
      tool_response: null,
    })
    .where(
      and(
        eq(pendingMessages.id, messageId),
        eq(pendingMessages.status, 'processing'),
      ),
    );

  return result;
}
