/**
 * Context Routes - Context injection for SessionStart hook
 *
 * Endpoints:
 *   GET /api/context/inject - Generate context string for a project
 *
 * Query params:
 *   projects  - Comma-separated project names (supports worktree: parent,worktree)
 *   colors    - If 'true', returns ANSI-colored output for terminal display
 */

import { Router, Request, Response } from 'express';
import { generateContext } from '../../context/ContextBuilder.js';
import { asyncHandler } from '../middleware.js';
import { logger } from '../../../utils/logger.js';

export function createContextRoutes(): Router {
  const router = Router();

  router.get('/api/context/inject', asyncHandler(async (req: Request, res: Response) => {
    const projectsParam = req.query.projects as string | undefined;
    const useColors = req.query.colors === 'true';

    // Parse comma-separated projects
    const projects = projectsParam
      ? projectsParam.split(',').map(p => p.trim()).filter(Boolean)
      : [];

    logger.debug('HTTP', 'Context inject request', { projects, useColors });

    try {
      const context = await generateContext(
        projects.length > 0 ? { projects } : undefined,
        useColors,
      );

      // Return plain text (the hook reads response.text())
      res.type('text/plain').send(context);
    } catch (error) {
      logger.error('HTTP', 'Context generation failed', {}, error as Error);
      // Return empty context on error — don't block session start
      res.type('text/plain').send('');
    }
  }));

  // GET /api/context/preview — Preview context for the viewer UI
  router.get('/api/context/preview', asyncHandler(async (req: Request, res: Response) => {
    const project = req.query.project as string | undefined;

    if (!project) {
      res.status(400).type('text/plain').send('Project parameter is required');
      return;
    }

    logger.debug('HTTP', 'Context preview request', { project });

    try {
      const context = await generateContext(
        { projects: [project] },
        true, // useColors for terminal-style display
      );

      res.type('text/plain').send(context);
    } catch (error) {
      logger.error('HTTP', 'Context preview failed', {}, error as Error);
      res.status(500).type('text/plain').send('Failed to generate context preview');
    }
  }));

  return router;
}
