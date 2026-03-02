/**
 * Database entity types for Postgres storage.
 *
 * Ported from claude-mem's src/services/sqlite/types.ts.
 * Interface names and structure are preserved for compatibility.
 *
 * Key differences from SQLite version:
 *   - JSON fields (facts, concepts, files_*) are already parsed by Postgres/jsonb
 *     driver, so consumers don't need JSON.parse().  We type them as string here
 *     to stay compatible with the existing claude-mem code that stores JSON-encoded
 *     strings in TEXT columns. If you later switch columns to native jsonb, update
 *     these types to string[] etc.
 *   - Embedding columns (number[] | null) are Postgres-only additions.
 *   - search_vector (string | null) is Postgres-only for tsvector.
 */

// ---------------------------------------------------------------------------
// Row types — what you get back from SELECT queries
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: number;
  session_id: string;
  project: string;
  created_at: string;
  created_at_epoch: number;
  source: 'compress' | 'save' | 'legacy-jsonl';
  archive_path: string | null;
  archive_bytes: number | null;
  archive_checksum: string | null;
  archived_at: string | null;
  metadata_json: string | null;
}

export interface OverviewRow {
  id: number;
  session_id: string;
  content: string;
  created_at: string;
  created_at_epoch: number;
  project: string;
  origin: string;
}

export interface MemoryRow {
  id: number;
  session_id: string;
  text: string;
  document_id: string | null;
  keywords: string | null;
  created_at: string;
  created_at_epoch: number;
  project: string;
  archive_basename: string | null;
  origin: string;
  // Hierarchical memory fields (v2)
  title: string | null;
  subtitle: string | null;
  facts: string | null; // JSON array of fact strings
  concepts: string | null; // JSON array of concept strings
  files_touched: string | null; // JSON array of file paths
}

export interface DiagnosticRow {
  id: number;
  session_id: string | null;
  message: string;
  severity: 'info' | 'warn' | 'error';
  created_at: string;
  created_at_epoch: number;
  project: string;
  origin: string;
}

export interface TranscriptEventRow {
  id: number;
  session_id: string;
  project: string | null;
  event_index: number;
  event_type: string | null;
  raw_json: string;
  captured_at: string;
  captured_at_epoch: number;
}

// ---------------------------------------------------------------------------
// SDK Hooks Database Types
// ---------------------------------------------------------------------------

export interface SDKSessionRow {
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
  worker_port: number | null;
  prompt_counter: number | null;
  custom_title: string | null;
}

export interface ObservationRow {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  title: string | null;
  subtitle: string | null;
  facts: string | null; // JSON array
  narrative: string | null;
  concepts: string | null; // JSON array
  files_read: string | null; // JSON array
  files_modified: string | null; // JSON array
  prompt_number: number | null;
  discovery_tokens: number; // ROI metrics: tokens spent discovering this observation
  content_hash: string | null;
  created_at: string;
  created_at_epoch: number;
  // Postgres-only
  embedding: number[] | null;
  search_vector: string | null;
}

export interface SessionSummaryRow {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null; // JSON array
  files_edited: string | null; // JSON array
  notes: string | null;
  prompt_number: number | null;
  discovery_tokens: number; // ROI metrics: cumulative tokens spent in this session
  created_at: string;
  created_at_epoch: number;
  // Postgres-only
  embedding: number[] | null;
  search_vector: string | null;
}

export interface UserPromptRow {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

export interface PendingMessageRow {
  id: number;
  session_db_id: number;
  content_session_id: string;
  message_type: 'observation' | 'summarize';
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_user_message: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  status: 'pending' | 'processing' | 'processed' | 'failed';
  retry_count: number;
  created_at_epoch: number;
  started_processing_at_epoch: number | null;
  completed_at_epoch: number | null;
  failed_at_epoch: number | null;
}

export interface SchemaVersionRow {
  id: number;
  version: number;
  applied_at: string;
}

// ---------------------------------------------------------------------------
// Input types — for creating new records (without id and auto-generated fields)
// ---------------------------------------------------------------------------

export interface SessionInput {
  session_id: string;
  project: string;
  created_at: string;
  source?: 'compress' | 'save' | 'legacy-jsonl';
  archive_path?: string;
  archive_bytes?: number;
  archive_checksum?: string;
  archived_at?: string;
  metadata_json?: string;
}

export interface OverviewInput {
  session_id: string;
  content: string;
  created_at: string;
  project: string;
  origin?: string;
}

export interface MemoryInput {
  session_id: string;
  text: string;
  document_id?: string;
  keywords?: string;
  created_at: string;
  project: string;
  archive_basename?: string;
  origin?: string;
  // Hierarchical memory fields (v2)
  title?: string;
  subtitle?: string;
  facts?: string; // JSON array of fact strings
  concepts?: string; // JSON array of concept strings
  files_touched?: string; // JSON array of file paths
}

export interface DiagnosticInput {
  session_id?: string;
  message: string;
  severity?: 'info' | 'warn' | 'error';
  created_at: string;
  project: string;
  origin?: string;
}

export interface TranscriptEventInput {
  session_id: string;
  project?: string;
  event_index: number;
  event_type?: string;
  raw_json: string;
  captured_at?: string | Date | number;
}

export interface ObservationInput {
  memory_session_id: string;
  project: string;
  text?: string;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  title?: string;
  subtitle?: string;
  facts?: string;
  narrative?: string;
  concepts?: string;
  files_read?: string;
  files_modified?: string;
  prompt_number?: number;
  discovery_tokens?: number;
  content_hash?: string;
  created_at: string;
  embedding?: number[];
}

export interface SessionSummaryInput {
  memory_session_id: string;
  project: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
  files_read?: string;
  files_edited?: string;
  notes?: string;
  prompt_number?: number;
  discovery_tokens?: number;
  created_at: string;
  embedding?: number[];
}

export interface UserPromptInput {
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
}

export interface PendingMessageInput {
  session_db_id: number;
  content_session_id: string;
  message_type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: string;
  tool_response?: string;
  cwd?: string;
  last_user_message?: string;
  last_assistant_message?: string;
  prompt_number?: number;
}

// ---------------------------------------------------------------------------
// Search and Filter Types
// ---------------------------------------------------------------------------

export interface DateRange {
  start?: string | number; // ISO string or epoch
  end?: string | number; // ISO string or epoch
}

export interface SearchFilters {
  project?: string;
  type?: ObservationRow['type'] | ObservationRow['type'][];
  concepts?: string | string[];
  files?: string | string[];
  dateRange?: DateRange;
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  offset?: number;
  orderBy?: 'relevance' | 'date_desc' | 'date_asc';
  /** When true, treats filePath as a folder and only matches direct children (not descendants) */
  isFolder?: boolean;
}

export interface ObservationSearchResult extends ObservationRow {
  rank?: number; // tsvector relevance score (lower is better)
  score?: number; // Normalized score (higher is better, 0-1)
}

export interface SessionSummarySearchResult extends SessionSummaryRow {
  rank?: number;
  score?: number;
}

export interface UserPromptSearchResult extends UserPromptRow {
  rank?: number;
  score?: number;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Helper function to normalize timestamps from various formats.
 * Unchanged from the SQLite version.
 */
export function normalizeTimestamp(
  timestamp: string | Date | number | undefined,
): { isoString: string; epoch: number } {
  let date: Date;

  if (!timestamp) {
    date = new Date();
  } else if (timestamp instanceof Date) {
    date = timestamp;
  } else if (typeof timestamp === 'number') {
    date = new Date(timestamp);
  } else if (typeof timestamp === 'string') {
    if (!timestamp.trim()) {
      date = new Date();
    } else {
      date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        const cleaned = timestamp.replace(/\s+/g, 'T').replace(/T+/g, 'T');
        date = new Date(cleaned);
        if (isNaN(date.getTime())) {
          date = new Date();
        }
      }
    }
  } else {
    date = new Date();
  }

  return {
    isoString: date.toISOString(),
    epoch: date.getTime(),
  };
}
