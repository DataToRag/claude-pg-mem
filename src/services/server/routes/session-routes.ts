/**
 * Session Routes - Session lifecycle management
 *
 * Endpoints:
 *   POST /api/sessions/init         - Create/find session, store prompt, check privacy
 *   POST /sessions/:sessionDbId/init - Start SDK agent for the session
 *   POST /api/sessions/observations  - Enqueue observation in PendingMessageStore
 *   POST /api/sessions/summarize     - Enqueue summary request
 *   POST /api/sessions/complete      - Mark session complete, cleanup
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware.js';
import { logger } from '../../../utils/logger.js';
import { getDb } from '../../postgres/client.js';
import {
  createSdkSession,
  getSdkSession,
  getSdkSessionById,
  completeSdkSession,
  storeUserPrompt,
  getPromptCount,
} from '../../postgres/index.js';
import type { SessionManager } from '../SessionManager.js';

/**
 * Create session routes with access to the SessionManager
 */
export function createSessionRoutes(sessionManager: SessionManager): Router {
  const router = Router();

  // -----------------------------------------------------------------------
  // POST /api/sessions/init
  // Create or find session in DB, store user prompt, return session info
  // -----------------------------------------------------------------------
  router.post('/api/sessions/init', asyncHandler(async (req: Request, res: Response) => {
    const { contentSessionId, project, prompt } = req.body;

    if (!contentSessionId || !project) {
      res.status(400).json({ error: 'Missing required fields: contentSessionId, project' });
      return;
    }

    const db = getDb();

    // Create or find SDK session (idempotent)
    const sessionDbId = await createSdkSession(db, contentSessionId, project, prompt || '');

    // Determine prompt number from existing prompts
    const existingCount = await getPromptCount(db, contentSessionId);
    const promptNumber = existingCount + 1;

    // Store the user prompt
    await storeUserPrompt(db, {
      content_session_id: contentSessionId,
      prompt_number: promptNumber,
      prompt_text: prompt || '',
      created_at: new Date().toISOString(),
    });

    // Check if context was already injected for this session
    // (If promptNumber > 1, context was injected on the first prompt)
    const contextInjected = promptNumber > 1;

    logger.info('HTTP', `Session init | sessionDbId=${sessionDbId} | promptNumber=${promptNumber}`, {
      sessionId: sessionDbId,
    });

    res.json({
      sessionDbId,
      promptNumber,
      skipped: false,
      contextInjected,
    });
  }));

  // -----------------------------------------------------------------------
  // POST /sessions/:sessionDbId/init
  // Start the SDK observer agent for the session
  // -----------------------------------------------------------------------
  router.post('/sessions/:sessionDbId/init', asyncHandler(async (req: Request, res: Response) => {
    const sessionDbId = parseInt(req.params.sessionDbId, 10);
    const { userPrompt, promptNumber } = req.body;

    if (isNaN(sessionDbId)) {
      res.status(400).json({ error: 'Invalid sessionDbId' });
      return;
    }

    logger.info('HTTP', `Agent init | sessionDbId=${sessionDbId} | promptNumber=${promptNumber}`, {
      sessionId: sessionDbId,
    });

    try {
      // Initialize session in SessionManager and start agent
      await sessionManager.startSession(sessionDbId, userPrompt, promptNumber);

      res.json({ status: 'ok', sessionDbId });
    } catch (error) {
      logger.error('HTTP', 'Agent init failed', { sessionDbId }, error as Error);
      res.status(500).json({ error: 'Agent initialization failed', message: (error as Error).message });
    }
  }));

  // -----------------------------------------------------------------------
  // POST /api/sessions/observations
  // Enqueue observation in the persistent work queue
  // -----------------------------------------------------------------------
  router.post('/api/sessions/observations', asyncHandler(async (req: Request, res: Response) => {
    const { contentSessionId, tool_name, tool_input, tool_response, cwd } = req.body;

    if (!contentSessionId || !tool_name) {
      res.status(400).json({ error: 'Missing required fields: contentSessionId, tool_name' });
      return;
    }

    const db = getDb();

    // Look up session by contentSessionId
    const sdkSession = await getSdkSession(db, contentSessionId);
    if (!sdkSession) {
      logger.warn('HTTP', 'Observation for unknown session, skipping', { contentSessionId });
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const sessionDbId = sdkSession.id;

    // Get current prompt number
    const promptNumber = await getPromptCount(db, contentSessionId);

    try {
      // Enqueue in SessionManager (persists to DB + notifies agent)
      sessionManager.queueObservation(sessionDbId, {
        tool_name,
        tool_input,
        tool_response,
        prompt_number: promptNumber,
        cwd,
      });

      res.json({ status: 'ok', sessionDbId });
    } catch (error) {
      logger.error('HTTP', 'Observation enqueue failed', { sessionDbId }, error as Error);
      res.status(500).json({ error: 'Failed to enqueue observation' });
    }
  }));

  // -----------------------------------------------------------------------
  // POST /api/sessions/summarize
  // Enqueue summary request
  // -----------------------------------------------------------------------
  router.post('/api/sessions/summarize', asyncHandler(async (req: Request, res: Response) => {
    const { contentSessionId, last_assistant_message } = req.body;

    if (!contentSessionId) {
      res.status(400).json({ error: 'Missing required field: contentSessionId' });
      return;
    }

    const db = getDb();

    // Look up session
    const sdkSession = await getSdkSession(db, contentSessionId);
    if (!sdkSession) {
      logger.warn('HTTP', 'Summarize for unknown session', { contentSessionId });
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const sessionDbId = sdkSession.id;

    try {
      sessionManager.queueSummarize(sessionDbId, last_assistant_message);

      res.json({ status: 'ok', sessionDbId });
    } catch (error) {
      logger.error('HTTP', 'Summarize enqueue failed', { sessionDbId }, error as Error);
      res.status(500).json({ error: 'Failed to enqueue summarize' });
    }
  }));

  // -----------------------------------------------------------------------
  // POST /api/sessions/complete
  // Mark session as complete, remove from active map
  // -----------------------------------------------------------------------
  router.post('/api/sessions/complete', asyncHandler(async (req: Request, res: Response) => {
    const { contentSessionId } = req.body;

    if (!contentSessionId) {
      res.status(400).json({ error: 'Missing required field: contentSessionId' });
      return;
    }

    const db = getDb();

    // Look up session
    const sdkSession = await getSdkSession(db, contentSessionId);
    if (!sdkSession) {
      // Session already gone — not an error
      logger.debug('HTTP', 'Complete for unknown session (already gone)', { contentSessionId });
      res.json({ status: 'ok', message: 'Session not found, may already be complete' });
      return;
    }

    const sessionDbId = sdkSession.id;

    // Mark as completed in DB
    await completeSdkSession(db, contentSessionId);

    // Remove from active session map (aborts agent, cleans up)
    await sessionManager.deleteSession(sessionDbId);

    logger.info('HTTP', `Session complete | sessionDbId=${sessionDbId}`, {
      sessionId: sessionDbId,
    });

    res.json({ status: 'ok', sessionDbId });
  }));

  return router;
}
