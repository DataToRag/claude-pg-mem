/**
 * StructuredSearchStrategy - Direct Postgres queries for filter-only searches
 *
 * This strategy handles searches without query text (filter-only):
 * - Date range filtering
 * - Project filtering
 * - Type filtering
 * - Concept/file filtering
 *
 * Ported from claude-mem's SQLiteSearchStrategy to use Drizzle ORM with Postgres.
 * Used when: No query text is provided, or as a fallback when pgvector fails.
 */

import { eq, and, desc, asc, gte, lte, inArray, sql } from 'drizzle-orm';
import { BaseSearchStrategy, type SearchStrategy } from './SearchStrategy.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult,
} from '../types.js';
import { SEARCH_CONSTANTS } from '../types.js';
import type { Database } from '../../../postgres/client.js';
import {
  observations,
  sessionSummaries,
  userPrompts,
} from '../../../postgres/schema.js';
import { logger } from '../../../../utils/logger.js';

export class StructuredSearchStrategy
  extends BaseSearchStrategy
  implements SearchStrategy
{
  readonly name = 'structured';

  constructor(private db: Database) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    // Can handle filter-only queries (no query text)
    // Also used as fallback when pgvector is unavailable
    return !options.query || options.strategyHint === 'structured';
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      searchType = 'all',
      obsType,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      offset = 0,
      project,
      dateRange,
      orderBy = 'date_desc',
    } = options;

    const searchObservations =
      searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    let observationResults: ObservationSearchResult[] = [];
    let sessionResults: SessionSummarySearchResult[] = [];
    let promptResults: UserPromptSearchResult[] = [];

    logger.debug('SYSTEM', 'StructuredSearchStrategy: Filter-only query', {
      searchType,
      hasDateRange: !!dateRange,
      hasProject: !!project,
    });

    try {
      if (searchObservations) {
        observationResults = await this.queryObservations(
          project,
          obsType,
          dateRange,
          orderBy,
          limit,
          offset,
        );
      }

      if (searchSessions) {
        sessionResults = await this.querySessions(
          project,
          dateRange,
          orderBy,
          limit,
          offset,
        );
      }

      if (searchPrompts) {
        promptResults = await this.queryPrompts(
          project,
          dateRange,
          orderBy,
          limit,
          offset,
        );
      }

      logger.debug('SYSTEM', 'StructuredSearchStrategy: Results', {
        observations: observationResults.length,
        sessions: sessionResults.length,
        prompts: promptResults.length,
      });

      return {
        results: {
          observations: observationResults,
          sessions: sessionResults,
          prompts: promptResults,
        },
        usedVector: false,
        fellBack: false,
        strategy: 'structured',
      };
    } catch (error) {
      logger.error(
        'SYSTEM',
        'StructuredSearchStrategy: Search failed',
        {},
        error as Error,
      );
      return this.emptyResult('structured');
    }
  }

  /**
   * Query observations with filters
   */
  private async queryObservations(
    project?: string,
    obsType?: string | string[],
    dateRange?: { start?: string | number; end?: string | number },
    orderBy: string = 'date_desc',
    limit: number = SEARCH_CONSTANTS.DEFAULT_LIMIT,
    offset: number = 0,
  ): Promise<ObservationSearchResult[]> {
    const conditions = [];

    if (project) {
      conditions.push(eq(observations.project, project));
    }

    if (obsType) {
      const types = Array.isArray(obsType) ? obsType : [obsType];
      conditions.push(inArray(observations.type, types));
    }

    if (dateRange?.start) {
      const startEpoch =
        typeof dateRange.start === 'number'
          ? dateRange.start
          : new Date(dateRange.start).getTime();
      conditions.push(gte(observations.created_at_epoch, startEpoch));
    }

    if (dateRange?.end) {
      const endEpoch =
        typeof dateRange.end === 'number'
          ? dateRange.end
          : new Date(dateRange.end).getTime();
      conditions.push(lte(observations.created_at_epoch, endEpoch));
    }

    const orderClause =
      orderBy === 'date_asc'
        ? asc(observations.created_at_epoch)
        : desc(observations.created_at_epoch);

    const rows = await this.db
      .select()
      .from(observations)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset);

    return rows as ObservationSearchResult[];
  }

  /**
   * Query session summaries with filters
   */
  private async querySessions(
    project?: string,
    dateRange?: { start?: string | number; end?: string | number },
    orderBy: string = 'date_desc',
    limit: number = SEARCH_CONSTANTS.DEFAULT_LIMIT,
    offset: number = 0,
  ): Promise<SessionSummarySearchResult[]> {
    const conditions = [];

    if (project) {
      conditions.push(eq(sessionSummaries.project, project));
    }

    if (dateRange?.start) {
      const startEpoch =
        typeof dateRange.start === 'number'
          ? dateRange.start
          : new Date(dateRange.start).getTime();
      conditions.push(gte(sessionSummaries.created_at_epoch, startEpoch));
    }

    if (dateRange?.end) {
      const endEpoch =
        typeof dateRange.end === 'number'
          ? dateRange.end
          : new Date(dateRange.end).getTime();
      conditions.push(lte(sessionSummaries.created_at_epoch, endEpoch));
    }

    const orderClause =
      orderBy === 'date_asc'
        ? asc(sessionSummaries.created_at_epoch)
        : desc(sessionSummaries.created_at_epoch);

    const rows = await this.db
      .select()
      .from(sessionSummaries)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset);

    return rows as SessionSummarySearchResult[];
  }

  /**
   * Query user prompts with filters
   */
  private async queryPrompts(
    project?: string,
    dateRange?: { start?: string | number; end?: string | number },
    orderBy: string = 'date_desc',
    limit: number = SEARCH_CONSTANTS.DEFAULT_LIMIT,
    offset: number = 0,
  ): Promise<UserPromptSearchResult[]> {
    const conditions = [];

    // User prompts don't have a project column directly,
    // but we can join through sdk_sessions if needed.
    // For now, skip project filtering on prompts (matches claude-mem behavior).

    if (dateRange?.start) {
      const startEpoch =
        typeof dateRange.start === 'number'
          ? dateRange.start
          : new Date(dateRange.start).getTime();
      conditions.push(gte(userPrompts.created_at_epoch, startEpoch));
    }

    if (dateRange?.end) {
      const endEpoch =
        typeof dateRange.end === 'number'
          ? dateRange.end
          : new Date(dateRange.end).getTime();
      conditions.push(lte(userPrompts.created_at_epoch, endEpoch));
    }

    const orderClause =
      orderBy === 'date_asc'
        ? asc(userPrompts.created_at_epoch)
        : desc(userPrompts.created_at_epoch);

    const rows = await this.db
      .select()
      .from(userPrompts)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset);

    return rows as UserPromptSearchResult[];
  }
}
