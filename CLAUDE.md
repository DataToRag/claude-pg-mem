# claude-pg-mem

## What This Is

A Postgres-native persistent memory system for Claude Code. Uses Neon Postgres + pgvector for shared memory across Claude Code instances and machines. Installed as a Claude Code plugin with hooks, MCP tools, and an observer agent.

Open source, MIT licensed.

## Package Manager

ALWAYS use pnpm, never npm.

## Architecture

```
Claude Code Session
  ├── Plugin (hooks + MCP registered via .claude-plugin/)
  │   ├── Setup hook → smart-install.js (auto-install native deps)
  │   ├── SessionStart → start worker + inject memory context
  │   ├── UserPromptSubmit → register session
  │   ├── PostToolUse → queue observation
  │   └── Stop → summarize + complete session
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

## CLI

The `claude-pg-mem` CLI handles all setup, configuration, and database operations:

```bash
claude-pg-mem config set <key> <value>   # Set config (shorthand keys supported)
claude-pg-mem config get <key>           # Get config value
claude-pg-mem config list                # List all settings with source
claude-pg-mem db push                    # Create/update cpm_* tables
claude-pg-mem db status                  # Check connection and row counts
claude-pg-mem install                    # Register as Claude Code plugin
claude-pg-mem uninstall                  # Remove plugin registration
claude-pg-mem start/stop/restart/status  # Worker lifecycle
```

## Plugin Structure

```
plugin/
  .claude-plugin/
    plugin.json          # Plugin manifest (name, version, author)
    CLAUDE.md            # Context injected into Claude sessions
  .mcp.json              # MCP server registration (stdio)
  hooks/hooks.json       # Hook definitions (Setup, SessionStart, etc.)
  scripts/
    worker-service.cjs   # Bundled worker + CLI (esbuild, ~365KB)
    mcp-server.cjs       # Bundled MCP server (esbuild, ~341KB)
    smart-install.js     # Auto-installs native deps on first run
  modes/code.json        # Observation type definitions
  package.json           # Native runtime deps (@huggingface/transformers, claude-agent-sdk)
```

## Key Design Decisions

### DB Layer: Neon Postgres + Drizzle ORM
- Schema in `src/services/postgres/schema.ts`
- All tables use `cpm_` prefix (e.g., `cpm_sessions`, `cpm_observations`) to avoid clashing with existing tables
- Schema push via `src/services/postgres/schema-push.ts` (raw SQL, no drizzle-kit dependency at runtime)
- Drizzle ORM for type-safe queries, NOT raw SQL
- `bigint` for epoch timestamps
- `jsonb` for structured data (facts, concepts, files arrays)
- Connection via `@neondatabase/serverless` (HTTP driver, serverless-friendly)

### Embeddings: Nomic Embed Text v1 (local, no API key)
- Runs via `@huggingface/transformers` in Node.js
- 768-dimensional embeddings
- Document prefix: `search_document: `, query prefix: `search_query: `

### Search: pgvector + tsvector
- `embedding vector(768)` columns with HNSW indexes
- `search_vector tsvector` generated columns with GIN indexes
- SearchOrchestrator selects strategy: no query → structured SQL, query text → pgvector semantic or tsvector keyword

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

- `src/services/postgres/` — All database operations (Drizzle queries), schema definition, schema push
- `src/services/worker/` — Observer agent, search orchestrator, response processing
- `src/services/context/` — Context generation pipeline (query → compile → render → markdown)
- `src/services/server/` — Express HTTP routes
- `src/services/infrastructure/` — Process management, health, shutdown
- `src/cli/handlers/` — Hook handlers (HTTP calls to worker)
- `src/cli/adapters/` — Platform-specific stdin normalization
- `src/sdk/` — Prompt templates and XML parser
- `src/embeddings/` — Pluggable embedding providers
- `src/shared/` — Cross-cutting utilities (paths, settings, constants)
- `src/installer/` — Plugin marketplace registration (install/uninstall)
- `plugin/` — Plugin distribution (hooks, scripts, modes, manifest)
- `scripts/` — Build and install scripts

## Code Patterns

### Database functions take `db` as first parameter
```typescript
export async function storeObservation(db: Database, input: ObservationInput, embedding?: number[]) { ... }
```

### Table names use `cpm_` prefix
All Postgres tables are prefixed with `cpm_` to avoid conflicts in shared databases. The Drizzle schema JS variable names remain unprefixed (e.g., `sessions`, `observations`), but the underlying SQL table names are `cpm_sessions`, `cpm_observations`, etc.

### Settings use CLAUDE_PG_MEM_* prefix
All env vars and settings keys use `CLAUDE_PG_MEM_` prefix. The CLI supports shorthand (e.g., `DATABASE_URL` resolves to `CLAUDE_PG_MEM_DATABASE_URL`).
Data directory: `~/.claude-pg-mem`.
Default worker port: 37778.

## What NOT to Change

- SDK prompts and XML schema — observation format compatibility
- Hook lifecycle order — Setup → SessionStart → UserPromptSubmit → PostToolUse → Stop
- Claim-confirm queue pattern — enqueue → claimNextMessage → confirmProcessed
- Progressive disclosure tool pattern — search → timeline → get_observations
- Table name prefix `cpm_` — changing would break existing deployments

## Testing

- `pnpm run lint` — Type check (must pass with zero errors)
- `pnpm run build:plugin` — Build plugin bundles
- `claude-pg-mem db push` — Apply schema to Neon
- `claude-pg-mem db status` — Verify database connection and tables
- `claude-pg-mem start` — Start worker service
- `claude-pg-mem install` — Install as Claude Code plugin
- Test by starting a Claude Code session with the plugin installed

## Environment Variables

Required:
- `CLAUDE_PG_MEM_DATABASE_URL` — Neon Postgres connection string (or set via `claude-pg-mem config set DATABASE_URL`)

Optional:
- `CLAUDE_PG_MEM_WORKER_PORT` — Worker port (default: 37778)
- `CLAUDE_PG_MEM_DATA_DIR` — Data directory (default: ~/.claude-pg-mem)
- `CLAUDE_PG_MEM_LOG_LEVEL` — Log level (default: INFO)
- `CLAUDE_PG_MEM_MAX_CONCURRENT_AGENTS` — Max observer agents (default: 2)
