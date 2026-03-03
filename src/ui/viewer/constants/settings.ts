/**
 * Default settings values for Claude Memory
 * Shared across UI components and hooks
 */
export const DEFAULT_SETTINGS = {
  CLAUDE_PG_MEM_MODEL: 'claude-sonnet-4-5',
  CLAUDE_PG_MEM_CONTEXT_OBSERVATIONS: '50',
  CLAUDE_PG_MEM_WORKER_PORT: '37778',
  CLAUDE_PG_MEM_WORKER_HOST: '127.0.0.1',

  // AI Provider Configuration
  CLAUDE_PG_MEM_PROVIDER: 'claude',
  CLAUDE_PG_MEM_GEMINI_API_KEY: '',
  CLAUDE_PG_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
  CLAUDE_PG_MEM_OPENROUTER_API_KEY: '',
  CLAUDE_PG_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
  CLAUDE_PG_MEM_OPENROUTER_SITE_URL: '',
  CLAUDE_PG_MEM_OPENROUTER_APP_NAME: 'claude-pg-mem',
  CLAUDE_PG_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',

  // Token Economics (all true for backwards compatibility)
  CLAUDE_PG_MEM_CONTEXT_SHOW_READ_TOKENS: 'true',
  CLAUDE_PG_MEM_CONTEXT_SHOW_WORK_TOKENS: 'true',
  CLAUDE_PG_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'true',
  CLAUDE_PG_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',

  // Observation Filtering (all types and concepts)
  CLAUDE_PG_MEM_CONTEXT_OBSERVATION_TYPES: 'bugfix,feature,refactor,discovery,decision,change',
  CLAUDE_PG_MEM_CONTEXT_OBSERVATION_CONCEPTS: 'how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off',

  // Display Configuration
  CLAUDE_PG_MEM_CONTEXT_FULL_COUNT: '5',
  CLAUDE_PG_MEM_CONTEXT_FULL_FIELD: 'narrative',
  CLAUDE_PG_MEM_CONTEXT_SESSION_COUNT: '10',

  // Feature Toggles
  CLAUDE_PG_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
  CLAUDE_PG_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',

  // Exclusion Settings
  CLAUDE_PG_MEM_EXCLUDED_PROJECTS: '',
  CLAUDE_PG_MEM_FOLDER_MD_EXCLUDE: '[]',
} as const;
