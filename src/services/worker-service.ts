/**
 * Worker Service - Main Orchestrator
 *
 * The central daemon process for claude-pg-mem.
 * Starts the Express HTTP server, initializes database,
 * sets up SessionManager, and handles process lifecycle.
 *
 * Commands:
 *   start   - Start the worker daemon
 *   stop    - Stop the running worker
 *   restart - Restart the worker
 *   status  - Check worker status
 *
 * Ported from claude-mem's 300-line orchestrator.
 * Simplified: removed Chroma, MCP client, Cursor integration, Gemini/OpenRouter agents.
 */

import path from 'path';
import { readFileSync } from 'fs';
import { logger } from '../utils/logger.js';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../shared/paths.js';
import { getDb } from './postgres/client.js';
import { resetStaleProcessingMessages } from './postgres/PendingMessageStore.js';

// Infrastructure
import {
  writePidFile,
  readPidFile,
  removePidFile,
  cleanStalePidFile,
  isProcessAlive,
  createSignalHandler,
  cleanupOrphanedProcesses,
  spawnDaemon,
} from './infrastructure/ProcessManager.js';
import {
  isPortInUse,
  waitForHealth,
  httpShutdown,
  waitForPortFree,
  checkVersionMatch,
} from './infrastructure/HealthMonitor.js';
import { performGracefulShutdown } from './infrastructure/GracefulShutdown.js';

// Server
import { createServer, SessionManager, SSEBroadcaster } from './server/index.js';

// Embeddings
import { noopEmbedder, createNomicEmbedder } from '../embeddings/index.js';
import type { EmbedFn } from '../embeddings/index.js';

// Mode config
import type { ModeConfig } from './domain/types.js';

// Orphan reaper
import { startOrphanReaper } from './worker/ProcessRegistry.js';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

declare const __PLUGIN_VERSION__: string | undefined;

function getPackageVersion(): string {
  // Injected by esbuild at bundle time
  if (typeof __PLUGIN_VERSION__ !== 'undefined') return __PLUGIN_VERSION__;
  try {
    const packageJsonPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      '..',
      'package.json',
    );
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.1.0';
  }
}

// ---------------------------------------------------------------------------
// Embedding setup
// ---------------------------------------------------------------------------

function createEmbedFn(): EmbedFn {
  // Use Nomic Embed Text v1 — runs locally, no API key needed
  // Same approach as claude-mem's ChromaDB (local sentence-transformers model)
  logger.info('SYSTEM', 'Nomic Embed Text v1 embeddings enabled (local, 768 dims)');
  return createNomicEmbedder();
}

// ---------------------------------------------------------------------------
// Mode config loading
// ---------------------------------------------------------------------------

/**
 * Load mode configuration.
 * For now, returns a minimal default mode. A full mode system can be added later.
 */
function loadModeConfig(): ModeConfig {
  // Try loading from user settings directory
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const dataDir = settings.CLAUDE_PG_MEM_DATA_DIR;

  try {
    const modePath = path.join(dataDir, 'mode.json');
    const modeJson = readFileSync(modePath, 'utf-8');
    return JSON.parse(modeJson) as ModeConfig;
  } catch {
    // No custom mode — use defaults
  }

  // Try loading from package modes directory
  try {
    const packageModePath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      '..',
      'modes',
      'default.json',
    );
    const modeJson = readFileSync(packageModePath, 'utf-8');
    return JSON.parse(modeJson) as ModeConfig;
  } catch {
    // No packaged mode — use minimal inline default
  }

  // Minimal default mode for when no mode file is found
  return {
    name: 'default',
    description: 'Default observation mode',
    version: '1.0.0',
    observation_types: [
      { id: 'decision', label: 'Decision', description: 'Architectural or design decision', emoji: '', work_emoji: '' },
      { id: 'bugfix', label: 'Bug Fix', description: 'Bug identified and fixed', emoji: '', work_emoji: '' },
      { id: 'feature', label: 'Feature', description: 'New feature implemented', emoji: '', work_emoji: '' },
      { id: 'refactor', label: 'Refactor', description: 'Code restructuring', emoji: '', work_emoji: '' },
      { id: 'discovery', label: 'Discovery', description: 'Key insight or finding', emoji: '', work_emoji: '' },
      { id: 'change', label: 'Change', description: 'Notable change', emoji: '', work_emoji: '' },
    ],
    observation_concepts: [],
    prompts: {
      system_identity: 'You are a memory observer agent.',
      spatial_awareness: '',
      observer_role: 'You observe Claude Code sessions and extract structured observations.',
      recording_focus: 'Record what was done, how it works, and why it matters.',
      skip_guidance: 'Skip trivial operations like ls or pwd.',
      type_guidance: 'Use observation types: decision, bugfix, feature, refactor, discovery, change.',
      concept_guidance: '',
      field_guidance: '',
      output_format_header: 'Respond with XML observations.',
      format_examples: '',
      footer: '',
      xml_title_placeholder: '[Short title]',
      xml_subtitle_placeholder: '[One sentence explanation]',
      xml_fact_placeholder: '[Concise fact]',
      xml_narrative_placeholder: '[Full context]',
      xml_concept_placeholder: '[concept]',
      xml_file_placeholder: '[path/to/file]',
      xml_summary_request_placeholder: '[Request summary]',
      xml_summary_investigated_placeholder: '[What was explored]',
      xml_summary_learned_placeholder: '[What was learned]',
      xml_summary_completed_placeholder: '[What was completed]',
      xml_summary_next_steps_placeholder: '[Next steps]',
      xml_summary_notes_placeholder: '[Additional notes]',
      header_memory_start: 'MEMORY PROCESSING START\n=======================',
      header_memory_continued: 'MEMORY PROCESSING CONTINUED\n===========================',
      header_summary_checkpoint: 'PROGRESS SUMMARY CHECKPOINT\n===========================',
      continuation_greeting: 'Hello memory agent, you are continuing to observe the primary Claude session.',
      continuation_instruction: 'Continue generating observations from tool use messages using the XML structure.',
      summary_instruction: 'Write a progress summary for this session.',
      summary_context_label: "Claude's Response:",
      summary_format_instruction: 'Respond in XML format:',
      summary_footer: '',
    },
  };
}

// ---------------------------------------------------------------------------
// Worker Service Class
// ---------------------------------------------------------------------------

export class WorkerService {
  private sessionManager: SessionManager | null = null;
  private sseBroadcaster: SSEBroadcaster | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private isShuttingDown = false;
  private stopOrphanReaper: (() => void) | null = null;

  /**
   * Start the worker as a foreground daemon process.
   * Called when --daemon flag is passed.
   */
  async startDaemon(): Promise<void> {
    const port = getWorkerPort();
    const host = getWorkerHost();
    const version = getPackageVersion();

    logger.info('SYSTEM', `Worker daemon starting v${version}`, { port, host, pid: process.pid });

    // Clean up stale PID files from dead workers
    cleanStalePidFile();

    // Clean up orphaned processes from previous instances
    await cleanupOrphanedProcesses();

    // Initialize database connection
    try {
      const db = getDb();
      logger.info('SYSTEM', 'Database connection established');

      // Reset stale processing messages (from previous worker crashes)
      await resetStaleProcessingMessages(db);
    } catch (error) {
      logger.error('SYSTEM', 'Database initialization failed', {}, error as Error);
      throw error;
    }

    // Initialize embeddings
    const embedFn = createEmbedFn();

    // Load mode configuration
    const modeConfig = loadModeConfig();
    logger.info('SYSTEM', `Mode loaded: ${modeConfig.name}`);

    // Create SSE broadcaster for real-time viewer updates
    this.sseBroadcaster = new SSEBroadcaster();

    // Create session manager
    this.sessionManager = new SessionManager(embedFn, modeConfig, this.sseBroadcaster);

    // Create and start HTTP server
    this.server = createServer({
      sessionManager: this.sessionManager,
      embedFn,
      sseBroadcaster: this.sseBroadcaster,
    });

    await this.server.listen(port, host);

    // Write PID file
    writePidFile({
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
    });

    // Start orphan reaper (background cleanup of zombie claude processes)
    const sessionMgr = this.sessionManager!;
    this.stopOrphanReaper = startOrphanReaper(() => sessionMgr.getActiveSessionIds());

    // Register signal handlers for graceful shutdown
    const shutdownRef = { value: false };
    const handleSignal = createSignalHandler(
      () => this.performShutdown(),
      shutdownRef,
    );

    process.on('SIGTERM', () => handleSignal('SIGTERM'));
    process.on('SIGINT', () => handleSignal('SIGINT'));

    logger.info('SYSTEM', `Worker daemon ready on ${host}:${port} (PID ${process.pid})`);
  }

  /**
   * Perform graceful shutdown
   */
  private async performShutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('SYSTEM', 'Shutdown initiated');

    // Stop orphan reaper
    if (this.stopOrphanReaper) {
      this.stopOrphanReaper();
    }

    // Use infrastructure shutdown
    await performGracefulShutdown({
      server: this.server?.httpServer ?? null,
      sessionManager: this.sessionManager ?? { shutdownAll: async () => {} },
    });
  }

  // =========================================================================
  // CLI Commands
  // =========================================================================

  /**
   * Start command — spawn daemon or verify existing worker
   */
  static async start(): Promise<void> {
    const port = getWorkerPort();

    // Check if already running
    if (await isPortInUse(port)) {
      // Verify version match
      const versionCheck = await checkVersionMatch(port);
      if (versionCheck.matches) {
        logger.info('SYSTEM', 'Worker already running on port', { port });
        return;
      }

      // Version mismatch — restart
      logger.info('SYSTEM', 'Version mismatch, restarting worker', {
        installed: versionCheck.pluginVersion,
        running: versionCheck.workerVersion,
      });
      await WorkerService.stop();
    }

    // Clean stale PID file
    cleanStalePidFile();

    // Find the worker entry script
    // In plugin context: use the bundled worker-service.cjs
    // In dev/dist context: use dist/index.js (CLI entry, handles --daemon)
    let workerScript: string;
    if (!process.env.CLAUDE_PLUGIN_ROOT) {
      throw new Error('CLAUDE_PLUGIN_ROOT is not set — run via claude-pg-mem CLI or Claude Code plugin');
    }
    workerScript = path.join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'worker-service.cjs');

    logger.info('SYSTEM', 'Spawning worker daemon', { port, script: workerScript });

    const childPid = spawnDaemon(workerScript, port);
    if (childPid === undefined) {
      logger.error('SYSTEM', 'Failed to spawn worker daemon');
      return;
    }

    // Wait for health
    const healthy = await waitForHealth(port, 30_000);
    if (healthy) {
      logger.info('SYSTEM', 'Worker daemon started successfully', { port, pid: childPid });
    } else {
      logger.error('SYSTEM', 'Worker daemon failed to become healthy', { port });
    }
  }

  /**
   * Stop command — send shutdown to running worker
   */
  static async stop(): Promise<void> {
    const port = getWorkerPort();

    if (!(await isPortInUse(port))) {
      logger.info('SYSTEM', 'No worker running on port', { port });
      cleanStalePidFile();
      return;
    }

    logger.info('SYSTEM', 'Stopping worker', { port });
    const success = await httpShutdown(port);

    if (success) {
      // Wait for port to be released
      await waitForPortFree(port, 10_000);
      logger.info('SYSTEM', 'Worker stopped');
    } else {
      // Force kill via PID file
      const pidInfo = readPidFile();
      if (pidInfo && isProcessAlive(pidInfo.pid)) {
        try {
          process.kill(pidInfo.pid, 'SIGKILL');
          logger.info('SYSTEM', 'Force killed worker', { pid: pidInfo.pid });
        } catch {
          logger.warn('SYSTEM', 'Failed to force kill worker');
        }
      }
      removePidFile();
    }
  }

  /**
   * Restart command — stop then start
   */
  static async restart(): Promise<void> {
    await WorkerService.stop();
    await WorkerService.start();
  }

  /**
   * Status command — check if worker is running and report info
   */
  static async status(): Promise<{
    running: boolean;
    port: number;
    pid?: number;
    version?: string;
    uptime?: number;
  }> {
    const port = getWorkerPort();

    if (!(await isPortInUse(port))) {
      return { running: false, port };
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const health = (await response.json()) as {
          status: string;
          version: string;
          uptime: number;
          pid: number;
        };
        return {
          running: true,
          port,
          pid: health.pid,
          version: health.version,
          uptime: health.uptime,
        };
      }
    } catch {
      // Health check failed
    }

    // Port in use but health check failed — likely not our worker
    const pidInfo = readPidFile();
    return {
      running: false,
      port,
      pid: pidInfo?.pid,
    };
  }
}
