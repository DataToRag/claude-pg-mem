/**
 * PgVectorSearchStrategy - Vector-based semantic search via pgvector
 *
 * NEW implementation replacing ChromaSearchStrategy. Implements semantic search
 * using pgvector's cosine distance operator (<=>):
 *
 * 1. Generate embedding for query text
 * 2. Query observations using vector similarity
 * 3. Filter by recency (90-day window)
 * 4. Return ranked results
 *
 * Used when: Query text is provided
 */

import { sql, and, eq, gte, inArray, desc } from 'drizzle-orm';
import { BaseSearchStrategy, type SearchStrategy } from './SearchStrategy.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult,
  SessionSummarySearchResult,
} from '../types.js';
import { SEARCH_CONSTANTS } from '../types.js';
import type { Database } from '../../../postgres/client.js';
import { observations, sessionSummaries } from '../../../postgres/schema.js';
import type { EmbedFn } from '../../../../embeddings/index.js';
import { logger } from '../../../../utils/logger.js';

export class PgVectorSearchStrategy
  extends BaseSearchStrategy
  implements SearchStrategy
{
  readonly name = 'pgvector';

  constructor(
    private db: Database,
    private embedFn: EmbedFn,
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    // Can handle when query text is provided
    return !!options.query;
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      query,
      searchType = 'all',
      obsType,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      project,
    } = options;

    if (!query) {
      return this.emptyResult('pgvector');
    }

    const searchObservations =
      searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';

    let observationResults: ObservationSearchResult[] = [];
    let sessionResults: SessionSummarySearchResult[] = [];

    try {
      // Step 1: Generate embedding for query
      logger.debug('SYSTEM', 'PgVectorSearchStrategy: Generating query embedding', {
        query,
      });
      const queryEmbedding = await this.embedFn(query);

      if (queryEmbedding.length === 0) {
        logger.warn(
          'SYSTEM',
          'PgVectorSearchStrategy: Empty embedding returned, falling back',
        );
        return {
          results: { observations: [], sessions: [], prompts: [] },
          usedVector: false,
          fellBack: false,
          strategy: 'pgvector',
        };
      }

      // Format embedding as a Postgres vector literal: '[0.1,0.2,...]'
      const embeddingLiteral = `[${queryEmbedding.join(',')}]`;

      // Step 2: Recency cutoff (90 days)
      const recencyCutoff = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;

      // Step 3: Query observations using vector similarity
      if (searchObservations) {
        observationResults = await this.queryObservationsByVector(
          embeddingLiteral,
          recencyCutoff,
          project,
          obsType,
          limit,
        );
      }

      // Step 4: Query session summaries using vector similarity
      if (searchSessions) {
        sessionResults = await this.querySummariesByVector(
          embeddingLiteral,
          recencyCutoff,
          project,
          limit,
        );
      }

      logger.debug('SYSTEM', 'PgVectorSearchStrategy: Results', {
        observations: observationResults.length,
        sessions: sessionResults.length,
      });

      return {
        results: {
          observations: observationResults,
          sessions: sessionResults,
          prompts: [], // Prompts don't have embeddings
        },
        usedVector: true,
        fellBack: false,
        strategy: 'pgvector',
      };
    } catch (error) {
      logger.error(
        'SYSTEM',
        'PgVectorSearchStrategy: Search failed',
        {},
        error as Error,
      );
      // Return empty result - caller may try fallback strategy
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedVector: false,
        fellBack: false,
        strategy: 'pgvector',
      };
    }
  }

  /**
   * Query observations using vector cosine distance.
   *
   * Uses pgvector's <=> operator (cosine distance) to find semantically similar
   * observations. Results are ordered by distance (lower = more similar) and
   * filtered by recency.
   */
  private async queryObservationsByVector(
    embeddingLiteral: string,
    recencyCutoff: number,
    project?: string,
    obsType?: string | string[],
    limit: number = SEARCH_CONSTANTS.DEFAULT_LIMIT,
  ): Promise<ObservationSearchResult[]> {
    const conditions = [
      gte(observations.created_at_epoch, recencyCutoff),
      // Only include rows that have embeddings
      sql`${observations.embedding} IS NOT NULL`,
    ];

    if (project) {
      conditions.push(eq(observations.project, project));
    }

    if (obsType) {
      const types = Array.isArray(obsType) ? obsType : [obsType];
      conditions.push(inArray(observations.type, types));
    }

    const rows = await this.db
      .select({
        id: observations.id,
        memory_session_id: observations.memory_session_id,
        project: observations.project,
        text: observations.text,
        type: observations.type,
        title: observations.title,
        subtitle: observations.subtitle,
        facts: observations.facts,
        narrative: observations.narrative,
        concepts: observations.concepts,
        files_read: observations.files_read,
        files_modified: observations.files_modified,
        prompt_number: observations.prompt_number,
        discovery_tokens: observations.discovery_tokens,
        content_hash: observations.content_hash,
        created_at: observations.created_at,
        created_at_epoch: observations.created_at_epoch,
        // Cosine distance (lower = more similar)
        distance: sql<number>`${observations.embedding} <=> ${embeddingLiteral}::vector`,
      })
      .from(observations)
      .where(and(...conditions))
      .orderBy(sql`${observations.embedding} <=> ${embeddingLiteral}::vector`)
      .limit(limit);

    // Convert distance to a normalized score (higher = better, 0-1 range)
    // Cosine distance ranges from 0 (identical) to 2 (opposite)
    return rows.map(({ distance, ...row }) => ({
      ...row,
      score: distance != null ? 1 - distance / 2 : undefined,
      rank: distance ?? undefined,
    })) as ObservationSearchResult[];
  }

  /**
   * Query session summaries using vector cosine distance.
   */
  private async querySummariesByVector(
    embeddingLiteral: string,
    recencyCutoff: number,
    project?: string,
    limit: number = SEARCH_CONSTANTS.DEFAULT_LIMIT,
  ): Promise<SessionSummarySearchResult[]> {
    const conditions = [
      gte(sessionSummaries.created_at_epoch, recencyCutoff),
      sql`${sessionSummaries.embedding} IS NOT NULL`,
    ];

    if (project) {
      conditions.push(eq(sessionSummaries.project, project));
    }

    const rows = await this.db
      .select({
        id: sessionSummaries.id,
        memory_session_id: sessionSummaries.memory_session_id,
        project: sessionSummaries.project,
        request: sessionSummaries.request,
        investigated: sessionSummaries.investigated,
        learned: sessionSummaries.learned,
        completed: sessionSummaries.completed,
        next_steps: sessionSummaries.next_steps,
        files_read: sessionSummaries.files_read,
        files_edited: sessionSummaries.files_edited,
        notes: sessionSummaries.notes,
        prompt_number: sessionSummaries.prompt_number,
        discovery_tokens: sessionSummaries.discovery_tokens,
        created_at: sessionSummaries.created_at,
        created_at_epoch: sessionSummaries.created_at_epoch,
        distance: sql<number>`${sessionSummaries.embedding} <=> ${embeddingLiteral}::vector`,
      })
      .from(sessionSummaries)
      .where(and(...conditions))
      .orderBy(
        sql`${sessionSummaries.embedding} <=> ${embeddingLiteral}::vector`,
      )
      .limit(limit);

    return rows.map(({ distance, ...row }) => ({
      ...row,
      score: distance != null ? 1 - distance / 2 : undefined,
      rank: distance ?? undefined,
    })) as SessionSummarySearchResult[];
  }
}
