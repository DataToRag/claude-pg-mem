import { describe, it, expect } from 'vitest';
import {
  parseJsonArray,
  toRelativePath,
  extractFirstFile,
  estimateTokens,
  groupByDate,
} from '../../src/shared/timeline-formatting.js';

describe('parseJsonArray', () => {
  it('parses valid JSON array', () => {
    expect(parseJsonArray('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for null', () => {
    expect(parseJsonArray(null)).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseJsonArray('not json')).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    expect(parseJsonArray('{"key":"value"}')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseJsonArray('')).toEqual([]);
  });
});

describe('toRelativePath', () => {
  it('converts absolute path to relative', () => {
    expect(toRelativePath('/Users/me/project/src/index.ts', '/Users/me/project')).toBe('src/index.ts');
  });

  it('returns relative paths unchanged', () => {
    expect(toRelativePath('src/index.ts', '/Users/me/project')).toBe('src/index.ts');
  });
});

describe('extractFirstFile', () => {
  it('returns first modified file', () => {
    expect(extractFirstFile('["src/a.ts","src/b.ts"]', '/project')).toBe('src/a.ts');
  });

  it('falls back to files_read when no modified', () => {
    expect(extractFirstFile(null, '/project', '["src/c.ts"]')).toBe('src/c.ts');
  });

  it('returns General when both empty', () => {
    expect(extractFirstFile(null, '/project', null)).toBe('General');
  });

  it('converts absolute paths to relative', () => {
    expect(extractFirstFile('["/project/src/a.ts"]', '/project')).toBe('src/a.ts');
  });
});

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('12345678')).toBe(2); // 8 chars / 4
  });

  it('rounds up', () => {
    expect(estimateTokens('12345')).toBe(2); // ceil(5/4) = 2
  });

  it('returns 0 for null', () => {
    expect(estimateTokens(null)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('groupByDate', () => {
  it('groups items by date', () => {
    const items = [
      { name: 'a', date: '2025-01-15T10:00:00Z' },
      { name: 'b', date: '2025-01-15T14:00:00Z' },
      { name: 'c', date: '2025-01-16T09:00:00Z' },
    ];
    const grouped = groupByDate(items, (i) => i.date);
    const keys = Array.from(grouped.keys());
    expect(keys).toHaveLength(2);
    // First group has 2 items (same day)
    expect(grouped.get(keys[0])).toHaveLength(2);
    // Second group has 1 item
    expect(grouped.get(keys[1])).toHaveLength(1);
  });

  it('returns empty map for empty array', () => {
    const grouped = groupByDate([], (i: any) => i.date);
    expect(grouped.size).toBe(0);
  });
});
