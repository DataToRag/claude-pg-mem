/**
 * Data Routes - Paginated data endpoints for the web viewer
 *
 * Endpoints:
 *   GET  /api/observations          - Paginated observations
 *   GET  /api/summaries             - Paginated summaries
 *   GET  /api/prompts               - Paginated prompts
 *   GET  /api/projects              - All project names
 *   GET  /api/stats                 - Worker + database statistics
 *   GET  /api/processing-status     - Queue processing state
 *   GET  /api/settings              - Current settings
 *   POST /api/settings              - Save settings
 */

import { Router, Request, Response } from 'express';
import { desc, eq, sql, count } from 'drizzle-orm';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { asyncHandler } from '../middleware.js';
import { getDb } from '../../postgres/client.js';
import { observations, sessionSummaries, userPrompts, sdkSessions } from '../../postgres/schema.js';
import { getAllProjects } from '../../postgres/Timeline.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import type { SessionManager } from '../SessionManager.js';
import type { SSEBroadcaster } from '../../worker/SSEBroadcaster.js';

const DEFAULT_PAGE_SIZE = 25;

function parsePaginationParams(req: Request) {
  const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || DEFAULT_PAGE_SIZE));
  const project = (req.query.project as string) || undefined;
  return { offset, limit, project };
}

export function createDataRoutes(
  sessionManager: SessionManager,
  sseBroadcaster: SSEBroadcaster,
): Router {
  const router = Router();

  // GET /api/observations
  router.get('/api/observations', asyncHandler(async (req: Request, res: Response) => {
    const { offset, limit, project } = parsePaginationParams(req);
    const db = getDb();

    const whereClause = project ? eq(observations.project, project) : undefined;

    const rows = await db
      .select({
        id: observations.id,
        memory_session_id: observations.memory_session_id,
        project: observations.project,
        type: observations.type,
        title: observations.title,
        subtitle: observations.subtitle,
        narrative: observations.narrative,
        text: observations.text,
        facts: observations.facts,
        concepts: observations.concepts,
        files_read: observations.files_read,
        files_modified: observations.files_modified,
        prompt_number: observations.prompt_number,
        created_at: observations.created_at,
        created_at_epoch: observations.created_at_epoch,
      })
      .from(observations)
      .where(whereClause)
      .orderBy(desc(observations.created_at_epoch))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    res.json({ items, hasMore, offset, limit });
  }));

  // GET /api/summaries
  router.get('/api/summaries', asyncHandler(async (req: Request, res: Response) => {
    const { offset, limit, project } = parsePaginationParams(req);
    const db = getDb();

    const whereClause = project ? eq(sessionSummaries.project, project) : undefined;

    const rows = await db
      .select({
        id: sessionSummaries.id,
        session_id: sessionSummaries.memory_session_id,
        project: sessionSummaries.project,
        request: sessionSummaries.request,
        investigated: sessionSummaries.investigated,
        learned: sessionSummaries.learned,
        completed: sessionSummaries.completed,
        next_steps: sessionSummaries.next_steps,
        notes: sessionSummaries.notes,
        created_at: sessionSummaries.created_at,
        created_at_epoch: sessionSummaries.created_at_epoch,
      })
      .from(sessionSummaries)
      .where(whereClause)
      .orderBy(desc(sessionSummaries.created_at_epoch))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    res.json({ items, hasMore, offset, limit });
  }));

  // GET /api/prompts
  router.get('/api/prompts', asyncHandler(async (req: Request, res: Response) => {
    const { offset, limit, project } = parsePaginationParams(req);
    const db = getDb();

    let rows;
    if (project) {
      rows = await db
        .select({
          id: userPrompts.id,
          content_session_id: userPrompts.content_session_id,
          project: sdkSessions.project,
          prompt_number: userPrompts.prompt_number,
          prompt_text: userPrompts.prompt_text,
          created_at: userPrompts.created_at,
          created_at_epoch: userPrompts.created_at_epoch,
        })
        .from(userPrompts)
        .leftJoin(sdkSessions, eq(userPrompts.content_session_id, sdkSessions.content_session_id))
        .where(eq(sdkSessions.project, project))
        .orderBy(desc(userPrompts.created_at_epoch))
        .limit(limit + 1)
        .offset(offset);
    } else {
      rows = await db
        .select({
          id: userPrompts.id,
          content_session_id: userPrompts.content_session_id,
          project: sdkSessions.project,
          prompt_number: userPrompts.prompt_number,
          prompt_text: userPrompts.prompt_text,
          created_at: userPrompts.created_at,
          created_at_epoch: userPrompts.created_at_epoch,
        })
        .from(userPrompts)
        .leftJoin(sdkSessions, eq(userPrompts.content_session_id, sdkSessions.content_session_id))
        .orderBy(desc(userPrompts.created_at_epoch))
        .limit(limit + 1)
        .offset(offset);
    }

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    res.json({ items, hasMore, offset, limit });
  }));

  // GET /api/projects
  router.get('/api/projects', asyncHandler(async (_req: Request, res: Response) => {
    const db = getDb();
    const projects = await getAllProjects(db);
    res.json({ projects });
  }));

  // GET /api/stats
  router.get('/api/stats', asyncHandler(async (_req: Request, res: Response) => {
    const db = getDb();

    const [obsCount] = await db.select({ count: count() }).from(observations);
    const [sessCount] = await db.select({ count: count() }).from(sdkSessions);
    const [summCount] = await db.select({ count: count() }).from(sessionSummaries);
    const [promptCount] = await db.select({ count: count() }).from(userPrompts);

    res.json({
      worker: {
        sseClients: sseBroadcaster.getClientCount(),
        activeSessions: sessionManager.getActiveSessionCount(),
      },
      database: {
        observations: obsCount?.count ?? 0,
        sessions: sessCount?.count ?? 0,
        summaries: summCount?.count ?? 0,
        prompts: promptCount?.count ?? 0,
      },
    });
  }));

  // GET /api/processing-status
  router.get('/api/processing-status', asyncHandler(async (_req: Request, res: Response) => {
    const isProcessing = await sessionManager.isAnySessionProcessing();
    const queueDepth = await sessionManager.getTotalActiveWork();
    res.json({ isProcessing, queueDepth });
  }));

  // GET /api/settings
  router.get('/api/settings', asyncHandler(async (_req: Request, res: Response) => {
    const merged = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    res.json(merged);
  }));

  // POST /api/settings
  router.post('/api/settings', asyncHandler(async (req: Request, res: Response) => {
    const settings = req.body;
    if (!settings || typeof settings !== 'object') {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }

    const dir = dirname(USER_SETTINGS_PATH);
    if (!existsSync(dir)) {
      const { mkdirSync } = await import('fs');
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(USER_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    res.json({ ok: true });
  }));

  return router;
}
