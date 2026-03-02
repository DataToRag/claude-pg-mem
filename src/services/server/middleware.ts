/**
 * Express Middleware - JSON parsing, CORS, request logging, error handling
 *
 * Provides middleware stack for the worker HTTP server.
 */

import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { logger } from '../../utils/logger.js';

/**
 * Application error with HTTP status code
 */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * JSON body parser middleware (10MB limit for large tool responses)
 */
export function jsonParser(): express.RequestHandler {
  return express.json({ limit: '10mb' });
}

/**
 * CORS middleware — allow localhost origins for development
 */
export function corsMiddleware(): express.RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * Request logging middleware — logs method, path, and response time
 */
export function requestLogger(): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const originalEnd = res.end;

    // Wrap res.end to log after response is sent
    (res as any).end = function (this: Response, ...args: any[]) {
      const duration = Date.now() - start;
      // Only log non-health endpoints to avoid spam
      if (!req.path.includes('/health') && !req.path.includes('/api/stats')) {
        logger.debug('HTTP', `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      }
      return (originalEnd as Function).apply(this, args);
    };

    next();
  };
}

/**
 * Localhost-only guard — reject requests not from 127.0.0.1 / ::1
 */
export function requireLocalhost(req: Request, res: Response, next: NextFunction): void {
  const remoteAddress = req.socket.remoteAddress || '';
  const isLocal =
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1';

  if (!isLocal) {
    res.status(403).json({ error: 'Forbidden — localhost only' });
    return;
  }
  next();
}

/**
 * Global error handler middleware — must be registered last
 */
export const errorHandler: ErrorRequestHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const statusCode = err instanceof AppError ? err.statusCode : 500;

  logger.error('HTTP', `Error handling ${req.method} ${req.path}`, {
    statusCode,
    error: err.message,
  }, err);

  res.status(statusCode).json({
    error: err.name || 'Error',
    message: err.message,
  });
};

/**
 * 404 handler for unmatched routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'NotFound',
    message: `Cannot ${req.method} ${req.path}`,
  });
}

/**
 * Async wrapper — catches promise rejections and passes to Express error handler
 */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
