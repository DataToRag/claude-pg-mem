/**
 * Drizzle ORM schema for Postgres — ported from claude-mem's SQLite migrations.
 *
 * Conversion rules applied:
 *   INTEGER PRIMARY KEY AUTOINCREMENT  → serial('id').primaryKey()
 *   TEXT NOT NULL                      → text('...').notNull()
 *   TEXT storing JSON                  → jsonb('...')
 *   INTEGER epoch timestamps           → bigint('...', { mode: 'number' })
 *   UNIQUE                             → .unique()
 *   Foreign keys                       → .references(() => table.column, { onDelete: '...' })
 *
 * Postgres-specific additions:
 *   - vector(768) columns on observations & session_summaries for semantic search
 *   - HNSW indexes with cosine ops on vector columns
 *   - tsvector generated columns + GIN indexes for full-text search
 */

import {
  pgTable,
  serial,
  text,
  bigint,
  integer,
  index,
  uniqueIndex,
  customType,
  vector,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Custom type: tsvector
// ---------------------------------------------------------------------------
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// ============================================================================
// sessions (migration 001)
// ============================================================================
export const sessions = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id').unique().notNull(),
    project: text('project').notNull(),
    created_at: text('created_at').notNull(),
    created_at_epoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
    source: text('source').notNull().default('compress'),
    archive_path: text('archive_path'),
    archive_bytes: integer('archive_bytes'),
    archive_checksum: text('archive_checksum'),
    archived_at: text('archived_at'),
    metadata_json: text('metadata_json'),
  },
  (t) => [
    index('idx_sessions_project').on(t.project),
    index('idx_sessions_created_at').on(t.created_at_epoch),
    index('idx_sessions_project_created').on(t.project, t.created_at_epoch),
  ],
);

// ============================================================================
// memories (migration 001 + 002 hierarchical fields)
// ============================================================================
export const memories = pgTable(
  'memories',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    document_id: text('document_id').unique(),
    keywords: text('keywords'),
    created_at: text('created_at').notNull(),
    created_at_epoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
    project: text('project').notNull(),
    archive_basename: text('archive_basename'),
    origin: text('origin').notNull().default('transcript'),
    // Hierarchical memory fields (migration 002)
    title: text('title'),
    subtitle: text('subtitle'),
    facts: text('facts'), // JSON array of fact strings
    concepts: text('concepts'), // JSON array of concept strings
    files_touched: text('files_touched'), // JSON array of file paths
  },
  (t) => [
    index('idx_memories_session').on(t.session_id),
    index('idx_memories_project').on(t.project),
    index('idx_memories_created_at').on(t.created_at_epoch),
    index('idx_memories_project_created').on(t.project, t.created_at_epoch),
    index('idx_memories_document_id').on(t.document_id),
    index('idx_memories_origin').on(t.origin),
    index('idx_memories_title').on(t.title),
    index('idx_memories_concepts').on(t.concepts),
  ],
);

// ============================================================================
// overviews (migration 001)
// ============================================================================
export const overviews = pgTable(
  'overviews',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    created_at: text('created_at').notNull(),
    created_at_epoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
    project: text('project').notNull(),
    origin: text('origin').notNull().default('claude'),
  },
  (t) => [
    index('idx_overviews_session').on(t.session_id),
    index('idx_overviews_project').on(t.project),
    index('idx_overviews_created_at').on(t.created_at_epoch),
    index('idx_overviews_project_created').on(t.project, t.created_at_epoch),
    uniqueIndex('idx_overviews_project_latest').on(t.project, t.created_at_epoch),
  ],
);

// ============================================================================
// diagnostics (migration 001)
// ============================================================================
export const diagnostics = pgTable(
  'diagnostics',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id').references(() => sessions.session_id, {
      onDelete: 'set null',
    }),
    message: text('message').notNull(),
    severity: text('severity').notNull().default('info'),
    created_at: text('created_at').notNull(),
    created_at_epoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
    project: text('project').notNull(),
    origin: text('origin').notNull().default('system'),
  },
  (t) => [
    index('idx_diagnostics_session').on(t.session_id),
    index('idx_diagnostics_project').on(t.project),
    index('idx_diagnostics_severity').on(t.severity),
    index('idx_diagnostics_created').on(t.created_at_epoch),
  ],
);

// ============================================================================
// transcript_events (migration 001)
// ============================================================================
export const transcriptEvents = pgTable(
  'transcript_events',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    project: text('project'),
    event_index: integer('event_index').notNull(),
    event_type: text('event_type'),
    raw_json: text('raw_json').notNull(),
    captured_at: text('captured_at').notNull(),
    captured_at_epoch: bigint('captured_at_epoch', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_transcript_events_unique').on(t.session_id, t.event_index),
    index('idx_transcript_events_session').on(t.session_id, t.event_index),
    index('idx_transcript_events_project').on(t.project),
    index('idx_transcript_events_type').on(t.event_type),
    index('idx_transcript_events_captured').on(t.captured_at_epoch),
  ],
);

// ============================================================================
// sdk_sessions (migration 004 + worker_port from 005 + prompt_counter from 006
//               + custom_title from 023)
// ============================================================================
export const sdkSessions = pgTable(
  'sdk_sessions',
  {
    id: serial('id').primaryKey(),
    content_session_id: text('content_session_id').unique().notNull(),
    memory_session_id: text('memory_session_id').unique(),
    project: text('project').notNull(),
    user_prompt: text('user_prompt'),
    started_at: text('started_at').notNull(),
    started_at_epoch: bigint('started_at_epoch', { mode: 'number' }).notNull(),
    completed_at: text('completed_at'),
    completed_at_epoch: bigint('completed_at_epoch', { mode: 'number' }),
    status: text('status', { enum: ['active', 'completed', 'failed'] })
      .notNull()
      .default('active'),
    // migration 005 — worker port
    worker_port: integer('worker_port'),
    // migration 006 — prompt counter
    prompt_counter: integer('prompt_counter').default(0),
    // migration 023 — custom title
    custom_title: text('custom_title'),
  },
  (t) => [
    index('idx_sdk_sessions_claude_id').on(t.content_session_id),
    index('idx_sdk_sessions_sdk_id').on(t.memory_session_id),
    index('idx_sdk_sessions_project').on(t.project),
    index('idx_sdk_sessions_status').on(t.status),
    index('idx_sdk_sessions_started').on(t.started_at_epoch),
  ],
);

// ============================================================================
// observations (migration 004 + hierarchical fields 008 + nullable text 009
//               + prompt_number 006 + discovery_tokens 007/011
//               + content_hash 022)
//
// Postgres additions:
//   - embedding vector(768) for semantic search
//   - search_vector tsvector (generated) + GIN index for full-text search
//   - HNSW index on embedding with cosine ops
// ============================================================================
export const observations = pgTable(
  'observations',
  {
    id: serial('id').primaryKey(),
    memory_session_id: text('memory_session_id')
      .notNull()
      .references(() => sdkSessions.memory_session_id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    project: text('project').notNull(),
    text: text('text'), // nullable since migration 009
    type: text('type').notNull(),
    // Hierarchical fields (migration 008)
    title: text('title'),
    subtitle: text('subtitle'),
    facts: text('facts'), // JSON array
    narrative: text('narrative'),
    concepts: text('concepts'), // JSON array
    files_read: text('files_read'), // JSON array
    files_modified: text('files_modified'), // JSON array
    // Prompt tracking (migration 006)
    prompt_number: integer('prompt_number'),
    // ROI metrics (migration 007/011)
    discovery_tokens: integer('discovery_tokens').default(0),
    // Deduplication (migration 022)
    content_hash: text('content_hash'),
    created_at: text('created_at').notNull(),
    created_at_epoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),

    // --- Postgres-specific columns ---
    embedding: vector('embedding', { dimensions: 768 }),
    search_vector: tsvector('search_vector'),
  },
  (t) => [
    index('idx_observations_sdk_session').on(t.memory_session_id),
    index('idx_observations_project').on(t.project),
    index('idx_observations_type').on(t.type),
    index('idx_observations_created').on(t.created_at_epoch),
    index('idx_observations_content_hash').on(t.content_hash, t.created_at_epoch),
    // HNSW index for vector similarity search (cosine distance)
    index('idx_observations_embedding').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
    // GIN index for full-text search
    index('idx_observations_search_vector').using('gin', t.search_vector),
  ],
);

// ============================================================================
// session_summaries (migration 004, UNIQUE removed in 007, prompt_number in 006,
//                    discovery_tokens in 007/011)
//
// Postgres additions:
//   - embedding vector(768) for semantic search
//   - search_vector tsvector (generated) + GIN index for full-text search
//   - HNSW index on embedding with cosine ops
// ============================================================================
export const sessionSummaries = pgTable(
  'session_summaries',
  {
    id: serial('id').primaryKey(),
    memory_session_id: text('memory_session_id')
      .notNull()
      .references(() => sdkSessions.memory_session_id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    project: text('project').notNull(),
    request: text('request'),
    investigated: text('investigated'),
    learned: text('learned'),
    completed: text('completed'),
    next_steps: text('next_steps'),
    files_read: text('files_read'), // JSON array
    files_edited: text('files_edited'), // JSON array
    notes: text('notes'),
    // Prompt tracking (migration 006)
    prompt_number: integer('prompt_number'),
    // ROI metrics (migration 007/011)
    discovery_tokens: integer('discovery_tokens').default(0),
    created_at: text('created_at').notNull(),
    created_at_epoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),

    // --- Postgres-specific columns ---
    embedding: vector('embedding', { dimensions: 768 }),
    search_vector: tsvector('search_vector'),
  },
  (t) => [
    index('idx_session_summaries_sdk_session').on(t.memory_session_id),
    index('idx_session_summaries_project').on(t.project),
    index('idx_session_summaries_created').on(t.created_at_epoch),
    // HNSW index for vector similarity search (cosine distance)
    index('idx_session_summaries_embedding').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
    // GIN index for full-text search
    index('idx_session_summaries_search_vector').using('gin', t.search_vector),
  ],
);

// ============================================================================
// pending_messages (migration 016 + failed_at_epoch from 020)
// ============================================================================
export const pendingMessages = pgTable(
  'pending_messages',
  {
    id: serial('id').primaryKey(),
    session_db_id: integer('session_db_id')
      .notNull()
      .references(() => sdkSessions.id, { onDelete: 'cascade' }),
    content_session_id: text('content_session_id').notNull(),
    message_type: text('message_type', {
      enum: ['observation', 'summarize'],
    }).notNull(),
    tool_name: text('tool_name'),
    tool_input: text('tool_input'),
    tool_response: text('tool_response'),
    cwd: text('cwd'),
    last_user_message: text('last_user_message'),
    last_assistant_message: text('last_assistant_message'),
    prompt_number: integer('prompt_number'),
    status: text('status', {
      enum: ['pending', 'processing', 'processed', 'failed'],
    })
      .notNull()
      .default('pending'),
    retry_count: integer('retry_count').notNull().default(0),
    created_at_epoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
    started_processing_at_epoch: bigint('started_processing_at_epoch', {
      mode: 'number',
    }),
    completed_at_epoch: bigint('completed_at_epoch', { mode: 'number' }),
    // migration 020
    failed_at_epoch: bigint('failed_at_epoch', { mode: 'number' }),
  },
  (t) => [
    index('idx_pending_messages_session').on(t.session_db_id),
    index('idx_pending_messages_status').on(t.status),
    index('idx_pending_messages_claude_session').on(t.content_session_id),
  ],
);

// ============================================================================
// user_prompts (migration 010)
// ============================================================================
export const userPrompts = pgTable(
  'user_prompts',
  {
    id: serial('id').primaryKey(),
    content_session_id: text('content_session_id')
      .notNull()
      .references(() => sdkSessions.content_session_id, { onDelete: 'cascade' }),
    prompt_number: integer('prompt_number').notNull(),
    prompt_text: text('prompt_text').notNull(),
    created_at: text('created_at').notNull(),
    created_at_epoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_user_prompts_claude_session').on(t.content_session_id),
    index('idx_user_prompts_created').on(t.created_at_epoch),
    index('idx_user_prompts_prompt_number').on(t.prompt_number),
    index('idx_user_prompts_lookup').on(t.content_session_id, t.prompt_number),
  ],
);

// ============================================================================
// schema_versions (migration tracking)
// ============================================================================
export const schemaVersions = pgTable('schema_versions', {
  id: serial('id').primaryKey(),
  version: integer('version').unique().notNull(),
  applied_at: text('applied_at').notNull(),
});
