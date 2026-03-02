/**
 * Project Name Utilities
 *
 * Extract project name from working directory path.
 * Includes worktree detection for unified timelines.
 *
 * Ported from claude-mem — simplified (no worktree.ts dependency for now)
 */

import path from 'path';
import { execSync } from 'child_process';
import { logger } from './logger.js';

/**
 * Extract project name from working directory path
 * Handles edge cases: null/undefined cwd, drive roots, trailing slashes
 *
 * @param cwd - Current working directory (absolute path)
 * @returns Project name or "unknown-project" if extraction fails
 */
export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('SYSTEM', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  // Extract basename (handles trailing slashes automatically)
  const basename = path.basename(cwd);

  // Edge case: Drive roots on Windows (C:\, J:\) or Unix root (/)
  // path.basename('C:\') returns '' (empty string)
  if (basename === '') {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        return `drive-${driveLetter}`;
      }
    }
    logger.warn('SYSTEM', 'Root directory detected, using fallback', { cwd });
    return 'unknown-project';
  }

  return basename;
}

/**
 * Project context with worktree awareness
 */
export interface ProjectContext {
  /** The current project name (worktree or main repo) */
  primary: string;
  /** Parent project name if in a worktree, null otherwise */
  parent: string | null;
  /** True if currently in a worktree */
  isWorktree: boolean;
  /** All projects to query: [primary] for main repo, [parent, primary] for worktree */
  allProjects: string[];
}

/**
 * Detect if cwd is inside a git worktree
 * Returns parent project name if worktree, null otherwise
 */
function detectWorktreeParent(cwd: string): string | null {
  try {
    // git rev-parse --git-common-dir gives the shared .git directory
    // For worktrees, this differs from --git-dir
    const gitDir = execSync('git rev-parse --git-dir', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();

    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();

    // If git-dir != git-common-dir, we're in a worktree
    if (gitDir !== gitCommonDir) {
      // The parent repo is the directory containing .git (git-common-dir)
      const parentRepoPath = path.resolve(cwd, gitCommonDir, '..');
      return path.basename(parentRepoPath);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get project context with worktree detection.
 *
 * When in a worktree, returns both the worktree project name and parent project name
 * for unified timeline queries.
 *
 * @param cwd - Current working directory (absolute path)
 * @returns ProjectContext with worktree info
 */
export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const primary = getProjectName(cwd);

  if (!cwd) {
    return { primary, parent: null, isWorktree: false, allProjects: [primary] };
  }

  const parentProject = detectWorktreeParent(cwd);

  if (parentProject) {
    // In a worktree: include parent first for chronological ordering
    return {
      primary,
      parent: parentProject,
      isWorktree: true,
      allProjects: [parentProject, primary],
    };
  }

  return { primary, parent: null, isWorktree: false, allProjects: [primary] };
}
