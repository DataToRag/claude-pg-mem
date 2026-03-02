# claude-pg-memory

Postgres-native persistent memory for Claude Code. Automatically captures tool usage observations, generates semantic summaries, and makes them searchable across sessions and machines. Built on PostgreSQL with pgvector for semantic search, replacing SQLite/ChromaDB with a single shared database that works across instances.

## Quick Start

```bash
# Install
pnpm install claude-pg-memory

# Configure
export DATABASE_URL="postgres://user:pass@host:5432/dbname"
export OPENAI_API_KEY="sk-..."

# Register hooks with Claude Code
npx claude-pg-memory install

# Run database migrations
npx claude-pg-memory db:push

# Start the worker service
npx claude-pg-memory start

# Restart Claude Code to activate hooks
```

## Architecture

```
Claude Code Session
    |
    |-- [SessionStart]    --> context hook     --> Inject memory context
    |-- [UserPromptSubmit]--> session-init     --> Register session
    |-- [PostToolUse]     --> observation hook  --> Queue tool observation
    |-- [Stop]            --> summarize hook    --> Generate summary
    |                     --> session-complete  --> Close session
    |
    v
Worker Service (HTTP API on :37778)
    |
    |-- Express HTTP endpoints
    |-- Claude Agent SDK (observation processing)
    |-- Postgres (sessions, observations, summaries)
    |-- pgvector (semantic search embeddings)
    |
    v
MCP Server (stdio, spawned by Claude Code)
    |
    |-- search         (compact index, ~50-100 tokens/result)
    |-- timeline       (chronological context)
    |-- get_observations (full details by ID)
```

## MCP Tools

Claude Code connects to claude-pg-memory via MCP for on-demand memory search using a token-efficient 3-layer progressive disclosure pattern:

| Tool | Purpose | Tokens/result |
|------|---------|---------------|
| `search` | Search memory index with filters | ~50-100 |
| `timeline` | Chronological context around results | ~200-500 |
| `get_observations` | Full observation details by ID | ~500-1000 |

**Workflow:** `search` to get IDs, then `timeline` for context, then `get_observations` for details. This provides roughly 10x token savings compared to fetching full details upfront.

### Search Parameters

- `query` - Semantic search text
- `project` - Filter by project name
- `type` - Filter: observations, sessions, prompts
- `obs_type` - Observation type: bugfix, feature, refactor, discovery, decision, change
- `limit`, `offset` - Pagination
- `dateStart`, `dateEnd` - Date range
- `orderBy` - Sort: date_desc, date_asc, relevance

## Configuration

Settings are stored in `~/.claude-pg-memory/settings.json` (auto-created on first run).

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_PG_MEMORY_DATABASE_URL` | (required) | Postgres connection string |
| `CLAUDE_PG_MEMORY_WORKER_PORT` | `37778` | Worker HTTP API port |
| `CLAUDE_PG_MEMORY_WORKER_HOST` | `127.0.0.1` | Worker bind address |
| `CLAUDE_PG_MEMORY_MODEL` | `claude-sonnet-4-5` | Model for observation processing |
| `CLAUDE_PG_MEMORY_MODE` | `code` | Active mode (defines observation types) |
| `CLAUDE_PG_MEMORY_LOG_LEVEL` | `INFO` | Log level: DEBUG, INFO, WARN, ERROR |
| `CLAUDE_PG_MEMORY_CONTEXT_OBSERVATIONS` | `50` | Max observations in context injection |
| `CLAUDE_PG_MEMORY_PROVIDER` | `claude` | AI provider: claude, gemini, openrouter |

Environment variables override settings.json values.

### AI Providers

| Provider | Auth | Setting |
|----------|------|---------|
| Claude (default) | CLI subscription or API key | `CLAUDE_PG_MEMORY_CLAUDE_AUTH_METHOD` |
| Gemini | API key | `CLAUDE_PG_MEMORY_GEMINI_API_KEY` |
| OpenRouter | API key | `CLAUDE_PG_MEMORY_OPENROUTER_API_KEY` |

Credentials are stored in `~/.claude-pg-memory/.env` to isolate them from project-level environment files.

## CLI Commands

```bash
npx claude-pg-memory install    # Register hooks with Claude Code
npx claude-pg-memory uninstall  # Remove hooks from Claude Code
npx claude-pg-memory start      # Start the worker service
npx claude-pg-memory stop       # Stop the worker service
npx claude-pg-memory restart    # Restart the worker service
npx claude-pg-memory status     # Show worker status
npx claude-pg-memory mcp        # Start MCP server (stdio)
```

## Lifecycle Hooks

| Event | Hook | What it does |
|-------|------|-------------|
| SessionStart | context | Inject recent observations and summaries into session |
| UserPromptSubmit | session-init | Register or resume a memory session |
| PostToolUse | observation | Queue tool execution for observation processing |
| Stop | summarize | Generate progress summary for the session |
| Stop | session-complete | Mark session as completed |

## Database

Uses PostgreSQL with the pgvector extension for semantic search. Schema is managed by Drizzle ORM.

Tables: `sessions`, `observations`, `summaries`, `prompts`, `pending_messages`

Run migrations with:
```bash
npx claude-pg-memory db:push
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `pnpm run lint` to check types
5. Submit a Pull Request

## Development

```bash
pnpm install
pnpm run build          # Compile TypeScript
pnpm run dev            # Watch mode
pnpm run worker:dev     # Start worker with hot reload
pnpm run db:push        # Push schema to database
pnpm run db:generate    # Generate migration files
```

## License

MIT
