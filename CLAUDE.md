# claude-pg-memory

## What This Is

A Postgres-native persistent memory system for Claude Code. A faithful port of [claude-mem](https://github.com/thedotmack/claude-mem) replacing SQLite/ChromaDB with Neon Postgres/pgvector. Enables shared memory across Claude Code instances and machines via a remote database.

Open source, MIT licensed.

## Package Manager

ALWAYS use pnpm, never npm.

## Architecture

```
Claude Code Session
  ├── Hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop)
  │   └── HTTP POST to local worker service
  ├── MCP Server (stdio, spawned by Claude Code)
  │   └── HTTP GET/POST to local worker service
  └── Observer Agent (background Claude subprocess via @anthropic-ai/claude-agent-sdk)
      └── Analyzes tool outputs → structured XML observations

Worker Service (Express on localhost:37778)
  ├── Routes: /api/context/inject, /api/sessions/*, /api/search, /api/timeline
  ├── SessionManager: active session state, observer agent lifecycle
  ├── PendingMessageStore: claim-confirm work queue
  └── Neon Postgres (remote)
      ├── pgvector embeddings (HNSW index, cosine distance)
      └── tsvector full-text search (GIN index)
```

## Key Design Decisions

### DB Layer: Neon Postgres + Drizzle ORM
- Schema in `src/services/postgres/schema.ts` — all 11 tables ported from claude-mem's 7 SQLite migrations
- Drizzle ORM for type-safe queries, NOT raw SQL
- `bigint` for epoch timestamps (compatibility with claude-mem's epoch-based queries)
- `jsonb` for structured data (facts, concepts, files arrays)
- Connection via `@neondatabase/serverless` (HTTP driver, serverless-friendly)

### Embeddings: Nomic Embed Text v1 (local, no API key)
- Same approach as claude-mem (local sentence-transformers model via ChromaDB)
- Runs via `@huggingface/transformers` in Node.js
- 768-dimensional embeddings
- Document prefix: `search_document: `, query prefix: `search_query: `

### Search: pgvector + tsvector (replaces ChromaDB + FTS5)
- `embedding vector(768)` columns on observations + session_summaries with HNSW indexes
- `search_vector tsvector` generated columns with GIN indexes
- SearchOrchestrator selects strategy: no query → structured SQL, query text → pgvector semantic or tsvector keyword
- Embeddings generated via pluggable `EmbedFn` callback, default: Nomic Embed Text v1 (local)

### Observer Agent
- Uses `@anthropic-ai/claude-agent-sdk` to spawn background Claude subprocess
- Observer has NO tools — read-only, generates XML observations
- Uses the user's existing Claude Code subscription (no separate API key)
- Max 2 concurrent observers (configurable)
- Claim-confirm queue pattern prevents message loss on crashes

### Hook System
- Hooks are HTTP-only — they POST to the worker, never import DB code directly
- All hooks exit 0 on failure (graceful degradation, never block the user)
- Privacy filtering: `<private>` tags strip content before storage
- Platform adapters: claude-code, cursor, raw

### Progressive Disclosure (Token Efficiency)
- `search` tool → compact index (~50-100 tokens/result)
- `timeline` tool → chronological context (~200-500 tokens)
- `get_observations` tool → full details (~500-1000 tokens/result)

## File Structure Conventions

- `src/services/postgres/` — All database operations (Drizzle queries)
- `src/services/worker/` — Observer agent, search orchestrator, response processing
- `src/services/context/` — Context generation pipeline (query → compile → render → markdown)
- `src/services/server/` — Express HTTP routes
- `src/services/infrastructure/` — Process management, health, shutdown
- `src/cli/handlers/` — Hook handlers (HTTP calls to worker)
- `src/cli/adapters/` — Platform-specific stdin normalization
- `src/sdk/` — Prompt templates and XML parser (identical to claude-mem)
- `src/embeddings/` — Pluggable embedding providers
- `src/shared/` — Cross-cutting utilities (paths, settings, constants)
- `plugin/` — Hook registration config, mode configs

## Code Patterns

### Database functions take `db` as first parameter
```typescript
export async function storeObservation(db: Database, input: ObservationInput, embedding?: number[]) { ... }
```

### Settings use CLAUDE_PG_MEMORY_* prefix
All env vars and settings keys use `CLAUDE_PG_MEMORY_` prefix (not `CLAUDE_MEM_`).
Data directory: `~/.claude-pg-memory` (not `~/.claude-mem`).
Default worker port: 37778 (not 37777, avoids collision with claude-mem).

### Naming: claude-mem → claude-pg-memory
All references updated. If you see `claude-mem` or `CLAUDE_MEM_` in the code, it's a bug (except in comments explaining the port origin).

## What NOT to Change

- SDK prompts and XML schema — must stay identical to claude-mem for observation format compatibility
- Hook lifecycle order — SessionStart → UserPromptSubmit → PostToolUse → Stop (summarize then complete)
- Claim-confirm queue pattern — enqueue → claimNextMessage → confirmProcessed (prevents message loss)
- Progressive disclosure tool pattern — search → timeline → get_observations (token efficiency)

## Testing

- `npx tsc --noEmit` — Type check (must pass with zero errors)
- `pnpm run db:push` — Apply schema to Neon
- `pnpm run worker:start` — Start worker service
- Test hooks by starting a Claude Code session with the plugin installed

## Environment Variables

Required:
- `DATABASE_URL` — Neon Postgres connection string

Optional:
- `CLAUDE_PG_MEMORY_PORT` — Worker port (default: 37778)
- `CLAUDE_PG_MEMORY_DATA_DIR` — Data directory (default: ~/.claude-pg-memory)
- `CLAUDE_PG_MEMORY_LOG_LEVEL` — Log level (default: info)
- `CLAUDE_PG_MEMORY_MAX_CONCURRENT_AGENTS` — Max observer agents (default: 2)
