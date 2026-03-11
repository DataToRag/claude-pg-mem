import { useState, useEffect, useMemo, useRef } from 'react';
import { Observation, Summary, FeedItem } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { UI } from '../constants/ui';

interface ProjectsBoardData {
  /** Items per project, keyed by project name */
  projectData: Map<string, FeedItem[]>;
  /** Projects ordered by most recent activity */
  columnOrder: string[];
  /** Whether initial data is still loading */
  isLoading: boolean;
}

/**
 * Fetch with concurrency control.
 * Processes tasks in batches of `concurrency` at a time.
 */
async function fetchWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn => fn()));
    results.push(...batchResults);
  }
  return results;
}

interface ProjectFetchResult {
  project: string;
  observations: Observation[];
  summaries: Summary[];
}

/**
 * Hook for loading per-project data for the kanban board.
 * Fetches latest items per project using existing paginated APIs,
 * and merges in live SSE items.
 */
export function useProjectsBoard(
  projects: string[],
  liveObservations: Observation[],
  liveSummaries: Summary[],
): ProjectsBoardData {
  const [fetchedData, setFetchedData] = useState<Map<string, FeedItem[]>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const prevProjectsRef = useRef<string>('');

  // Fetch data when projects list changes
  useEffect(() => {
    const projectsKey = projects.join(',');
    if (projectsKey === prevProjectsRef.current || projects.length === 0) return;
    prevProjectsRef.current = projectsKey;

    let cancelled = false;

    async function fetchAllProjects() {
      setIsLoading(true);

      const limit = UI.BOARD_ITEMS_PER_COLUMN;
      const tasks = projects.map(project => async (): Promise<ProjectFetchResult> => {
        const [obsRes, sumRes] = await Promise.all([
          fetch(`${API_ENDPOINTS.OBSERVATIONS}?project=${encodeURIComponent(project)}&limit=${limit}&offset=0`),
          fetch(`${API_ENDPOINTS.SUMMARIES}?project=${encodeURIComponent(project)}&limit=${limit}&offset=0`),
        ]);

        const obsData = obsRes.ok ? await obsRes.json() : { items: [] };
        const sumData = sumRes.ok ? await sumRes.json() : { items: [] };

        return {
          project,
          observations: obsData.items ?? [],
          summaries: sumData.items ?? [],
        };
      });

      const results = await fetchWithConcurrency(tasks, UI.BOARD_FETCH_CONCURRENCY);

      if (cancelled) return;

      const data = new Map<string, FeedItem[]>();
      for (const { project, observations, summaries } of results) {
        const items: FeedItem[] = [
          ...observations.map((o: Observation) => ({ ...o, itemType: 'observation' as const })),
          ...summaries.map((s: Summary) => ({ ...s, itemType: 'summary' as const })),
        ];
        items.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
        data.set(project, items.slice(0, limit));
      }

      setFetchedData(data);
      setIsLoading(false);
    }

    fetchAllProjects().catch(() => {
      if (!cancelled) setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [projects]);

  // Merge fetched data with live SSE items
  const { projectData, columnOrder } = useMemo(() => {
    const merged = new Map<string, FeedItem[]>();
    const limit = UI.BOARD_ITEMS_PER_COLUMN;

    // Start with fetched data
    for (const [project, items] of fetchedData) {
      merged.set(project, [...items]);
    }

    // Merge live observations
    for (const obs of liveObservations) {
      const project = obs.project;
      if (!project) continue;
      const items = merged.get(project) ?? [];
      // Add if not already present
      if (!items.some(i => i.itemType === 'observation' && i.id === obs.id)) {
        items.unshift({ ...obs, itemType: 'observation' as const });
        items.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
        merged.set(project, items.slice(0, limit));
      }
    }

    // Merge live summaries
    for (const sum of liveSummaries) {
      const project = sum.project;
      if (!project) continue;
      const items = merged.get(project) ?? [];
      if (!items.some(i => i.itemType === 'summary' && i.id === sum.id)) {
        items.unshift({ ...sum, itemType: 'summary' as const });
        items.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
        merged.set(project, items.slice(0, limit));
      }
    }

    // Order columns by most recent activity
    const order = Array.from(merged.entries())
      .sort(([, a], [, b]) => {
        const aMax = a.length > 0 ? a[0].created_at_epoch : 0;
        const bMax = b.length > 0 ? b[0].created_at_epoch : 0;
        return bMax - aMax;
      })
      .map(([project]) => project);

    return { projectData: merged, columnOrder: order };
  }, [fetchedData, liveObservations, liveSummaries]);

  return { projectData, columnOrder, isLoading };
}
