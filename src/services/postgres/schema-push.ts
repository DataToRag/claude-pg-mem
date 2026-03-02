/**
 * Schema Push - creates all tables and indexes via raw SQL.
 *
 * Uses the Neon serverless driver directly (no drizzle-kit dependency).
 * All statements use IF NOT EXISTS for idempotency.
 * All tables use the `cpm_` prefix to avoid clashing with existing tables.
 */

import { neon } from '@neondatabase/serverless';

/**
 * Push the full schema to the database.
 * @param databaseUrl - Postgres connection string
 */
export async function pushSchema(databaseUrl: string): Promise<void> {
  const sql = neon(databaseUrl);

  // Enable pgvector extension
  console.log('  Enabling pgvector extension...');
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

  // cpm_sessions
  console.log('  Creating table: cpm_sessions');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_sessions (
      id SERIAL PRIMARY KEY,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch BIGINT NOT NULL,
      source TEXT NOT NULL DEFAULT 'compress',
      archive_path TEXT,
      archive_bytes INTEGER,
      archive_checksum TEXT,
      archived_at TEXT,
      metadata_json TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_sessions_project ON cpm_sessions (project)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_sessions_created_at ON cpm_sessions (created_at_epoch)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_sessions_project_created ON cpm_sessions (project, created_at_epoch)`;

  // cpm_memories
  console.log('  Creating table: cpm_memories');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_memories (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES cpm_sessions(session_id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      document_id TEXT UNIQUE,
      keywords TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch BIGINT NOT NULL,
      project TEXT NOT NULL,
      archive_basename TEXT,
      origin TEXT NOT NULL DEFAULT 'transcript',
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      concepts TEXT,
      files_touched TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_memories_session ON cpm_memories (session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_memories_project ON cpm_memories (project)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_memories_created_at ON cpm_memories (created_at_epoch)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_memories_project_created ON cpm_memories (project, created_at_epoch)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_memories_document_id ON cpm_memories (document_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_memories_origin ON cpm_memories (origin)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_memories_title ON cpm_memories (title)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_memories_concepts ON cpm_memories (concepts)`;

  // cpm_overviews
  console.log('  Creating table: cpm_overviews');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_overviews (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES cpm_sessions(session_id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch BIGINT NOT NULL,
      project TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'claude'
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_overviews_session ON cpm_overviews (session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_overviews_project ON cpm_overviews (project)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_overviews_created_at ON cpm_overviews (created_at_epoch)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_cpm_overviews_project_latest ON cpm_overviews (project, created_at_epoch)`;

  // cpm_diagnostics
  console.log('  Creating table: cpm_diagnostics');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_diagnostics (
      id SERIAL PRIMARY KEY,
      session_id TEXT REFERENCES cpm_sessions(session_id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      created_at TEXT NOT NULL,
      created_at_epoch BIGINT NOT NULL,
      project TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'system'
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_diagnostics_session ON cpm_diagnostics (session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_diagnostics_project ON cpm_diagnostics (project)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_diagnostics_severity ON cpm_diagnostics (severity)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_diagnostics_created ON cpm_diagnostics (created_at_epoch)`;

  // cpm_transcript_events
  console.log('  Creating table: cpm_transcript_events');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_transcript_events (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES cpm_sessions(session_id) ON DELETE CASCADE,
      project TEXT,
      event_index INTEGER NOT NULL,
      event_type TEXT,
      raw_json TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      captured_at_epoch BIGINT NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_cpm_transcript_events_unique ON cpm_transcript_events (session_id, event_index)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_transcript_events_session ON cpm_transcript_events (session_id, event_index)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_transcript_events_project ON cpm_transcript_events (project)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_transcript_events_type ON cpm_transcript_events (event_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_transcript_events_captured ON cpm_transcript_events (captured_at_epoch)`;

  // cpm_sdk_sessions
  console.log('  Creating table: cpm_sdk_sessions');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_sdk_sessions (
      id SERIAL PRIMARY KEY,
      content_session_id TEXT UNIQUE NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch BIGINT NOT NULL,
      completed_at TEXT,
      completed_at_epoch BIGINT,
      status TEXT NOT NULL DEFAULT 'active',
      worker_port INTEGER,
      prompt_counter INTEGER DEFAULT 0,
      custom_title TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_sdk_sessions_claude_id ON cpm_sdk_sessions (content_session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_sdk_sessions_sdk_id ON cpm_sdk_sessions (memory_session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_sdk_sessions_project ON cpm_sdk_sessions (project)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_sdk_sessions_status ON cpm_sdk_sessions (status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_sdk_sessions_started ON cpm_sdk_sessions (started_at_epoch)`;

  // cpm_observations (with pgvector)
  console.log('  Creating table: cpm_observations');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_observations (
      id SERIAL PRIMARY KEY,
      memory_session_id TEXT NOT NULL REFERENCES cpm_sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch BIGINT NOT NULL,
      embedding vector(768),
      search_vector tsvector
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_observations_sdk_session ON cpm_observations (memory_session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_observations_project ON cpm_observations (project)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_observations_type ON cpm_observations (type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_observations_created ON cpm_observations (created_at_epoch)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_observations_content_hash ON cpm_observations (content_hash, created_at_epoch)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_observations_embedding ON cpm_observations USING hnsw (embedding vector_cosine_ops)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_observations_search_vector ON cpm_observations USING gin (search_vector)`;

  // cpm_session_summaries (with pgvector)
  console.log('  Creating table: cpm_session_summaries');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_session_summaries (
      id SERIAL PRIMARY KEY,
      memory_session_id TEXT NOT NULL REFERENCES cpm_sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch BIGINT NOT NULL,
      embedding vector(768),
      search_vector tsvector
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_session_summaries_sdk_session ON cpm_session_summaries (memory_session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_session_summaries_project ON cpm_session_summaries (project)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_session_summaries_created ON cpm_session_summaries (created_at_epoch)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_session_summaries_embedding ON cpm_session_summaries USING hnsw (embedding vector_cosine_ops)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_session_summaries_search_vector ON cpm_session_summaries USING gin (search_vector)`;

  // cpm_pending_messages
  console.log('  Creating table: cpm_pending_messages');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_pending_messages (
      id SERIAL PRIMARY KEY,
      session_db_id INTEGER NOT NULL REFERENCES cpm_sdk_sessions(id) ON DELETE CASCADE,
      content_session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      tool_name TEXT,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      last_user_message TEXT,
      last_assistant_message TEXT,
      prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at_epoch BIGINT NOT NULL,
      started_processing_at_epoch BIGINT,
      completed_at_epoch BIGINT,
      failed_at_epoch BIGINT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_pending_messages_session ON cpm_pending_messages (session_db_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_pending_messages_status ON cpm_pending_messages (status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_pending_messages_claude_session ON cpm_pending_messages (content_session_id)`;

  // cpm_user_prompts
  console.log('  Creating table: cpm_user_prompts');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_user_prompts (
      id SERIAL PRIMARY KEY,
      content_session_id TEXT NOT NULL REFERENCES cpm_sdk_sessions(content_session_id) ON DELETE CASCADE,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_user_prompts_claude_session ON cpm_user_prompts (content_session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_user_prompts_created ON cpm_user_prompts (created_at_epoch)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_user_prompts_prompt_number ON cpm_user_prompts (prompt_number)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cpm_user_prompts_lookup ON cpm_user_prompts (content_session_id, prompt_number)`;

  // cpm_schema_versions
  console.log('  Creating table: cpm_schema_versions');
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_schema_versions (
      id SERIAL PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `;
}

/**
 * Check database connectivity and return table counts.
 */
export async function getDbStatus(databaseUrl: string): Promise<{
  connected: boolean;
  tables: { name: string; count: number }[];
  error?: string;
}> {
  try {
    const sql = neon(databaseUrl);
    const expectedTables = [
      'cpm_sessions', 'cpm_memories', 'cpm_overviews', 'cpm_diagnostics',
      'cpm_transcript_events', 'cpm_sdk_sessions', 'cpm_observations',
      'cpm_session_summaries', 'cpm_pending_messages', 'cpm_user_prompts',
      'cpm_schema_versions',
    ];

    // Get existing tables
    const existingTables = await sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    const existingSet = new Set(existingTables.map((r: Record<string, unknown>) => r.tablename as string));

    const tables: { name: string; count: number }[] = [];
    for (const name of expectedTables) {
      if (existingSet.has(name)) {
        const result = await sql`
          SELECT GREATEST(c.reltuples::bigint, 0)::int as count
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ${name}
        `;
        tables.push({ name, count: (result[0]?.count as number) ?? 0 });
      } else {
        tables.push({ name, count: -1 });
      }
    }

    return { connected: true, tables };
  } catch (error) {
    return {
      connected: false,
      tables: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
