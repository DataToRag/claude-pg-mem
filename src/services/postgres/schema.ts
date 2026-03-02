/**
 * Drizzle ORM schema for Postgres — ported from claude-mem's SQLite migrations.
 *
 * All tables use the `cpm_` prefix (claude-pg-mem) to avoid clashing
 * with existing tables in shared databases.
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
// cpm_sessions
// ============================================================================
export const sessions = pgTable(
  'cpm_sessions',
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
    index('idx_cpm_sessions_project').on(t.project),
    index('idx_cpm_sessions_created_at').on(t.created_at_epoch),
    index('idx_cpm_sessions_project_created').on(t.project, t.created_at_epoch),
  ],
);

// ============================================================================
// cpm_memories
// ============================================================================
export const memories = pgTable(
  'cpm_memories',
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
    title: text('title'),
    subtitle: text('subtitle'),
    facts: text('facts'),
    concepts: text('concepts'),
    files_touched: text('files_touched'),
  },
  (t) => [
    index('idx_cpm_memories_session').on(t.session_id),
    index('idx_cpm_memories_project').on(t.project),
    index('idx_cpm_memories_created_at').on(t.created_at_epoch),
    index('idx_cpm_memories_project_created').on(t.project, t.created_at_epoch),
    index('idx_cpm_memories_document_id').on(t.document_id),
    index('idx_cpm_memories_origin').on(t.origin),
    index('idx_cpm_memories_title').on(t.title),
    index('idx_cpm_memories_concepts').on(t.concepts),
  ],
);

// ============================================================================
// cpm_overviews
// ============================================================================
export const overviews = pgTable(
  'cpm_overviews',
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
    index('idx_cpm_overviews_session').on(t.session_id),
    index('idx_cpm_overviews_project').on(t.project),
    index('idx_cpm_overviews_created_at').on(t.created_at_epoch),
    uniqueIndex('idx_cpm_overviews_project_latest').on(t.project, t.created_at_epoch),
  ],
);

// ============================================================================
// cpm_diagnostics
// ============================================================================
export const diagnostics = pgTable(
  'cpm_diagnostics',
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
    index('idx_cpm_diagnostics_session').on(t.session_id),
    index('idx_cpm_diagnostics_project').on(t.project),
    index('idx_cpm_diagnostics_severity').on(t.severity),
    index('idx_cpm_diagnostics_created').on(t.created_at_epoch),
  ],
);

// ============================================================================
// cpm_transcript_events
// ============================================================================
export const transcriptEvents = pgTable(
  'cpm_transcript_events',
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
    uniqueIndex('idx_cpm_transcript_events_unique').on(t.session_id, t.event_index),
    index('idx_cpm_transcript_events_session').on(t.session_id, t.event_index),
    index('idx_cpm_transcript_events_project').on(t.project),
    index('idx_cpm_transcript_events_type').on(t.event_type),
    index('idx_cpm_transcript_events_captured').on(t.captured_at_epoch),
  ],
);

// ============================================================================
// cpm_sdk_sessions
// ============================================================================
export const sdkSessions = pgTable(
  'cpm_sdk_sessions',
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
    worker_port: integer('worker_port'),
    prompt_counter: integer('prompt_counter').default(0),
    custom_title: text('custom_title'),
  },
  (t) => [
    index('idx_cpm_sdk_sessions_claude_id').on(t.content_session_id),
    index('idx_cpm_sdk_sessions_sdk_id').on(t.memory_session_id),
    index('idx_cpm_sdk_sessions_project').on(t.project),
    index('idx_cpm_sdk_sessions_status').on(t.status),
    index('idx_cpm_sdk_sessions_started').on(t.started_at_epoch),
  ],
);

// ============================================================================
// cpm_observations (with pgvector)
// ============================================================================
export const observations = pgTable(
  'cpm_observations',
  {
    id: serial('id').primaryKey(),
    memory_session_id: text('memory_session_id')
      .notNull()
      .references(() => sdkSessions.memory_session_id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    project: text('project').notNull(),
    text: text('text'),
    type: text('type').notNull(),
    title: text('title'),
    subtitle: text('subtitle'),
    facts: text('facts'),
    narrative: text('narrative'),
    concepts: text('concepts'),
    files_read: text('files_read'),
    files_modified: text('files_modified'),
    prompt_number: integer('prompt_number'),
    discovery_tokens: integer('discovery_tokens').default(0),
    content_hash: text('content_hash'),
    created_at: text('created_at').notNull(),
    created_at_epoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
    embedding: vector('embedding', { dimensions: 768 }),
    search_vector: tsvector('search_vector'),
  },
  (t) => [
    index('idx_cpm_observations_sdk_session').on(t.memory_session_id),
    index('idx_cpm_observations_project').on(t.project),
    index('idx_cpm_observations_type').on(t.type),
    index('idx_cpm_observations_created').on(t.created_at_epoch),
    index('idx_cpm_observations_content_hash').on(t.content_hash, t.created_at_epoch),
    index('idx_cpm_observations_embedding').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
    index('idx_cpm_observations_search_vector').using('gin', t.search_vector),
  ],
);

// ============================================================================
// cpm_session_summaries (with pgvector)
// ============================================================================
export const sessionSummaries = pgTable(
  'cpm_session_summaries',
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
    files_read: text('files_read'),
    files_edited: text('files_edited'),
    notes: text('notes'),
    prompt_number: integer('prompt_number'),
    discovery_tokens: integer('discovery_tokens').default(0),
    created_at: text('created_at').notNull(),
    created_at_epoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
    embedding: vector('embedding', { dimensions: 768 }),
    search_vector: tsvector('search_vector'),
  },
  (t) => [
    index('idx_cpm_session_summaries_sdk_session').on(t.memory_session_id),
    index('idx_cpm_session_summaries_project').on(t.project),
    index('idx_cpm_session_summaries_created').on(t.created_at_epoch),
    index('idx_cpm_session_summaries_embedding').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
    index('idx_cpm_session_summaries_search_vector').using('gin', t.search_vector),
  ],
);

// ============================================================================
// cpm_pending_messages
// ============================================================================
export const pendingMessages = pgTable(
  'cpm_pending_messages',
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
    failed_at_epoch: bigint('failed_at_epoch', { mode: 'number' }),
  },
  (t) => [
    index('idx_cpm_pending_messages_session').on(t.session_db_id),
    index('idx_cpm_pending_messages_status').on(t.status),
    index('idx_cpm_pending_messages_claude_session').on(t.content_session_id),
  ],
);

// ============================================================================
// cpm_user_prompts
// ============================================================================
export const userPrompts = pgTable(
  'cpm_user_prompts',
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
    index('idx_cpm_user_prompts_claude_session').on(t.content_session_id),
    index('idx_cpm_user_prompts_created').on(t.created_at_epoch),
    index('idx_cpm_user_prompts_prompt_number').on(t.prompt_number),
    index('idx_cpm_user_prompts_lookup').on(t.content_session_id, t.prompt_number),
  ],
);

// ============================================================================
// cpm_schema_versions
// ============================================================================
export const schemaVersions = pgTable('cpm_schema_versions', {
  id: serial('id').primaryKey(),
  version: integer('version').unique().notNull(),
  applied_at: text('applied_at').notNull(),
});
