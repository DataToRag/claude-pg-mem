/**
 * HealthMonitor - Port monitoring, health checks, and version checking
 *
 * Handles:
 * - Port availability checking
 * - Worker health/readiness polling
 * - Version mismatch detection
 * - HTTP-based shutdown requests
 *
 * Ported from claude-mem - simplified (removed MARKETPLACE_ROOT reference).
 */

import path from 'path';
import { readFileSync } from 'fs';
import { logger } from '../../utils/logger.js';

/**
 * Check if a port is in use by querying the health endpoint
 */
export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Poll a localhost endpoint until it returns 200 OK or timeout.
 */
async function pollEndpointUntilOk(
  port: number,
  endpointPath: string,
  timeoutMs: number,
  retryLogMessage: string
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${endpointPath}`);
      if (response.ok) return true;
    } catch (error) {
      logger.debug('SYSTEM', retryLogMessage, { port }, error as Error);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Wait for the worker HTTP server to become responsive (liveness check).
 */
export function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(
    port,
    '/api/health',
    timeoutMs,
    'Service not ready yet, will retry'
  );
}

/**
 * Wait for the worker to be fully initialized (DB + search ready).
 */
export function waitForReadiness(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(
    port,
    '/api/readiness',
    timeoutMs,
    'Worker not ready yet, will retry'
  );
}

/**
 * Wait for a port to become free (no longer responding to health checks)
 */
export async function waitForPortFree(
  port: number,
  timeoutMs: number = 10000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Send HTTP shutdown request to a running worker
 */
export async function httpShutdown(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, {
      method: 'POST',
    });
    if (!response.ok) {
      logger.warn('SYSTEM', 'Shutdown request returned error', {
        port,
        status: response.status,
      });
      return false;
    }
    return true;
  } catch (error) {
    if (error instanceof Error && error.message?.includes('ECONNREFUSED')) {
      logger.debug('SYSTEM', 'Worker already stopped', { port });
      return false;
    }
    logger.error('SYSTEM', 'Shutdown request failed unexpectedly', { port }, error as Error);
    return false;
  }
}

declare const __PLUGIN_VERSION__: string | undefined;

/**
 * Get the plugin version from local package.json.
 * Returns 'unknown' on ENOENT/EBUSY or when import.meta.url is unavailable (CJS bundles).
 */
export function getInstalledPluginVersion(): string {
  // Injected by esbuild at bundle time — works in CJS bundles where import.meta.url is unavailable
  if (typeof __PLUGIN_VERSION__ !== 'undefined') return __PLUGIN_VERSION__;

  try {
    // Look for package.json relative to this module
    const packageJsonPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      '..',
      '..',
      'package.json'
    );
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EBUSY') {
      logger.debug('SYSTEM', 'Could not read plugin version', { code });
    }
    return 'unknown';
  }
}

/**
 * Get the running worker's version via API
 */
export async function getRunningWorkerVersion(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/version`);
    if (!response.ok) return null;
    const data = (await response.json()) as { version: string };
    return data.version;
  } catch {
    logger.debug('SYSTEM', 'Could not fetch worker version', { port });
    return null;
  }
}

export interface VersionCheckResult {
  matches: boolean;
  pluginVersion: string;
  workerVersion: string | null;
}

/**
 * Check if worker version matches plugin version
 */
export async function checkVersionMatch(port: number): Promise<VersionCheckResult> {
  const pluginVersion = getInstalledPluginVersion();
  const workerVersion = await getRunningWorkerVersion(port);

  if (!workerVersion || pluginVersion === 'unknown') {
    return { matches: true, pluginVersion, workerVersion };
  }

  return {
    matches: pluginVersion === workerVersion,
    pluginVersion,
    workerVersion,
  };
}
