/**
 * MCP Routes - Streamable HTTP transport for MCP tools
 *
 * Serves the MCP protocol directly from the worker over HTTP,
 * so all Claude Code sessions share one MCP server process.
 *
 * Stateless mode: each request gets its own transport, no session tracking.
 */

import { Router, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { logger } from '../../../utils/logger.js';
import { getWorkerPort, getWorkerHost } from '../../../shared/worker-utils.js';

const WORKER_BASE_URL = `http://${getWorkerHost()}:${getWorkerPort()}`;

/**
 * Call a local worker API endpoint (GET with query params)
 */
async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const response = await fetch(`${WORKER_BASE_URL}${endpoint}?${searchParams}`);
    if (!response.ok) {
      throw new Error(`Worker API error (${response.status}): ${await response.text()}`);
    }
    return await response.json() as { content: Array<{ type: 'text'; text: string }> };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

/**
 * Call a local worker API endpoint (POST with JSON body)
 */
async function callWorkerAPIPost(
  endpoint: string,
  body: Record<string, any>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Worker API error (${response.status}): ${await response.text()}`);
    }
    const data = await response.json();
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

/**
 * Create the shared MCP server with tool definitions
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'claude-pg-mem',
    version: '0.1.0',
  });

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
    async (params) => callWorkerAPI('/api/search', params),
  );

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
    async (params) => callWorkerAPI('/api/timeline', params),
  );

  server.tool(
    'get_observations',
    'Step 3: Fetch full details for filtered IDs. ALWAYS batch for 2+ items.',
    {
      ids: z.array(z.number()).describe('Array of observation IDs to fetch (required)'),
      orderBy: z.string().optional().describe('Sort order: date_desc, date_asc'),
      limit: z.number().optional().describe('Max results'),
      project: z.string().optional().describe('Filter by project'),
    },
    async (params) => callWorkerAPIPost('/api/observations/batch', params),
  );

  return server;
}

export function createMcpRoutes(): Router {
  const router = Router();
  const mcpServer = createMcpServer();

  // POST /mcp - handle MCP JSON-RPC requests (stateless)
  router.post('/mcp', async (req: Request, res: Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      res.on('close', () => { transport.close(); });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('MCP', 'Streamable HTTP error', {}, error as Error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP transport error' });
      }
    }
  });

  // GET /mcp - not supported in stateless mode
  router.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'SSE not supported in stateless mode' });
  });

  // DELETE /mcp - not supported in stateless mode
  router.delete('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'Sessions not supported in stateless mode' });
  });

  logger.info('MCP', 'Streamable HTTP MCP endpoint registered at /mcp');
  return router;
}
