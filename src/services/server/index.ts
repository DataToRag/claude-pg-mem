/**
 * Server Module - Express HTTP server setup
 *
 * Creates and configures the Express app with all middleware and routes.
 * Exports createServer() for use by the worker-service orchestrator.
 */

import express, { Application } from 'express';
import http from 'http';
import { logger } from '../../utils/logger.js';
import {
  jsonParser,
  corsMiddleware,
  requestLogger,
  errorHandler,
  notFoundHandler,
} from './middleware.js';
import { createHealthRoutes } from './routes/health-routes.js';
import { createContextRoutes } from './routes/context-routes.js';
import { createSessionRoutes } from './routes/session-routes.js';
import { createSearchRoutes } from './routes/search-routes.js';
import { createDataRoutes } from './routes/data-routes.js';
import { createViewerRoutes } from './routes/viewer-routes.js';
import { SessionManager } from './SessionManager.js';
import { SSEBroadcaster } from '../worker/SSEBroadcaster.js';
import type { EmbedFn } from '../../embeddings/index.js';

export interface ServerConfig {
  sessionManager: SessionManager;
  embedFn?: EmbedFn;
  sseBroadcaster?: SSEBroadcaster;
}

export interface ServerInstance {
  app: Application;
  httpServer: http.Server | null;
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create and configure the Express HTTP server.
 *
 * Mounts all middleware and route groups:
 * - Health/stats routes
 * - Context injection routes
 * - Session lifecycle routes
 * - Search/timeline routes
 */
export function createServer(config: ServerConfig): ServerInstance {
  const app = express();
  let httpServer: http.Server | null = null;

  // -----------------------------------------------------------------------
  // Middleware stack
  // -----------------------------------------------------------------------
  app.use(jsonParser());
  app.use(corsMiddleware());
  app.use(requestLogger());

  // -----------------------------------------------------------------------
  // SSE broadcaster
  // -----------------------------------------------------------------------
  const sseBroadcaster = config.sseBroadcaster || new SSEBroadcaster();

  // -----------------------------------------------------------------------
  // API route groups (must be before viewer routes)
  // -----------------------------------------------------------------------
  app.use(createHealthRoutes());
  app.use(createContextRoutes());
  app.use(createSessionRoutes(config.sessionManager));
  app.use(createSearchRoutes(config.embedFn));
  app.use(createDataRoutes(config.sessionManager, sseBroadcaster));

  // -----------------------------------------------------------------------
  // Viewer routes (serves HTML at / — must be after API routes)
  // -----------------------------------------------------------------------
  app.use(createViewerRoutes(sseBroadcaster, config.sessionManager));

  // -----------------------------------------------------------------------
  // Error handling (must be last)
  // -----------------------------------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return {
    app,
    get httpServer() {
      return httpServer;
    },

    async listen(port: number, host: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        httpServer = app.listen(port, host, () => {
          logger.info('SYSTEM', 'HTTP server started', { host, port, pid: process.pid });
          resolve();
        });
        httpServer.on('error', reject);
      });
    },

    async close(): Promise<void> {
      if (!httpServer) return;

      httpServer.closeAllConnections();

      // Windows delay for connection cleanup
      if (process.platform === 'win32') {
        await new Promise((r) => setTimeout(r, 500));
      }

      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });

      // Extra Windows delay for port release
      if (process.platform === 'win32') {
        await new Promise((r) => setTimeout(r, 500));
      }

      httpServer = null;
      logger.info('SYSTEM', 'HTTP server closed');
    },
  };
}

// Re-export key types for external use
export { SessionManager } from './SessionManager.js';
export { SSEBroadcaster } from '../worker/SSEBroadcaster.js';
export { AppError, asyncHandler } from './middleware.js';
