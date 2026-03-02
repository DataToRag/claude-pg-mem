/**
 * SessionCleanupHelper: Session state cleanup after response processing
 *
 * Resets earliest pending timestamp and broadcasts processing status updates.
 */

import type { ActiveSession } from '../../worker-types.js';
import type { WorkerRef } from './types.js';

/**
 * Clean up session state after response processing
 *
 * With claim-and-delete queue pattern, this function simply:
 * 1. Resets the earliest pending timestamp
 * 2. Broadcasts updated processing status to SSE clients
 */
export function cleanupProcessedMessages(
  session: ActiveSession,
  worker: WorkerRef | undefined
): void {
  // Reset earliest pending timestamp for next batch
  session.earliestPendingTimestamp = null;

  // Broadcast activity status after processing (queue may have changed)
  if (worker && typeof worker.broadcastProcessingStatus === 'function') {
    worker.broadcastProcessingStatus();
  }
}
