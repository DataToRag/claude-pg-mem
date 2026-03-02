/**
 * claude-pg-memory MCP Search Server - Thin HTTP Wrapper
 *
 * Delegates all business logic to Worker HTTP API.
 * Maintains MCP protocol handling and tool schemas.
 *
 * Exposes 3 tools following the progressive disclosure pattern:
 *   1. search - Index with IDs (~50-100 tokens/result)
 *   2. timeline - Context around results (~200-500 tokens)
 *   3. get_observations - Full details for filtered IDs (~500-1000 tokens/result)
 *
 * Uses @modelcontextprotocol/sdk with stdio transport.
 */

// Import logger first
import { logger } from '../utils/logger.js';

// CRITICAL: Redirect console to stderr BEFORE other imports.
// MCP uses stdio transport where stdout is reserved for JSON-RPC protocol messages.
// Any logs to stdout break the protocol.
const _originalLog = console['log'];
console['log'] = (...args: any[]) => {
  logger.error(
    'SYSTEM',
    'Intercepted console output (MCP protocol protection)',
    undefined,
    { args },
  );
};

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';

/**
 * Worker HTTP API configuration
 */
const WORKER_PORT = getWorkerPort();
const WORKER_HOST = getWorkerHost();
const WORKER_BASE_URL = `http://${WORKER_HOST}:${WORKER_PORT}`;

/**
 * Call Worker HTTP API endpoint (GET with query params)
 */
async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  logger.debug('SYSTEM', '-> Worker API', undefined, { endpoint, params });

  try {
    const searchParams = new URLSearchParams();

    // Convert params to query string
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }

    const url = `${WORKER_BASE_URL}${endpoint}?${searchParams}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: 'text'; text: string }>;
      isError?: boolean;
    };

    logger.debug('SYSTEM', '<- Worker API success', undefined, { endpoint });

    // Worker returns { content: [...] } format directly
    return data;
  } catch (error) {
    logger.error(
      'SYSTEM',
      '<- Worker API error',
      { endpoint },
      error as Error,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Call Worker HTTP API with POST body
 */
async function callWorkerAPIPost(
  endpoint: string,
  body: Record<string, any>,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  logger.debug('HTTP', 'Worker API request (POST)', undefined, { endpoint });

  try {
    const url = `${WORKER_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    logger.debug('HTTP', 'Worker API success (POST)', undefined, { endpoint });

    // Wrap raw data in MCP format
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  } catch (error) {
    logger.error(
      'HTTP',
      'Worker API error (POST)',
      { endpoint },
      error as Error,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Verify Worker is accessible
 */
async function verifyWorkerConnection(): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}/api/health`);
    return response.ok;
  } catch (error) {
    // Expected during worker startup or if worker is down
    logger.debug('SYSTEM', 'Worker health check failed', {}, error as Error);
    return false;
  }
}

// =============================================================================
// Create the MCP server using McpServer (high-level API)
// =============================================================================

const server = new McpServer({
  name: 'claude-pg-memory',
  version: '0.1.0',
});

// ---------------------------------------------------------------------------
// Tool 1: search (~50-100 tokens/result)
// Step 1 in the 3-layer progressive disclosure pattern.
// Returns compact index with IDs, titles, dates, relevance scores.
// ---------------------------------------------------------------------------
server.tool(
  'search',
  `Step 1: Search memory. Returns index with IDs. Params: query, limit, project, type, obs_type, dateStart, dateEnd, offset, orderBy.
3-LAYER WORKFLOW: search -> timeline -> get_observations. NEVER fetch full details without filtering first.`,
  {
    query: z.string().optional().describe('Search query text for semantic search'),
    project: z.string().optional().describe('Filter by project name'),
    type: z.string().optional().describe('Filter type: observations, sessions, prompts'),
    obs_type: z.string().optional().describe('Observation type filter (comma-separated): bugfix,feature,refactor,discovery,decision,change'),
    limit: z.number().optional().default(20).describe('Max results to return'),
    offset: z.number().optional().default(0).describe('Skip first N results for pagination'),
    dateStart: z.string().optional().describe('Start date (ISO string or epoch)'),
    dateEnd: z.string().optional().describe('End date (ISO string or epoch)'),
    orderBy: z.string().optional().default('date_desc').describe('Sort order: date_desc, date_asc, relevance'),
  },
  async (params) => {
    return await callWorkerAPI('/api/search', params);
  },
);

// ---------------------------------------------------------------------------
// Tool 2: timeline (~200-500 tokens)
// Step 2 in the 3-layer pattern.
// Returns chronological context around an observation.
// ---------------------------------------------------------------------------
server.tool(
  'timeline',
  'Step 2: Get context around results. Params: anchor (observation ID), depth_before, depth_after, project',
  {
    anchor: z.number().optional().describe('Observation ID to center timeline on'),
    query: z.string().optional().describe('Query text to find anchor automatically'),
    depth_before: z.number().optional().default(3).describe('Number of items before anchor'),
    depth_after: z.number().optional().default(3).describe('Number of items after anchor'),
    project: z.string().optional().describe('Filter by project name'),
  },
  async (params) => {
    return await callWorkerAPI('/api/timeline', params);
  },
);

// ---------------------------------------------------------------------------
// Tool 3: get_observations (~500-1000 tokens/result)
// Step 3 in the 3-layer pattern.
// Returns full observation details for specific IDs.
// ---------------------------------------------------------------------------
server.tool(
  'get_observations',
  'Step 3: Fetch full details for filtered IDs. ALWAYS batch for 2+ items.',
  {
    ids: z.array(z.number()).describe('Array of observation IDs to fetch (required)'),
    orderBy: z.string().optional().describe('Sort order: date_desc, date_asc'),
    limit: z.number().optional().describe('Max results'),
    project: z.string().optional().describe('Filter by project'),
  },
  async (params) => {
    return await callWorkerAPIPost('/api/observations/batch', params);
  },
);

// =============================================================================
// Parent heartbeat: self-exit when parent dies
// =============================================================================

const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startParentHeartbeat() {
  // ppid-based orphan detection only works on Unix
  if (process.platform === 'win32') return;

  const initialPpid = process.ppid;
  heartbeatTimer = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialPpid) {
      logger.info('SYSTEM', 'Parent process died, self-exiting to prevent orphan', {
        initialPpid,
        currentPpid: process.ppid,
      });
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Don't let the heartbeat timer keep the process alive
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function cleanup() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  logger.info('SYSTEM', 'MCP server shutting down');
  process.exit(0);
}

// Register cleanup handlers for graceful shutdown
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// =============================================================================
// Start the server
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('SYSTEM', 'claude-pg-memory MCP search server started');

  // Start parent heartbeat to detect orphaned MCP servers
  startParentHeartbeat();

  // Check Worker availability in background
  setTimeout(async () => {
    const workerAvailable = await verifyWorkerConnection();
    if (!workerAvailable) {
      logger.error('SYSTEM', 'Worker not available', undefined, {
        workerUrl: WORKER_BASE_URL,
      });
      logger.error('SYSTEM', 'Tools will fail until Worker is started');
      logger.error('SYSTEM', 'Start Worker with: pnpm run worker:start');
    } else {
      logger.info('SYSTEM', 'Worker available', undefined, {
        workerUrl: WORKER_BASE_URL,
      });
    }
  }, 0);
}

main().catch(error => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  process.exit(0);
});
