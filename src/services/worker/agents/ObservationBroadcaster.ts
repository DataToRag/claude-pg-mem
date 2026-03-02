/**
 * ObservationBroadcaster: SSE broadcasting for observations and summaries
 *
 * Broadcasts new observations and summaries to SSE clients (web UI).
 */

import type { WorkerRef, ObservationSSEPayload, SummarySSEPayload } from './types.js';

/**
 * Broadcast a new observation to SSE clients
 */
export function broadcastObservation(
  worker: WorkerRef | undefined,
  payload: ObservationSSEPayload
): void {
  if (!worker?.sseBroadcaster) {
    return;
  }

  worker.sseBroadcaster.broadcast({
    type: 'new_observation',
    observation: payload,
  });
}

/**
 * Broadcast a new summary to SSE clients
 */
export function broadcastSummary(
  worker: WorkerRef | undefined,
  payload: SummarySSEPayload
): void {
  if (!worker?.sseBroadcaster) {
    return;
  }

  worker.sseBroadcaster.broadcast({
    type: 'new_summary',
    summary: payload,
  });
}
