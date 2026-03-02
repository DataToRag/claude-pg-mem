/**
 * TypeScript types for database query results
 * Provides type safety for Postgres query results
 */

/**
 * Schema information from Postgres information_schema.columns
 */
export interface TableColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  ordinal_position: number;
}

/**
 * Index information from Postgres pg_indexes
 */
export interface IndexInfo {
  indexname: string;
  indexdef: string;
  tablename: string;
}

/**
 * Table name from Postgres information_schema.tables
 */
export interface TableNameRow {
  table_name: string;
}

/**
 * Schema version record
 */
export interface SchemaVersion {
  version: number;
}

/**
 * SDK Session database record
 */
export interface SdkSessionRecord {
  id: number;
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  user_prompt: string | null;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: 'active' | 'completed' | 'failed';
  worker_port?: number;
  prompt_counter?: number;
}

/**
 * Observation database record
 */
export interface ObservationRecord {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  created_at: string;
  created_at_epoch: number;
  title?: string;
  concept?: string;
  source_files?: string;
  prompt_number?: number;
  discovery_tokens?: number;
}

/**
 * Session Summary database record
 */
export interface SessionSummaryRecord {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: string;
  created_at_epoch: number;
  prompt_number?: number;
  discovery_tokens?: number;
}

/**
 * User Prompt database record
 */
export interface UserPromptRecord {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  project?: string;  // From JOIN with sdk_sessions
  created_at: string;
  created_at_epoch: number;
}

/**
 * Latest user prompt with session join
 */
export interface LatestPromptResult {
  id: number;
  content_session_id: string;
  memory_session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

/**
 * Observation with context (for time-based queries)
 */
export interface ObservationWithContext {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  created_at: string;
  created_at_epoch: number;
  title?: string;
  concept?: string;
  source_files?: string;
  prompt_number?: number;
  discovery_tokens?: number;
}
