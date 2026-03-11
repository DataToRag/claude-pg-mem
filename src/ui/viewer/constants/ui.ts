/**
 * UI-related constants
 * Pagination, intersection observer settings, and other UI configuration
 */
export const UI = {
  /** Number of observations to load per page */
  PAGINATION_PAGE_SIZE: 50,

  /** Intersection observer threshold (0-1, percentage of visibility needed to trigger) */
  LOAD_MORE_THRESHOLD: 0.1,

  /** Number of items per column in Projects Board */
  BOARD_ITEMS_PER_COLUMN: 10,

  /** Max concurrent API requests when loading board data */
  BOARD_FETCH_CONCURRENCY: 4,
} as const;
