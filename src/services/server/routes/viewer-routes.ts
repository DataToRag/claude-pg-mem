/**
 * Viewer Routes - Web UI serving + SSE stream
 *
 * Endpoints:
 *   GET /          - Serve viewer.html
 *   GET /stream    - SSE event stream for real-time updates
 *   Static assets  - JS, fonts, icons from plugin/ui/
 */

import express, { Router, Request, Response } from 'express';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { asyncHandler } from '../middleware.js';
import { logger } from '../../../utils/logger.js';
import { getPackageRoot } from '../../../shared/paths.js';
import { getDb } from '../../postgres/client.js';
import { getAllProjects } from '../../postgres/Timeline.js';
import type { SSEBroadcaster } from '../../worker/SSEBroadcaster.js';
import type { SessionManager } from '../SessionManager.js';

export function createViewerRoutes(
  sseBroadcaster: SSEBroadcaster,
  sessionManager: SessionManager,
): Router {
  const router = Router();

  // Serve static UI assets (JS, CSS, fonts, images)
  const packageRoot = getPackageRoot();
  const uiDirCandidates = [
    path.join(packageRoot, 'ui'),
    path.join(packageRoot, 'plugin', 'ui'),
    path.join(packageRoot, '..', 'plugin', 'ui'),
  ];
  for (const uiDir of uiDirCandidates) {
    if (existsSync(uiDir)) {
      router.use(express.static(uiDir));
      break;
    }
  }

  // GET / — Serve viewer HTML
  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    const viewerPaths = [
      path.join(packageRoot, 'ui', 'viewer.html'),           // Plugin context (CLAUDE_PLUGIN_ROOT/ui/)
      path.join(packageRoot, 'plugin', 'ui', 'viewer.html'), // Repo root context
      path.join(packageRoot, '..', 'plugin', 'ui', 'viewer.html'), // Dev context (dist/../plugin/ui/)
    ];

    const viewerPath = viewerPaths.find(p => existsSync(p));

    if (!viewerPath) {
      res.status(404).send('Viewer UI not found. Run `pnpm run build:plugin` to build the viewer.');
      return;
    }

    const html = readFileSync(viewerPath, 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }));

  // GET /stream — SSE event stream
  router.get('/stream', (_req: Request, res: Response) => {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add client to broadcaster
    sseBroadcaster.addClient(res);

    // Send initial_load event with projects list
    (async () => {
      try {
        const db = getDb();
        const allProjects = await getAllProjects(db);
        sseBroadcaster.broadcast({
          type: 'initial_load',
          projects: allProjects,
        });

        // Send initial processing status
        const isProcessing = await sessionManager.isAnySessionProcessing();
        const queueDepth = await sessionManager.getTotalActiveWork();
        sseBroadcaster.broadcast({
          type: 'processing_status',
          isProcessing,
          queueDepth,
        });
      } catch (error) {
        logger.error('VIEWER', 'Failed to send initial SSE data', {}, error as Error);
      }
    })();
  });

  return router;
}
