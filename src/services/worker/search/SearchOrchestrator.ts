/**
 * SearchOrchestrator - Coordinates search strategies and handles fallback logic
 *
 * This is the main entry point for search operations. It:
 * 1. Normalizes input parameters
 * 2. Selects the appropriate strategy (pgvector vs structured)
 * 3. Executes the search
 * 4. Handles fallbacks on failure
 *
 * Ported from claude-mem — replaced Chroma/SQLite with PgVector/Structured.
 */

import { PgVectorSearchStrategy } from './strategies/PgVectorSearchStrategy.js';
import { StructuredSearchStrategy } from './strategies/StructuredSearchStrategy.js';

import type {
  StrategySearchOptions,
  StrategySearchResult,
} from './types.js';
import { logger } from '../../../utils/logger.js';
import type { Database } from '../../postgres/client.js';
import type { EmbedFn } from '../../../embeddings/index.js';

/**
 * Normalized parameters from URL-friendly format
 */
interface NormalizedParams extends StrategySearchOptions {
  concepts?: string[];
  files?: string[];
  obsType?: string[];
}

export class SearchOrchestrator {
  private pgVectorStrategy: PgVectorSearchStrategy | null = null;
  private structuredStrategy: StructuredSearchStrategy;

  constructor(
    private db: Database,
    embedFn?: EmbedFn,
  ) {
    // Initialize strategies
    this.structuredStrategy = new StructuredSearchStrategy(db);

    if (embedFn) {
      this.pgVectorStrategy = new PgVectorSearchStrategy(db, embedFn);
    }
  }

  /**
   * Main search entry point
   */
  async search(args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    // Decision tree for strategy selection
    return await this.executeWithFallback(options);
  }

  /**
   * Execute search with fallback logic
   */
  private async executeWithFallback(
    options: NormalizedParams,
  ): Promise<StrategySearchResult> {
    // PATH 1: FILTER-ONLY (no query text) - Use Structured
    if (!options.query) {
      logger.debug('SYSTEM', 'Orchestrator: Filter-only query, using Structured', {});
      return await this.structuredStrategy.search(options);
    }

    // PATH 2: PGVECTOR SEMANTIC SEARCH (query text + embeddings available)
    if (this.pgVectorStrategy) {
      logger.debug('SYSTEM', 'Orchestrator: Using pgvector semantic search', {});
      const result = await this.pgVectorStrategy.search(options);

      // If pgvector succeeded (even with 0 results), return
      if (result.usedVector) {
        return result;
      }

      // pgvector failed - fall back to Structured for filter-only
      logger.debug(
        'SYSTEM',
        'Orchestrator: pgvector failed, falling back to Structured',
        {},
      );
      const fallbackResult = await this.structuredStrategy.search({
        ...options,
        query: undefined, // Remove query for Structured fallback
      });

      return {
        ...fallbackResult,
        fellBack: true,
      };
    }

    // PATH 3: No embeddings available — structured only
    logger.debug('SYSTEM', 'Orchestrator: No embeddings available, using Structured', {});
    return await this.structuredStrategy.search({
      ...options,
      query: undefined,
    });
  }

  /**
   * Check if pgvector is available
   */
  isPgVectorAvailable(): boolean {
    return !!this.pgVectorStrategy;
  }

  /**
   * Normalize query parameters from URL-friendly format
   */
  private normalizeParams(args: any): NormalizedParams {
    const normalized: any = { ...args };

    // Parse comma-separated concepts into array
    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
    }

    // Parse comma-separated files into array
    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
    }

    // Parse comma-separated obs_type into array
    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obsType = normalized.obs_type
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      delete normalized.obs_type;
    }

    // Parse comma-separated type (for filterSchema) into array
    if (
      normalized.type &&
      typeof normalized.type === 'string' &&
      normalized.type.includes(',')
    ) {
      normalized.type = normalized.type
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
    }

    // Map 'type' param to 'searchType' for API consistency
    if (normalized.type && !normalized.searchType) {
      if (['observations', 'sessions', 'prompts'].includes(normalized.type)) {
        normalized.searchType = normalized.type;
        delete normalized.type;
      }
    }

    // Flatten dateStart/dateEnd into dateRange object
    if (normalized.dateStart || normalized.dateEnd) {
      normalized.dateRange = {
        start: normalized.dateStart,
        end: normalized.dateEnd,
      };
      delete normalized.dateStart;
      delete normalized.dateEnd;
    }

    return normalized;
  }
}
