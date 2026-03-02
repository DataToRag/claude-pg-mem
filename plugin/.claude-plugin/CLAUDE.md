# claude-pg-mem: Persistent Memory

You have persistent memory across sessions via claude-pg-mem (Postgres + pgvector).

## Memory Tools (MCP)

Use the 3-layer progressive disclosure pattern to efficiently search past work:

1. **search** - Find observations by query, project, type, date (~50-100 tokens/result)
2. **timeline** - Get chronological context around an observation (~200-500 tokens)
3. **get_observations** - Full details for specific IDs (~500-1000 tokens/result)

ALWAYS start with search, then narrow with timeline, then fetch full details. Never skip layers.

## Context Injection

Memory context is automatically injected at session start via hooks. Recent observations and session summaries appear in your initial context.

## Privacy

Content wrapped in `<private>...</private>` tags is stripped before storage. Use this for sensitive information that should not be persisted.
