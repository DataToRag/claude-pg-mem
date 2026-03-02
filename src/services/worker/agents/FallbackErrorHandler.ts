/**
 * FallbackErrorHandler: Error detection for provider fallback
 *
 * Determines if an error should trigger fallback to Claude SDK.
 */

import { FALLBACK_ERROR_PATTERNS } from './types.js';

/**
 * Check if an error should trigger fallback to Claude SDK
 */
export function shouldFallbackToClaude(error: unknown): boolean {
  const message = getErrorMessage(error);
  return FALLBACK_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Extract error message from various error types
 */
function getErrorMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return '';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
}

/**
 * Check if error is an AbortError (user cancelled)
 */
export function isAbortError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }

  if (typeof error === 'object' && 'name' in error) {
    return (error as { name: unknown }).name === 'AbortError';
  }

  return false;
}
