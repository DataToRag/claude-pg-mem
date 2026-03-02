/**
 * SearchStrategy - Interface for search strategy implementations
 *
 * Each strategy implements a different approach to searching:
 * - PgVectorSearchStrategy: Vector-based semantic search via pgvector
 * - StructuredSearchStrategy: Direct Drizzle ORM queries for filter-only searches
 */

import type { SearchResults, StrategySearchOptions, StrategySearchResult } from '../types.js';

/**
 * Base interface for all search strategies
 */
export interface SearchStrategy {
  /**
   * Execute a search with the given options
   * @param options Search options including query and filters
   * @returns Promise resolving to categorized search results
   */
  search(options: StrategySearchOptions): Promise<StrategySearchResult>;

  /**
   * Check if this strategy can handle the given search options
   * @param options Search options to evaluate
   * @returns true if this strategy can handle the search
   */
  canHandle(options: StrategySearchOptions): boolean;

  /**
   * Strategy name for logging and debugging
   */
  readonly name: string;
}

/**
 * Abstract base class providing common functionality for strategies
 */
export abstract class BaseSearchStrategy implements SearchStrategy {
  abstract readonly name: string;

  abstract search(options: StrategySearchOptions): Promise<StrategySearchResult>;
  abstract canHandle(options: StrategySearchOptions): boolean;

  /**
   * Create an empty search result
   */
  protected emptyResult(
    strategy: 'pgvector' | 'structured' | 'hybrid',
  ): StrategySearchResult {
    return {
      results: {
        observations: [],
        sessions: [],
        prompts: [],
      },
      usedVector: strategy === 'pgvector' || strategy === 'hybrid',
      fellBack: false,
      strategy,
    };
  }
}
