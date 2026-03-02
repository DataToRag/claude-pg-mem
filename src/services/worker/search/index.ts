/**
 * Search Module - Named exports for search functionality
 *
 * This is the public API for the search module.
 */

// Main orchestrator
export { SearchOrchestrator } from './SearchOrchestrator.js';

// Strategies
export type { SearchStrategy } from './strategies/SearchStrategy.js';
export { BaseSearchStrategy } from './strategies/SearchStrategy.js';
export { PgVectorSearchStrategy } from './strategies/PgVectorSearchStrategy.js';
export { StructuredSearchStrategy } from './strategies/StructuredSearchStrategy.js';

// Types
export * from './types.js';
