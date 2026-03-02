# claude-pg-mem

Postgres-native persistent memory for Claude Code. Automatically captures tool usage observations, generates semantic summaries, and makes them searchable across sessions and machines. Built on PostgreSQL with pgvector for semantic search, installed as a Claude Code plugin.

## Quick Start

### Prerequisites

- Node.js >= 22
- A [Neon](https://neon.tech) Postgres database (free tier works)
- Claude Code installed

### Install

```bash
# Clone the repo
git clone https://github.com/DataToRag/claude-pg-mem.git
cd claude-pg-mem

# Install dependencies and build
pnpm install
pnpm run build:plugin

# Link the CLI globally
pnpm link --global
```

### Setup

```bash
# Configure your Neon database URL
claude-pg-mem config set DATABASE_URL "postgres://user:pass@your-neon-host/neon"

# Push the schema (creates cpm_* tables)
claude-pg-mem db push

# Register as a Claude Code plugin
claude-pg-mem install
```

Restart Claude Code to activate the plugin. Hooks and MCP tools will be available automatically. Native dependencies (embeddings model) are auto-installed on first session start.

## CLI

```
claude-pg-mem <command>
```

### Commands

| Command | Description |
|---------|-------------|
| `config set <key> <value>` | Set a configuration value |
| `config get <key>` | Get a configuration value |
| `config list` | List all configuration values |
| `config reset` | Reset all settings to defaults |
| `db push` | Create/update tables and indexes |
| `db status` | Check connection and show table counts |
| `install` | Register as Claude Code plugin |
| `uninstall` | Remove Claude Code plugin |
| `start` | Start the worker service |
| `stop` | Stop the worker service |
| `restart` | Restart the worker service |
| `status` | Show worker status |

Config keys can use shorthand (omit `CLAUDE_PG_MEM_` prefix):

```bash
claude-pg-mem config set DATABASE_URL "postgres://..."
claude-pg-mem config set WORKER_PORT 37778
claude-pg-mem config set LOG_LEVEL DEBUG
```

## How It Works

```
Claude Code Session
    |
    |-- [Setup]           --> smart-install  --> Auto-install native deps
    |-- [SessionStart]    --> context hook   --> Inject memory context
    |-- [UserPromptSubmit]--> session-init   --> Register session
    |-- [PostToolUse]     --> observation    --> Queue tool observation
    |-- [Stop]            --> summarize      --> Generate summary
    |                     --> session-complete --> Close session
    |
    v
Worker Service (HTTP API on :37778)
    |
    |-- Express HTTP endpoints
    |-- Claude Agent SDK (observation processing)
    |-- Neon Postgres (sessions, observations, summaries)
    |-- pgvector (semantic search embeddings)
    |
    v
MCP Server (stdio, spawned by Claude Code)
    |
    |-- search           (compact index, ~50-100 tokens/result)
    |-- timeline         (chronological context)
    |-- get_observations (full details by ID)
```

## MCP Tools

Claude Code connects to claude-pg-mem via MCP for on-demand memory search using a token-efficient 3-layer progressive disclosure pattern:

| Tool | Purpose | Tokens/result |
|------|---------|---------------|
| `search` | Search memory index with filters | ~50-100 |
| `timeline` | Chronological context around results | ~200-500 |
| `get_observations` | Full observation details by ID | ~500-1000 |

**Workflow:** `search` to get IDs, then `timeline` for context, then `get_observations` for details. Roughly 10x token savings compared to fetching full details upfront.

### Search Parameters

- `query` - Semantic search text
- `project` - Filter by project name
- `type` - Filter: observations, sessions, prompts
- `obs_type` - Observation type: bugfix, feature, refactor, discovery, decision, change
- `limit`, `offset` - Pagination
- `dateStart`, `dateEnd` - Date range
- `orderBy` - Sort: date_desc, date_asc, relevance

## Configuration

Settings are stored in `~/.claude-pg-mem/settings.json`. Manage via CLI or edit directly.

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_PG_MEM_DATABASE_URL` | (required) | Neon Postgres connection string |
| `CLAUDE_PG_MEM_WORKER_PORT` | `37778` | Worker HTTP API port |
| `CLAUDE_PG_MEM_WORKER_HOST` | `127.0.0.1` | Worker bind address |
| `CLAUDE_PG_MEM_MODEL` | `claude-sonnet-4-5` | Model for observation processing |
| `CLAUDE_PG_MEM_MODE` | `code` | Active mode (defines observation types) |
| `CLAUDE_PG_MEM_LOG_LEVEL` | `INFO` | Log level: DEBUG, INFO, WARN, ERROR |
| `CLAUDE_PG_MEM_CONTEXT_OBSERVATIONS` | `50` | Max observations in context injection |
| `CLAUDE_PG_MEM_PROVIDER` | `claude` | AI provider: claude, gemini, openrouter |

Priority: environment variables > settings.json > defaults.

## Database

Uses Neon Postgres with the pgvector extension for semantic search. All tables use the `cpm_` prefix to avoid clashing with existing tables.

Tables: `cpm_sessions`, `cpm_sdk_sessions`, `cpm_observations`, `cpm_session_summaries`, `cpm_pending_messages`, `cpm_user_prompts`, `cpm_memories`, `cpm_overviews`, `cpm_diagnostics`, `cpm_transcript_events`, `cpm_schema_versions`

```bash
claude-pg-mem db push      # Create/update tables
claude-pg-mem db status    # Check connection and row counts
```

## Plugin Structure

```
plugin/
  .claude-plugin/
    plugin.json          # Plugin manifest
    CLAUDE.md            # Context injected into Claude sessions
  .mcp.json              # MCP server registration
  hooks/
    hooks.json           # Hook definitions (Setup, SessionStart, etc.)
  scripts/
    worker-service.cjs   # Bundled worker + CLI (esbuild)
    mcp-server.cjs       # Bundled MCP server (esbuild)
    smart-install.js     # Auto-installs native deps on first run
  modes/
    code.json            # Observation type definitions
  package.json           # Native runtime dependencies
```

## Lifecycle Hooks

| Event | Hook | What it does |
|-------|------|-------------|
| Setup | smart-install | Auto-install native dependencies |
| SessionStart | smart-install | Ensure deps are current |
| SessionStart | start | Start worker service |
| SessionStart | context | Inject recent observations into session |
| UserPromptSubmit | session-init | Register or resume a memory session |
| PostToolUse | observation | Queue tool execution for observation processing |
| Stop | summarize | Generate progress summary for the session |
| Stop | session-complete | Mark session as completed |

## Uninstall

```bash
claude-pg-mem uninstall
```

This removes the plugin registration from Claude Code. Your data in `~/.claude-pg-mem/` and database tables are preserved.

## Development

```bash
pnpm install
pnpm run build           # Compile TypeScript
pnpm run build:plugin    # Bundle plugin .cjs files
pnpm run dev             # Watch mode
pnpm run worker:dev      # Start worker with hot reload
pnpm run lint            # Type check
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `pnpm run lint` to check types
5. Submit a Pull Request

## License

MIT
