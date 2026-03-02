/**
 * Health Routes - Health check and stats endpoints
 *
 * Endpoints:
 *   GET /health       - Basic liveness check
 *   GET /api/health   - Detailed health (alias)
 *   GET /api/version  - Returns worker version
 *   GET /api/stats    - Basic observation/session counts
 */

import { Router, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { asyncHandler } from '../middleware.js';
import { getDb } from '../../postgres/client.js';
import { observations, sdkSessions, userPrompts, sessionSummaries } from '../../postgres/schema.js';

const VERSION = '0.1.0';

export function createHealthRoutes(): Router {
  const router = Router();
  const startTime = Date.now();

  // Liveness check — always responds 200 as soon as HTTP is up
  const healthHandler = (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      version: VERSION,
      uptime: Date.now() - startTime,
      pid: process.pid,
      platform: process.platform,
    });
  };

  router.get('/health', healthHandler);
  router.get('/api/health', healthHandler);

  // Version endpoint
  router.get('/api/version', (_req: Request, res: Response) => {
    res.status(200).json({ version: VERSION });
  });

  // Stats endpoint
  router.get('/api/stats', asyncHandler(async (_req: Request, res: Response) => {
    const db = getDb();

    const [obsCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(observations);

    const [sessCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(sdkSessions);

    const [promptCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(userPrompts);

    const [summaryCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(sessionSummaries);

    res.json({
      totalObservations: obsCount?.count ?? 0,
      totalSessions: sessCount?.count ?? 0,
      totalPrompts: promptCount?.count ?? 0,
      totalSummaries: summaryCount?.count ?? 0,
    });
  }));

  return router;
}
