/**
 * SessionSearch module — Structured filter, semantic (pgvector), and full-text
 * (tsvector/tsquery) search for observations, session summaries, and user prompts.
 *
 * Ported from claude-mem's SQLite SessionSearch.ts.
 * Each function takes a `db` (Drizzle instance) as its first argument.
 *
 * Three search modes:
 *   a) Structured filter search (no query text) — SQL WHERE on project, type, date range,
 *      concepts (JSON text LIKE), files (JSON text LIKE).
 *   b) Semantic search (with query text + embedding) — pgvector cosine distance.
 *   c) Full-text search (with query text, no embedding) — tsvector/tsquery.
 */

import {
  eq,
  and,
  gte,
  lte,
  desc,
  asc,
  sql,
  like,
  or,
  inArray,
  type SQL,
} from 'drizzle-orm';
import type { Database } from './client.js';
import {
  observations,
  sessionSummaries,
  userPrompts,
  sdkSessions,
} from './schema.js';
import type {
  ObservationRow,
  SessionSummaryRow,
  UserPromptRow,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult,
  SearchOptions,
  SearchFilters,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal: build filter conditions
// ---------------------------------------------------------------------------

function buildObservationFilters(
  filters: SearchFilters,
): SQL[] {
  const conditions: SQL[] = [];

  if (filters.project) {
    conditions.push(eq(observations.project, filters.project));
  }

  if (filters.type) {
    if (Array.isArray(filters.type)) {
      conditions.push(inArray(observations.type, filters.type));
    } else {
      conditions.push(eq(observations.type, filters.type));
    }
  }

  if (filters.dateRange) {
    const { start, end } = filters.dateRange;
    if (start !== undefined) {
      const epoch = typeof start === 'number' ? start : new Date(start).getTime();
      conditions.push(gte(observations.created_at_epoch, epoch));
    }
    if (end !== undefined) {
      const epoch = typeof end === 'number' ? end : new Date(end).getTime();
      conditions.push(lte(observations.created_at_epoch, epoch));
    }
  }

  if (filters.concepts) {
    const concepts = Array.isArray(filters.concepts) ? filters.concepts : [filters.concepts];
    const conceptConds = concepts.map(
      (c) => sql`${observations.concepts} LIKE ${'%' + c + '%'}`,
    );
    if (conceptConds.length > 0) {
      conditions.push(or(...conceptConds)!);
    }
  }

  if (filters.files) {
    const files = Array.isArray(filters.files) ? filters.files : [filters.files];
    const fileConds = files.map(
      (f) =>
        or(
          like(observations.files_read, `%${f}%`),
          like(observations.files_modified, `%${f}%`),
        )!,
    );
    if (fileConds.length > 0) {
      conditions.push(or(...fileConds)!);
    }
  }

  return conditions;
}

function buildSummaryFilters(
  filters: SearchFilters,
): SQL[] {
  const conditions: SQL[] = [];

  if (filters.project) {
    conditions.push(eq(sessionSummaries.project, filters.project));
  }

  if (filters.dateRange) {
    const { start, end } = filters.dateRange;
    if (start !== undefined) {
      const epoch = typeof start === 'number' ? start : new Date(start).getTime();
      conditions.push(gte(sessionSummaries.created_at_epoch, epoch));
    }
    if (end !== undefined) {
      const epoch = typeof end === 'number' ? end : new Date(end).getTime();
      conditions.push(lte(sessionSummaries.created_at_epoch, epoch));
    }
  }

  if (filters.files) {
    const files = Array.isArray(filters.files) ? filters.files : [filters.files];
    const fileConds = files.map(
      (f) =>
        or(
          like(sessionSummaries.files_read, `%${f}%`),
          like(sessionSummaries.files_edited, `%${f}%`),
        )!,
    );
    if (fileConds.length > 0) {
      conditions.push(or(...fileConds)!);
    }
  }

  return conditions;
}

// ---------------------------------------------------------------------------
// Observation search
// ---------------------------------------------------------------------------

/**
 * Search observations.
 *
 * @param db        Drizzle database instance
 * @param query     Optional query string for full-text search
 * @param options   Search filters and pagination
 * @param embedding Optional pre-computed embedding vector for semantic search
 */
export async function searchObservations(
  db: Database,
  query: string | undefined,
  options: SearchOptions = {},
  embedding?: number[],
): Promise<ObservationSearchResult[]> {
  const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

  // --- Semantic search (pgvector cosine distance) ---
  if (embedding && embedding.length > 0) {
    const filterConditions = buildObservationFilters(filters);
    const vecLiteral = `[${embedding.join(',')}]`;

    const rows = await db
      .select({
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
        embedding: observations.embedding,
        search_vector: observations.search_vector,
        score: sql<number>`1 - (${observations.embedding} <=> ${vecLiteral}::vector)`,
      })
      .from(observations)
      .where(
        filterConditions.length > 0
          ? and(...filterConditions, sql`${observations.embedding} IS NOT NULL`)
          : sql`${observations.embedding} IS NOT NULL`,
      )
      .orderBy(sql`${observations.embedding} <=> ${vecLiteral}::vector`)
      .limit(limit)
      .offset(offset);

    return rows as ObservationSearchResult[];
  }

  // --- Full-text search (tsvector/tsquery) ---
  if (query) {
    const filterConditions = buildObservationFilters(filters);
    // Convert query to tsquery-safe format: split on spaces, join with &
    const tsQuery = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(' & ');

    const rows = await db
      .select({
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
        embedding: observations.embedding,
        search_vector: observations.search_vector,
        rank: sql<number>`ts_rank(${observations.search_vector}, to_tsquery('english', ${tsQuery}))`,
      })
      .from(observations)
      .where(
        filterConditions.length > 0
          ? and(
              ...filterConditions,
              sql`${observations.search_vector} @@ to_tsquery('english', ${tsQuery})`,
            )
          : sql`${observations.search_vector} @@ to_tsquery('english', ${tsQuery})`,
      )
      .orderBy(
        orderBy === 'date_asc'
          ? asc(observations.created_at_epoch)
          : orderBy === 'date_desc'
            ? desc(observations.created_at_epoch)
            : sql`ts_rank(${observations.search_vector}, to_tsquery('english', ${tsQuery})) DESC`,
      )
      .limit(limit)
      .offset(offset);

    return rows as ObservationSearchResult[];
  }

  // --- Structured filter search (no query text) ---
  const filterConditions = buildObservationFilters(filters);
  if (filterConditions.length === 0) {
    throw new Error('Either query or filters required for search');
  }

  const rows = await db
    .select()
    .from(observations)
    .where(and(...filterConditions))
    .orderBy(
      orderBy === 'date_asc'
        ? asc(observations.created_at_epoch)
        : desc(observations.created_at_epoch),
    )
    .limit(limit)
    .offset(offset);

  return rows as ObservationSearchResult[];
}

// ---------------------------------------------------------------------------
// Session summary search
// ---------------------------------------------------------------------------

/**
 * Search session summaries.
 */
export async function searchSessions(
  db: Database,
  query: string | undefined,
  options: SearchOptions = {},
  embedding?: number[],
): Promise<SessionSummarySearchResult[]> {
  const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

  // --- Semantic search ---
  if (embedding && embedding.length > 0) {
    const filterConditions = buildSummaryFilters(filters);
    const vecLiteral = `[${embedding.join(',')}]`;

    const rows = await db
      .select({
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
        embedding: sessionSummaries.embedding,
        search_vector: sessionSummaries.search_vector,
        score: sql<number>`1 - (${sessionSummaries.embedding} <=> ${vecLiteral}::vector)`,
      })
      .from(sessionSummaries)
      .where(
        filterConditions.length > 0
          ? and(...filterConditions, sql`${sessionSummaries.embedding} IS NOT NULL`)
          : sql`${sessionSummaries.embedding} IS NOT NULL`,
      )
      .orderBy(sql`${sessionSummaries.embedding} <=> ${vecLiteral}::vector`)
      .limit(limit)
      .offset(offset);

    return rows as SessionSummarySearchResult[];
  }

  // --- Full-text search ---
  if (query) {
    const filterConditions = buildSummaryFilters(filters);
    const tsQuery = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(' & ');

    const rows = await db
      .select({
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
        embedding: sessionSummaries.embedding,
        search_vector: sessionSummaries.search_vector,
        rank: sql<number>`ts_rank(${sessionSummaries.search_vector}, to_tsquery('english', ${tsQuery}))`,
      })
      .from(sessionSummaries)
      .where(
        filterConditions.length > 0
          ? and(
              ...filterConditions,
              sql`${sessionSummaries.search_vector} @@ to_tsquery('english', ${tsQuery})`,
            )
          : sql`${sessionSummaries.search_vector} @@ to_tsquery('english', ${tsQuery})`,
      )
      .orderBy(
        orderBy === 'date_asc'
          ? asc(sessionSummaries.created_at_epoch)
          : orderBy === 'date_desc'
            ? desc(sessionSummaries.created_at_epoch)
            : sql`ts_rank(${sessionSummaries.search_vector}, to_tsquery('english', ${tsQuery})) DESC`,
      )
      .limit(limit)
      .offset(offset);

    return rows as SessionSummarySearchResult[];
  }

  // --- Structured filter search ---
  const filterConditions = buildSummaryFilters(filters);
  if (filterConditions.length === 0) {
    throw new Error('Either query or filters required for search');
  }

  const rows = await db
    .select()
    .from(sessionSummaries)
    .where(and(...filterConditions))
    .orderBy(
      orderBy === 'date_asc'
        ? asc(sessionSummaries.created_at_epoch)
        : desc(sessionSummaries.created_at_epoch),
    )
    .limit(limit)
    .offset(offset);

  return rows as SessionSummarySearchResult[];
}

// ---------------------------------------------------------------------------
// User prompt search
// ---------------------------------------------------------------------------

/**
 * Search user prompts.
 */
export async function searchUserPrompts(
  db: Database,
  query: string | undefined,
  options: SearchOptions = {},
): Promise<UserPromptSearchResult[]> {
  const { limit = 20, offset = 0, orderBy = 'relevance', ...filters } = options;

  const conditions: SQL[] = [];

  if (filters.project) {
    conditions.push(eq(sdkSessions.project, filters.project));
  }

  if (filters.dateRange) {
    const { start, end } = filters.dateRange;
    if (start !== undefined) {
      const epoch = typeof start === 'number' ? start : new Date(start).getTime();
      conditions.push(gte(userPrompts.created_at_epoch, epoch));
    }
    if (end !== undefined) {
      const epoch = typeof end === 'number' ? end : new Date(end).getTime();
      conditions.push(lte(userPrompts.created_at_epoch, epoch));
    }
  }

  // Full-text search on prompt_text (using ILIKE for simplicity — no tsvector on this table)
  if (query) {
    conditions.push(sql`${userPrompts.prompt_text} ILIKE ${'%' + query + '%'}`);
  }

  if (!query && conditions.length === 0) {
    throw new Error('Either query or filters required for search');
  }

  const rows = await db
    .select({
      id: userPrompts.id,
      content_session_id: userPrompts.content_session_id,
      prompt_number: userPrompts.prompt_number,
      prompt_text: userPrompts.prompt_text,
      created_at: userPrompts.created_at,
      created_at_epoch: userPrompts.created_at_epoch,
    })
    .from(userPrompts)
    .innerJoin(sdkSessions, eq(userPrompts.content_session_id, sdkSessions.content_session_id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      orderBy === 'date_asc'
        ? asc(userPrompts.created_at_epoch)
        : desc(userPrompts.created_at_epoch),
    )
    .limit(limit)
    .offset(offset);

  return rows as UserPromptSearchResult[];
}

// ---------------------------------------------------------------------------
// Convenience finders
// ---------------------------------------------------------------------------

/**
 * Find observations by concept tag (JSON array LIKE search).
 */
export async function findByConcept(
  db: Database,
  concept: string,
  options: SearchOptions = {},
): Promise<ObservationSearchResult[]> {
  return searchObservations(db, undefined, { ...options, concepts: concept });
}

/**
 * Find observations by type.
 */
export async function findByType(
  db: Database,
  type: ObservationRow['type'] | ObservationRow['type'][],
  options: SearchOptions = {},
): Promise<ObservationSearchResult[]> {
  return searchObservations(db, undefined, { ...options, type });
}

/**
 * Find observations and summaries by file path.
 */
export async function findByFile(
  db: Database,
  filePath: string,
  options: SearchOptions = {},
): Promise<{
  observations: ObservationSearchResult[];
  sessions: SessionSummarySearchResult[];
}> {
  const obsResults = await searchObservations(db, undefined, {
    ...options,
    files: filePath,
  });

  const sessResults = await searchSessions(db, undefined, {
    ...options,
    files: filePath,
  });

  return { observations: obsResults, sessions: sessResults };
}
