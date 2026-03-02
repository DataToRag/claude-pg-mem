/**
 * ProcessManager - PID files, signal handlers, and child process lifecycle management
 *
 * Handles:
 * - PID file management for daemon coordination
 * - Signal handler registration for graceful shutdown
 * - Child process enumeration and cleanup
 *
 * Ported from claude-mem - adapted for claude-pg-memory paths.
 * Removed Bun-specific runtime resolution (Node.js only).
 * Removed Chroma migration logic (not applicable to Postgres backend).
 */

import path from 'path';
import { homedir } from 'os';
import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
  utimesSync,
} from 'fs';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { HOOK_TIMEOUTS } from '../../shared/hook-constants.js';

const execAsync = promisify(exec);

// Standard paths for PID file management
const DATA_DIR = path.join(homedir(), '.claude-pg-memory');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

// Orphaned process cleanup patterns and thresholds
const ORPHAN_PROCESS_PATTERNS = [
  'worker-service.cjs', // Background worker daemon
];

const ORPHAN_MAX_AGE_MINUTES = 30;

export interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
}

/**
 * Write PID info to the standard PID file location
 */
export function writePidFile(info: PidInfo): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify(info, null, 2));
}

/**
 * Read PID info from the standard PID file location
 */
export function readPidFile(): PidInfo | null {
  if (!existsSync(PID_FILE)) return null;

  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf-8'));
  } catch (error) {
    logger.warn('SYSTEM', 'Failed to parse PID file', { path: PID_FILE }, error as Error);
    return null;
  }
}

/**
 * Remove the PID file (called during shutdown)
 */
export function removePidFile(): void {
  if (!existsSync(PID_FILE)) return;

  try {
    unlinkSync(PID_FILE);
  } catch (error) {
    logger.warn('SYSTEM', 'Failed to remove PID file', { path: PID_FILE }, error as Error);
  }
}

/**
 * Get platform-adjusted timeout for worker-side socket operations (2.0x on Windows).
 */
export function getPlatformTimeout(baseMs: number): number {
  const WINDOWS_MULTIPLIER = 2.0;
  return process.platform === 'win32' ? Math.round(baseMs * WINDOWS_MULTIPLIER) : baseMs;
}

/**
 * Get all child process PIDs (Windows-specific)
 */
export async function getChildProcesses(parentPid: number): Promise<number[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    logger.warn('SYSTEM', 'Invalid parent PID for child process enumeration', { parentPid });
    return [];
  }

  try {
    const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Select-Object -ExpandProperty ProcessId"`;
    const { stdout } = await execAsync(cmd, {
      timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND,
      windowsHide: true,
    });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && /^\d+$/.test(line))
      .map((line) => parseInt(line, 10))
      .filter((pid) => pid > 0);
  } catch (error) {
    logger.error('SYSTEM', 'Failed to enumerate child processes', { parentPid }, error as Error);
    return [];
  }
}

/**
 * Force kill a process by PID
 */
export async function forceKillProcess(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    logger.warn('SYSTEM', 'Invalid PID for force kill', { pid });
    return;
  }

  try {
    if (process.platform === 'win32') {
      await execAsync(`taskkill /PID ${pid} /T /F`, {
        timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND,
        windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    logger.info('SYSTEM', 'Killed process', { pid });
  } catch (error) {
    logger.debug('SYSTEM', 'Process already exited during force kill', { pid }, error as Error);
  }
}

/**
 * Wait for processes to fully exit
 */
export async function waitForProcessesExit(pids: number[], timeoutMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const stillAlive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

    if (stillAlive.length === 0) {
      logger.info('SYSTEM', 'All child processes exited');
      return;
    }

    logger.debug('SYSTEM', 'Waiting for processes to exit', { stillAlive });
    await new Promise((r) => setTimeout(r, 100));
  }

  logger.warn('SYSTEM', 'Timeout waiting for child processes to exit');
}

/**
 * Parse process elapsed time from ps etime format: [[DD-]HH:]MM:SS
 */
export function parseElapsedTime(etime: string): number {
  if (!etime || etime.trim() === '') return -1;

  const cleaned = etime.trim();

  // DD-HH:MM:SS format
  const dayMatch = cleaned.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayMatch) {
    return (
      parseInt(dayMatch[1], 10) * 24 * 60 +
      parseInt(dayMatch[2], 10) * 60 +
      parseInt(dayMatch[3], 10)
    );
  }

  // HH:MM:SS format
  const hourMatch = cleaned.match(/^(\d+):(\d+):(\d+)$/);
  if (hourMatch) {
    return parseInt(hourMatch[1], 10) * 60 + parseInt(hourMatch[2], 10);
  }

  // MM:SS format
  const minMatch = cleaned.match(/^(\d+):(\d+)$/);
  if (minMatch) {
    return parseInt(minMatch[1], 10);
  }

  return -1;
}

/**
 * Clean up orphaned processes from previous worker sessions
 */
export async function cleanupOrphanedProcesses(): Promise<void> {
  const isWindows = process.platform === 'win32';
  const currentPid = process.pid;
  const pidsToKill: number[] = [];

  try {
    if (isWindows) {
      const wqlPatternConditions = ORPHAN_PROCESS_PATTERNS.map(
        (p) => `CommandLine LIKE '%${p}%'`
      ).join(' OR ');

      const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter '(${wqlPatternConditions}) AND ProcessId != ${currentPid}' | Select-Object ProcessId, CreationDate | ConvertTo-Json"`;
      const { stdout } = await execAsync(cmd, {
        timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND,
        windowsHide: true,
      });

      if (!stdout.trim() || stdout.trim() === 'null') {
        return;
      }

      const processes = JSON.parse(stdout);
      const processList = Array.isArray(processes) ? processes : [processes];
      const now = Date.now();

      for (const proc of processList) {
        const pid = proc.ProcessId;
        if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) continue;

        const creationMatch = proc.CreationDate?.match(/\/Date\((\d+)\)\//);
        if (creationMatch) {
          const creationTime = parseInt(creationMatch[1], 10);
          const ageMinutes = (now - creationTime) / (1000 * 60);

          if (ageMinutes >= ORPHAN_MAX_AGE_MINUTES) {
            pidsToKill.push(pid);
          }
        }
      }
    } else {
      const patternRegex = ORPHAN_PROCESS_PATTERNS.join('|');
      const { stdout } = await execAsync(
        `ps -eo pid,etime,command | grep -E "${patternRegex}" | grep -v grep || true`
      );

      if (!stdout.trim()) {
        return;
      }

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) continue;

        const pid = parseInt(match[1], 10);
        const etime = match[2];

        if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) continue;

        const ageMinutes = parseElapsedTime(etime);
        if (ageMinutes >= ORPHAN_MAX_AGE_MINUTES) {
          pidsToKill.push(pid);
        }
      }
    }
  } catch (error) {
    logger.error('SYSTEM', 'Failed to enumerate orphaned processes', {}, error as Error);
    return;
  }

  if (pidsToKill.length === 0) {
    return;
  }

  logger.info('SYSTEM', 'Cleaning up orphaned processes', {
    count: pidsToKill.length,
    pids: pidsToKill,
  });

  for (const pid of pidsToKill) {
    try {
      if (isWindows) {
        if (Number.isInteger(pid) && pid > 0) {
          execSync(`taskkill /PID ${pid} /T /F`, {
            timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND,
            stdio: 'ignore',
            windowsHide: true,
          });
        }
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch (error) {
      logger.debug('SYSTEM', 'Failed to kill process, may have already exited', {
        pid,
      });
    }
  }

  logger.info('SYSTEM', 'Orphaned processes cleaned up', { count: pidsToKill.length });
}

/**
 * Check if a process with the given PID is alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (pid === 0) return true;
  if (!Number.isInteger(pid) || pid < 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Check if the PID file was written recently (within thresholdMs).
 */
export function isPidFileRecent(thresholdMs: number = 15000): boolean {
  try {
    const stats = statSync(PID_FILE);
    return Date.now() - stats.mtimeMs < thresholdMs;
  } catch {
    return false;
  }
}

/**
 * Touch the PID file to update its mtime without changing contents.
 */
export function touchPidFile(): void {
  try {
    if (!existsSync(PID_FILE)) return;
    const now = new Date();
    utimesSync(PID_FILE, now, now);
  } catch {
    // Best-effort
  }
}

/**
 * Remove stale PID file if the recorded process is dead.
 */
export function cleanStalePidFile(): void {
  const pidInfo = readPidFile();
  if (!pidInfo) return;

  if (!isProcessAlive(pidInfo.pid)) {
    logger.info('SYSTEM', 'Removing stale PID file (worker process is dead)', {
      pid: pidInfo.pid,
      port: pidInfo.port,
      startedAt: pidInfo.startedAt,
    });
    removePidFile();
  }
}

/**
 * Spawn a detached daemon process
 * Returns the child PID or undefined if spawn failed
 */
export function spawnDaemon(
  scriptPath: string,
  port: number,
  extraEnv: Record<string, string> = {}
): number | undefined {
  const env = {
    ...process.env,
    CLAUDE_PG_MEMORY_WORKER_PORT: String(port),
    ...extraEnv,
  };

  if (process.platform === 'win32') {
    // Windows: Use PowerShell Start-Process
    const escapedExecPath = process.execPath.replace(/'/g, "''");
    const escapedScriptPath = scriptPath.replace(/'/g, "''");
    const psCommand = `Start-Process -FilePath '${escapedExecPath}' -ArgumentList '${escapedScriptPath}','--daemon' -WindowStyle Hidden`;

    try {
      execSync(`powershell -NoProfile -Command "${psCommand}"`, {
        stdio: 'ignore',
        windowsHide: true,
        env,
      });
      return 0;
    } catch (error) {
      logger.error('SYSTEM', 'Failed to spawn worker daemon on Windows', {}, error as Error);
      return undefined;
    }
  }

  // Unix: Use setsid if available to fully detach
  const setsidPath = '/usr/bin/setsid';
  if (existsSync(setsidPath)) {
    const child = spawn(setsidPath, [process.execPath, scriptPath, '--daemon'], {
      detached: true,
      stdio: 'ignore',
      env,
    });

    if (child.pid === undefined) return undefined;

    child.unref();
    return child.pid;
  }

  // Fallback: standard detached spawn (macOS, systems without setsid)
  const child = spawn(process.execPath, [scriptPath, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    env,
  });

  if (child.pid === undefined) return undefined;

  child.unref();
  return child.pid;
}

/**
 * Create signal handler factory for graceful shutdown
 */
export function createSignalHandler(
  shutdownFn: () => Promise<void>,
  isShuttingDownRef: { value: boolean }
): (signal: string) => Promise<void> {
  return async (signal: string) => {
    if (isShuttingDownRef.value) {
      logger.warn('SYSTEM', `Received ${signal} but shutdown already in progress`);
      return;
    }
    isShuttingDownRef.value = true;

    logger.info('SYSTEM', `Received ${signal}, shutting down...`);
    try {
      await shutdownFn();
      process.exit(0);
    } catch (error) {
      logger.error('SYSTEM', 'Error during shutdown', {}, error as Error);
      process.exit(0);
    }
  };
}
