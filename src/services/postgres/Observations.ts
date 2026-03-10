/**
 * Observations module — Drizzle ORM operations for the observations table.
 *
 * Ported from claude-mem's SQLite Observations.ts / observations/*.ts.
 * Each function takes a `db` (Drizzle instance) as its first argument.
 */

import { createHash } from 'crypto';
import { eq, and, desc, asc, gt, inArray, sql, like, or } from 'drizzle-orm';
import type { Database } from './client.js';
import { observations } from './schema.js';
import type { ObservationRow, ObservationInput } from './types.js';

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/** Deduplication window: observations with the same content hash within this window are skipped */
const DEDUP_WINDOW_MS = 30_000;

/**
 * Compute a short content hash for deduplication.
 * Uses (memory_session_id, title, narrative) as the semantic identity of an observation.
 */
export function computeObservationContentHash(
  memorySessionId: string,
  title: string | null | undefined,
  narrative: string | null | undefined,
): string {
  return createHash('sha256')
    .update((memorySessionId || '') + (title || '') + (narrative || ''))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Check if a duplicate observation exists within the dedup window.
 * Returns the existing observation's id and timestamp if found, null otherwise.
 */
export async function findDuplicateObservation(
  db: Database,
  contentHash: string,
  timestampEpoch: number,
): Promise<{ id: number; created_at_epoch: number } | null> {
  const windowStart = timestampEpoch - DEDUP_WINDOW_MS;
  const rows = await db
    .select({ id: observations.id, created_at_epoch: observations.created_at_epoch })
    .from(observations)
    .where(
      and(
        eq(observations.content_hash, contentHash),
        gt(observations.created_at_epoch, windowStart),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoreObservationResult {
  id: number;
  createdAtEpoch: number;
}

/**
 * Store an observation with optional embedding vector.
 * Performs content-hash deduplication: skips INSERT if an identical observation
 * exists within the 30-second dedup window.
 */
export async function storeObservation(
  db: Database,
  input: ObservationInput,
  embedding?: number[],
): Promise<StoreObservationResult> {
  const timestampEpoch = new Date(input.created_at).getTime();

  // Content-hash deduplication
  const contentHash =
    input.content_hash ??
    computeObservationContentHash(input.memory_session_id, input.title, input.narrative);

  const existing = await findDuplicateObservation(db, contentHash, timestampEpoch);
  if (existing) {
    return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
  }

  // Build search_vector from text fields for full-text search
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
    .returning({ id: observations.id, created_at_epoch: observations.created_at_epoch });

  return { id: row.id, createdAtEpoch: row.created_at_epoch };
}

// ---------------------------------------------------------------------------
// Column selection — exclude embedding and search_vector from results
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

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

/**
 * Get a single observation by ID.
 */
export async function getObservation(
  db: Database,
  id: number,
): Promise<ObservationRow | null> {
  const rows = await db
    .select(observationColumns)
    .from(observations)
    .where(eq(observations.id, id))
    .limit(1);

  return (rows[0] as ObservationRow) ?? null;
}

/**
 * Get observations by an array of IDs, preserving caller-specified order.
 */
export async function getObservationsByIds(
  db: Database,
  ids: number[],
): Promise<ObservationRow[]> {
  if (ids.length === 0) return [];

  const rows = await db
    .select(observationColumns)
    .from(observations)
    .where(inArray(observations.id, ids));

  // Preserve caller order
  const byId = new Map<number, ObservationRow>();
  for (const r of rows) {
    byId.set(r.id, r as ObservationRow);
  }
  return ids.map((id) => byId.get(id)).filter(Boolean) as ObservationRow[];
}

/**
 * Get all observations for a session (by memory_session_id), ordered by creation time ascending.
 */
export async function getObservationsBySession(
  db: Database,
  memorySessionId: string,
): Promise<ObservationRow[]> {
  const rows = await db
    .select(observationColumns)
    .from(observations)
    .where(eq(observations.memory_session_id, memorySessionId))
    .orderBy(asc(observations.created_at_epoch));

  return rows as ObservationRow[];
}

// ---------------------------------------------------------------------------
// Recent
// ---------------------------------------------------------------------------

/**
 * Get recent observations for a project.
 */
export async function getRecentObservations(
  db: Database,
  project: string,
  limit: number = 20,
): Promise<ObservationRow[]> {
  const rows = await db
    .select(observationColumns)
    .from(observations)
    .where(eq(observations.project, project))
    .orderBy(desc(observations.created_at_epoch))
    .limit(limit);

  return rows as ObservationRow[];
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Find observations that reference a file path in files_read or files_modified JSON arrays.
 */
export async function getObservationsByFile(
  db: Database,
  filePath: string,
): Promise<ObservationRow[]> {
  const pattern = `%${filePath}%`;
  const rows = await db
    .select(observationColumns)
    .from(observations)
    .where(
      or(
        like(observations.files_read, pattern),
        like(observations.files_modified, pattern),
      ),
    )
    .orderBy(desc(observations.created_at_epoch));

  return rows as ObservationRow[];
}
