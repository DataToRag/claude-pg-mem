/**
 * Search Routes - Search, timeline, and observation batch endpoints
 *
 * Endpoints:
 *   GET  /api/search           - Semantic + structured search via SearchOrchestrator
 *   GET  /api/timeline         - Timeline context around an observation
 *   POST /api/observations/batch - Batch get observations by IDs
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware.js';
import { logger } from '../../../utils/logger.js';
import { getDb } from '../../postgres/client.js';
import { SearchOrchestrator } from '../../worker/search/SearchOrchestrator.js';
import {
  getTimeline,
  getProjectTimeline,
  getObservationsByIds,
} from '../../postgres/index.js';
import type { EmbedFn } from '../../../embeddings/index.js';

/**
 * Format results into MCP-compatible content blocks
 */
function formatAsContent(result: any): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Progressive disclosure: shape results by tier to minimize context bloat
// ---------------------------------------------------------------------------

/** Search tier — compact index (~50-100 tokens/result) */
function compactObservation(obs: any) {
  return {
    id: obs.id,
    type: obs.type,
    title: obs.title,
    subtitle: obs.subtitle,
    project: obs.project,
    concepts: obs.concepts,
    score: obs.score,
    created_at_epoch: obs.created_at_epoch,
  };
}

function compactSession(sess: any) {
  return {
    id: sess.id,
    request: sess.request,
    completed: sess.completed,
    project: sess.project,
    score: sess.score,
    created_at_epoch: sess.created_at_epoch,
  };
}

function compactPrompt(prompt: any) {
  return {
    id: prompt.id,
    prompt_text: prompt.prompt_text,
    prompt_number: prompt.prompt_number,
    created_at_epoch: prompt.created_at_epoch,
  };
}

/** Shape search results to compact index */
function shapeSearchResults(result: any) {
  return {
    results: {
      observations: (result.results?.observations ?? []).map(compactObservation),
      sessions: (result.results?.sessions ?? []).map(compactSession),
      prompts: (result.results?.prompts ?? []).map(compactPrompt),
    },
    strategy: result.strategy,
  };
}

/** Timeline tier — moderate detail (~200-500 tokens total) */
function timelineObservation(obs: any) {
  return {
    id: obs.id,
    type: obs.type,
    title: obs.title,
    subtitle: obs.subtitle,
    narrative: obs.narrative,
    concepts: obs.concepts,
    files_modified: obs.files_modified,
    project: obs.project,
    created_at_epoch: obs.created_at_epoch,
  };
}

function shapeTimelineResults(result: any) {
  return {
    observations: (result.observations ?? []).map(timelineObservation),
    sessions: result.sessions, // already compact from Timeline.ts
    prompts: result.prompts,   // already compact from Timeline.ts
  };
}

/** Get observations tier — full detail minus internal-only fields */
function fullObservation(obs: any) {
  return {
    id: obs.id,
    type: obs.type,
    title: obs.title,
    subtitle: obs.subtitle,
    text: obs.text,
    narrative: obs.narrative,
    facts: obs.facts,
    concepts: obs.concepts,
    files_read: obs.files_read,
    files_modified: obs.files_modified,
    project: obs.project,
    prompt_number: obs.prompt_number,
    created_at_epoch: obs.created_at_epoch,
  };
}

/**
 * Create search routes with optional embedding function
 */
export function createSearchRoutes(embedFn?: EmbedFn): Router {
  const router = Router();

  // Create search orchestrator lazily (to allow DB to be initialized first)
  let orchestrator: SearchOrchestrator | null = null;

  function getOrchestrator(): SearchOrchestrator {
    if (!orchestrator) {
      const db = getDb();
      orchestrator = new SearchOrchestrator(db, embedFn);
    }
    return orchestrator;
  }

  // -----------------------------------------------------------------------
  // GET /api/search
  // Search observations, sessions, prompts via SearchOrchestrator
  // -----------------------------------------------------------------------
  router.get('/api/search', asyncHandler(async (req: Request, res: Response) => {
    const params = { ...req.query };

    // Parse numeric params
    if (params.limit) params.limit = parseInt(params.limit as string, 10) as any;
    if (params.offset) params.offset = parseInt(params.offset as string, 10) as any;

    logger.debug('HTTP', 'Search request', { query: params.query, project: params.project });

    try {
      const result = await getOrchestrator().search(params);
      res.json(formatAsContent(shapeSearchResults(result)));
    } catch (error) {
      logger.error('HTTP', 'Search failed', {}, error as Error);
      res.json({
        content: [{ type: 'text', text: `Search error: ${(error as Error).message}` }],
        isError: true,
      });
    }
  }));

  // -----------------------------------------------------------------------
  // GET /api/timeline
  // Timeline context around an observation or for a project
  // -----------------------------------------------------------------------
  router.get('/api/timeline', asyncHandler(async (req: Request, res: Response) => {
    const anchor = req.query.anchor ? parseInt(req.query.anchor as string, 10) : undefined;
    const depthBefore = req.query.depth_before ? parseInt(req.query.depth_before as string, 10) : 3;
    const depthAfter = req.query.depth_after ? parseInt(req.query.depth_after as string, 10) : 3;
    const project = req.query.project as string | undefined;

    const db = getDb();

    try {
      let result;

      if (anchor) {
        // Timeline around a specific observation
        result = await getTimeline(db, anchor, depthBefore, depthAfter, project);
      } else if (project) {
        // Project timeline (recent items)
        result = await getProjectTimeline(db, project, depthBefore + depthAfter + 1);
      } else {
        res.status(400).json({
          content: [{ type: 'text', text: 'Either anchor or project is required' }],
          isError: true,
        });
        return;
      }

      res.json(formatAsContent(shapeTimelineResults(result)));
    } catch (error) {
      logger.error('HTTP', 'Timeline query failed', {}, error as Error);
      res.json({
        content: [{ type: 'text', text: `Timeline error: ${(error as Error).message}` }],
        isError: true,
      });
    }
  }));

  // -----------------------------------------------------------------------
  // POST /api/observations/batch
  // Batch get observations by IDs (MCP get_observations tool)
  // -----------------------------------------------------------------------
  router.post('/api/observations/batch', asyncHandler(async (req: Request, res: Response) => {
    const { ids, orderBy, limit, project } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'Missing required field: ids (array of observation IDs)' });
      return;
    }

    const db = getDb();

    try {
      let results = await getObservationsByIds(db, ids);

      // Apply project filter if specified
      if (project) {
        results = results.filter(obs => obs.project === project);
      }

      // Apply ordering
      if (orderBy === 'date_asc') {
        results.sort((a, b) => a.created_at_epoch - b.created_at_epoch);
      } else {
        // Default: date_desc
        results.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
      }

      // Apply limit
      if (limit && limit > 0) {
        results = results.slice(0, limit);
      }

      res.json(results.map(fullObservation));
    } catch (error) {
      logger.error('HTTP', 'Batch observations failed', {}, error as Error);
      res.status(500).json({ error: 'Failed to fetch observations' });
    }
  }));

  return router;
}
