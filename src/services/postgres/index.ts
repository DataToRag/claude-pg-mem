/**
 * Postgres service barrel — re-exports all database operations modules.
 */

// Client and schema
export { getDb, type Database } from './client.js';
export * as schema from './schema.js';

// Types
export * from './types.js';

// Sessions (sessions + sdk_sessions CRUD)
export {
  createSession,
  getSession,
  getRecentSessions,
  createSdkSession,
  getSdkSession,
  getSdkSessionById,
  updateSdkSession,
  updateMemorySessionId,
  completeSdkSession,
  getRecentSessionsWithStatus,
} from './Sessions.js';

// Observations
export {
  computeObservationContentHash,
  findDuplicateObservation,
  storeObservation,
  getObservation,
  getObservationsByIds,
  getObservationsBySession,
  getRecentObservations,
  getObservationsByFile,
  type StoreObservationResult,
} from './Observations.js';

// Summaries
export {
  storeSummary,
  getSummary,
  getSummaryById,
  getRecentSummaries,
  type StoreSummaryResult,
} from './Summaries.js';

// Prompts
export {
  storeUserPrompt,
  getUserPrompts,
  getUserPrompt,
  getPromptCount,
  getLatestUserPrompt,
  getAllRecentUserPrompts,
} from './Prompts.js';

// Timeline
export {
  getTimeline,
  getProjectTimeline,
  getAllProjects,
  type TimelineResult,
} from './Timeline.js';

// PendingMessageStore (work queue)
export {
  enqueue,
  claimNextMessage,
  confirmProcessed,
  markFailed,
  markSessionMessagesFailed,
  markAllSessionMessagesAbandoned,
  resetStaleProcessingMessages,
  resetProcessingToPending,
  getAllPending,
  getPendingCount,
  hasAnyPendingWork,
  getSessionsWithPendingMessages,
  getQueueMessages,
  clearFailed,
  clearAll,
  abortMessage,
  retryMessage,
} from './PendingMessageStore.js';

// SessionSearch (structured, semantic, full-text search)
export {
  searchObservations,
  searchSessions,
  searchUserPrompts,
  findByConcept,
  findByType,
  findByFile,
} from './SessionSearch.js';

// Transactions (cross-domain atomic operations)
export {
  storeObservations,
  storeObservationsAndMarkComplete,
  type StoreObservationsResult,
  type StoreAndMarkCompleteResult,
  type EmbedFn,
} from './transactions.js';
