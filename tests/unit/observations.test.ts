import { describe, it, expect } from 'vitest';
import { computeObservationContentHash } from '../../src/services/postgres/Observations.js';

describe('computeObservationContentHash', () => {
  it('returns a 16-char hex string', () => {
    const hash = computeObservationContentHash('session-1', 'title', 'narrative');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    const a = computeObservationContentHash('s1', 'Fix bug', 'Fixed the login');
    const b = computeObservationContentHash('s1', 'Fix bug', 'Fixed the login');
    expect(a).toBe(b);
  });

  it('differs for different inputs', () => {
    const a = computeObservationContentHash('s1', 'Fix bug', 'narrative A');
    const b = computeObservationContentHash('s1', 'Fix bug', 'narrative B');
    expect(a).not.toBe(b);
  });

  it('handles null/undefined fields', () => {
    const a = computeObservationContentHash('s1', null, null);
    const b = computeObservationContentHash('s1', undefined, undefined);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differentiates by session ID', () => {
    const a = computeObservationContentHash('session-1', 'title', 'narrative');
    const b = computeObservationContentHash('session-2', 'title', 'narrative');
    expect(a).not.toBe(b);
  });
});
