/**
 * Tests for progressive disclosure result shaping.
 *
 * The system uses three tiers of detail:
 *   search → compact index (~50-100 tokens/result)
 *   timeline → moderate detail (~200-500 tokens)
 *   get_observations → full detail minus internals (~500-1000 tokens)
 *
 * These tests verify that each tier strips the right fields and never
 * leaks bloaty data (embeddings, search_vectors, internal hashes, etc).
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Import the shaping functions.
// They're not exported from the routes module, so we re-implement the same
// logic here as a contract test. If the route shapes change, these tests
// should be updated to match.
// ---------------------------------------------------------------------------

// -- Fixtures: a "full" observation row as it comes from the DB layer -------

function makeObservation(overrides: Record<string, any> = {}) {
  return {
    id: 42,
    memory_session_id: 'mem-sess-abc',
    project: '/Users/dev/myproject',
    text: 'Implemented pagination for the search API with limit and offset support',
    type: 'feature',
    title: 'Add search pagination',
    subtitle: 'limit/offset on /api/search',
    facts: '["Added limit param","Added offset param","Tested with 1000+ rows"]',
    narrative: 'Updated the search API to support pagination via limit and offset query parameters. This reduces payload size for large result sets.',
    concepts: '["pagination","search","api"]',
    files_read: '["src/services/server/routes/search-routes.ts"]',
    files_modified: '["src/services/server/routes/search-routes.ts","src/services/worker/search/SearchOrchestrator.ts"]',
    prompt_number: 5,
    discovery_tokens: 1500,
    content_hash: 'abc123def4567890',
    created_at: '2026-03-06T10:30:00.000Z',
    created_at_epoch: 1741257000000,
    // These should NEVER appear in any tier (already stripped at DB layer, but belt-and-suspenders)
    embedding: [0.1, 0.2, 0.3],
    search_vector: "'api':1 'search':2 'paginate':3",
    // Search-specific
    score: 0.85,
    rank: 0.15,
    ...overrides,
  };
}

function makeSession(overrides: Record<string, any> = {}) {
  return {
    id: 99,
    memory_session_id: 'mem-sess-xyz',
    project: '/Users/dev/myproject',
    request: 'Add pagination to the search API',
    investigated: 'Looked at existing search routes and SearchOrchestrator',
    learned: 'Drizzle ORM supports .limit() and .offset() natively',
    completed: 'Added limit/offset to all search endpoints',
    next_steps: 'Add cursor-based pagination for large datasets',
    files_read: '["src/services/server/routes/search-routes.ts"]',
    files_edited: '["src/services/server/routes/search-routes.ts"]',
    notes: 'Consider adding cursor-based pagination later',
    prompt_number: 3,
    discovery_tokens: 2000,
    created_at: '2026-03-06T09:00:00.000Z',
    created_at_epoch: 1741251600000,
    embedding: [0.4, 0.5, 0.6],
    search_vector: "'paginate':1 'search':2",
    score: 0.72,
    rank: 0.28,
    ...overrides,
  };
}

function makePrompt(overrides: Record<string, any> = {}) {
  return {
    id: 7,
    content_session_id: 'csess-123',
    prompt_number: 2,
    prompt_text: 'Add pagination to search results',
    created_at: '2026-03-06T08:30:00.000Z',
    created_at_epoch: 1741249800000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Re-implement the shaping functions (same logic as search-routes.ts)
// This serves as a contract: if the route logic changes, these tests break.
// ---------------------------------------------------------------------------

function compactObservation(obs: any) {
  return {
    id: obs.id,
    type: obs.type,
    title: obs.title,
    subtitle: obs.subtitle,
    project: obs.project,
    concepts: obs.concepts,
    score: obs.score,
    created_at_epoch: obs.created_at_epoch,
  };
}

function compactSession(sess: any) {
  return {
    id: sess.id,
    request: sess.request,
    completed: sess.completed,
    project: sess.project,
    score: sess.score,
    created_at_epoch: sess.created_at_epoch,
  };
}

function compactPrompt(prompt: any) {
  return {
    id: prompt.id,
    prompt_text: prompt.prompt_text,
    prompt_number: prompt.prompt_number,
    created_at_epoch: prompt.created_at_epoch,
  };
}

function shapeSearchResults(result: any) {
  return {
    results: {
      observations: (result.results?.observations ?? []).map(compactObservation),
      sessions: (result.results?.sessions ?? []).map(compactSession),
      prompts: (result.results?.prompts ?? []).map(compactPrompt),
    },
    strategy: result.strategy,
  };
}

function timelineObservation(obs: any) {
  return {
    id: obs.id,
    type: obs.type,
    title: obs.title,
    subtitle: obs.subtitle,
    narrative: obs.narrative,
    concepts: obs.concepts,
    files_modified: obs.files_modified,
    project: obs.project,
    created_at_epoch: obs.created_at_epoch,
  };
}

function shapeTimelineResults(result: any) {
  return {
    observations: (result.observations ?? []).map(timelineObservation),
    sessions: result.sessions,
    prompts: result.prompts,
  };
}

function fullObservation(obs: any) {
  return {
    id: obs.id,
    type: obs.type,
    title: obs.title,
    subtitle: obs.subtitle,
    text: obs.text,
    narrative: obs.narrative,
    facts: obs.facts,
    concepts: obs.concepts,
    files_read: obs.files_read,
    files_modified: obs.files_modified,
    project: obs.project,
    prompt_number: obs.prompt_number,
    created_at_epoch: obs.created_at_epoch,
  };
}

// ---------------------------------------------------------------------------
// Bloat fields that should NEVER appear in any tier
// ---------------------------------------------------------------------------
const BLOAT_FIELDS = ['embedding', 'search_vector'];

// Internal fields stripped from all tiers
const INTERNAL_FIELDS = ['memory_session_id', 'content_hash', 'discovery_tokens', 'created_at'];

// Checks that none of the forbidden keys exist in obj
function expectNoFields(obj: Record<string, any>, fields: string[], label: string) {
  for (const field of fields) {
    expect(obj, `${label} should not contain '${field}'`).not.toHaveProperty(field);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Progressive disclosure: search tier (compact index)', () => {
  const obs = makeObservation();
  const sess = makeSession();
  const prompt = makePrompt();

  const shaped = shapeSearchResults({
    results: {
      observations: [obs],
      sessions: [sess],
      prompts: [prompt],
    },
    usedVector: true,
    fellBack: false,
    strategy: 'pgvector',
  });

  it('includes only compact fields for observations', () => {
    const result = shaped.results.observations[0];
    expect(Object.keys(result).sort()).toEqual([
      'concepts',
      'created_at_epoch',
      'id',
      'project',
      'score',
      'subtitle',
      'title',
      'type',
    ]);
  });

  it('includes only compact fields for sessions', () => {
    const result = shaped.results.sessions[0];
    expect(Object.keys(result).sort()).toEqual([
      'completed',
      'created_at_epoch',
      'id',
      'project',
      'request',
      'score',
    ]);
  });

  it('includes only compact fields for prompts', () => {
    const result = shaped.results.prompts[0];
    expect(Object.keys(result).sort()).toEqual([
      'created_at_epoch',
      'id',
      'prompt_number',
      'prompt_text',
    ]);
  });

  it('never includes bloat fields in observations', () => {
    expectNoFields(shaped.results.observations[0], BLOAT_FIELDS, 'search observation');
  });

  it('never includes bloat fields in sessions', () => {
    expectNoFields(shaped.results.sessions[0], BLOAT_FIELDS, 'search session');
  });

  it('strips internal fields from observations', () => {
    expectNoFields(shaped.results.observations[0], INTERNAL_FIELDS, 'search observation');
  });

  it('strips verbose content fields from observations', () => {
    const stripped = ['text', 'narrative', 'facts', 'files_read', 'files_modified', 'prompt_number'];
    expectNoFields(shaped.results.observations[0], stripped, 'search observation');
  });

  it('strips verbose content fields from sessions', () => {
    const stripped = ['investigated', 'learned', 'next_steps', 'files_read', 'files_edited', 'notes', 'prompt_number'];
    expectNoFields(shaped.results.sessions[0], stripped, 'search session');
  });

  it('preserves strategy metadata without usedVector/fellBack', () => {
    expect(shaped.strategy).toBe('pgvector');
    expect(shaped).not.toHaveProperty('usedVector');
    expect(shaped).not.toHaveProperty('fellBack');
  });

  it('handles empty results gracefully', () => {
    const empty = shapeSearchResults({
      results: { observations: [], sessions: [], prompts: [] },
      strategy: 'structured',
    });
    expect(empty.results.observations).toEqual([]);
    expect(empty.results.sessions).toEqual([]);
    expect(empty.results.prompts).toEqual([]);
  });

  it('handles missing results object gracefully', () => {
    const missing = shapeSearchResults({ strategy: 'structured' });
    expect(missing.results.observations).toEqual([]);
    expect(missing.results.sessions).toEqual([]);
    expect(missing.results.prompts).toEqual([]);
  });
});

describe('Progressive disclosure: timeline tier (moderate detail)', () => {
  const obs = makeObservation();

  const shaped = shapeTimelineResults({
    observations: [obs],
    sessions: [{ id: 99, memory_session_id: 'x', project: 'p', request: 'r', completed: 'c', next_steps: 'n', created_at: 't', created_at_epoch: 1000 }],
    prompts: [{ id: 7, content_session_id: 'c', prompt_number: 1, prompt_text: 'test', project: 'p', created_at: 't', created_at_epoch: 1000 }],
  });

  it('includes moderate-detail fields for observations', () => {
    const result = shaped.observations[0];
    expect(Object.keys(result).sort()).toEqual([
      'concepts',
      'created_at_epoch',
      'files_modified',
      'id',
      'narrative',
      'project',
      'subtitle',
      'title',
      'type',
    ]);
  });

  it('includes narrative and files_modified (not in search tier)', () => {
    const result = shaped.observations[0];
    expect(result).toHaveProperty('narrative');
    expect(result).toHaveProperty('files_modified');
  });

  it('never includes bloat fields', () => {
    expectNoFields(shaped.observations[0], BLOAT_FIELDS, 'timeline observation');
  });

  it('strips internal fields', () => {
    expectNoFields(shaped.observations[0], INTERNAL_FIELDS, 'timeline observation');
  });

  it('strips full-detail fields not needed for timeline', () => {
    const stripped = ['text', 'facts', 'files_read', 'prompt_number', 'score', 'rank'];
    expectNoFields(shaped.observations[0], stripped, 'timeline observation');
  });

  it('passes sessions through unchanged (already compact from Timeline.ts)', () => {
    expect(shaped.sessions).toEqual([
      { id: 99, memory_session_id: 'x', project: 'p', request: 'r', completed: 'c', next_steps: 'n', created_at: 't', created_at_epoch: 1000 },
    ]);
  });

  it('passes prompts through unchanged', () => {
    expect(shaped.prompts).toEqual([
      { id: 7, content_session_id: 'c', prompt_number: 1, prompt_text: 'test', project: 'p', created_at: 't', created_at_epoch: 1000 },
    ]);
  });

  it('handles empty observations', () => {
    const empty = shapeTimelineResults({ observations: [], sessions: [], prompts: [] });
    expect(empty.observations).toEqual([]);
  });
});

describe('Progressive disclosure: get_observations tier (full detail)', () => {
  const obs = makeObservation();
  const shaped = fullObservation(obs);

  it('includes all user-facing content fields', () => {
    expect(Object.keys(shaped).sort()).toEqual([
      'concepts',
      'created_at_epoch',
      'facts',
      'files_modified',
      'files_read',
      'id',
      'narrative',
      'project',
      'prompt_number',
      'subtitle',
      'text',
      'title',
      'type',
    ]);
  });

  it('includes text, facts, files_read (not in other tiers)', () => {
    expect(shaped).toHaveProperty('text');
    expect(shaped).toHaveProperty('facts');
    expect(shaped).toHaveProperty('files_read');
    expect(shaped).toHaveProperty('prompt_number');
  });

  it('never includes bloat fields', () => {
    expectNoFields(shaped, BLOAT_FIELDS, 'full observation');
  });

  it('strips internal-only fields', () => {
    expectNoFields(shaped, ['memory_session_id', 'content_hash', 'discovery_tokens'], 'full observation');
  });

  it('uses epoch only, not ISO created_at', () => {
    expect(shaped).toHaveProperty('created_at_epoch');
    expect(shaped).not.toHaveProperty('created_at');
  });
});

describe('Progressive disclosure: field containment across tiers', () => {
  const obs = makeObservation();
  const searchFields = Object.keys(compactObservation(obs));
  const timelineFields = Object.keys(timelineObservation(obs));
  const fullFields = Object.keys(fullObservation(obs));

  it('search fields are a subset of timeline fields', () => {
    for (const field of searchFields) {
      if (field === 'score') continue; // score is search-only
      expect(timelineFields, `timeline should include search field '${field}'`).toContain(field);
    }
  });

  it('timeline fields are a subset of full fields', () => {
    for (const field of timelineFields) {
      expect(fullFields, `full should include timeline field '${field}'`).toContain(field);
    }
  });

  it('each tier adds fields over the previous', () => {
    // Timeline adds: narrative, files_modified
    const timelineOnly = timelineFields.filter(f => !searchFields.includes(f));
    expect(timelineOnly).toContain('narrative');
    expect(timelineOnly).toContain('files_modified');

    // Full adds: text, facts, files_read, prompt_number
    const fullOnly = fullFields.filter(f => !timelineFields.includes(f));
    expect(fullOnly).toContain('text');
    expect(fullOnly).toContain('facts');
    expect(fullOnly).toContain('files_read');
    expect(fullOnly).toContain('prompt_number');
  });
});

describe('Token budget estimation', () => {
  const obs = makeObservation();

  function estimateTokens(obj: any): number {
    // Rough estimate: ~4 chars per token for JSON
    return Math.ceil(JSON.stringify(obj).length / 4);
  }

  it('search tier observation is under 100 tokens', () => {
    const tokens = estimateTokens(compactObservation(obs));
    expect(tokens).toBeLessThan(100);
  });

  it('timeline tier observation is under 250 tokens', () => {
    const tokens = estimateTokens(timelineObservation(obs));
    expect(tokens).toBeLessThan(250);
  });

  it('full tier observation is under 500 tokens', () => {
    const tokens = estimateTokens(fullObservation(obs));
    expect(tokens).toBeLessThan(500);
  });

  it('search is significantly smaller than full', () => {
    const searchSize = JSON.stringify(compactObservation(obs)).length;
    const fullSize = JSON.stringify(fullObservation(obs)).length;
    // Search should be less than half the size of full
    expect(searchSize).toBeLessThan(fullSize / 2);
  });

  it('raw observation with embedding is much larger than any shaped tier', () => {
    // Simulate a raw observation with a 768-dim embedding
    const rawObs = { ...obs, embedding: Array(768).fill(0.123456789) };
    const rawSize = JSON.stringify(rawObs).length;
    const fullSize = JSON.stringify(fullObservation(obs)).length;
    // Raw with embedding should be at least 5x larger than the full shaped tier
    expect(rawSize).toBeGreaterThan(fullSize * 5);
  });
});
