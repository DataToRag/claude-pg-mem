import { describe, it, expect } from 'vitest';
import { parseObservations, parseSummary } from '../../src/sdk/parser.js';

const VALID_TYPES = ['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change'];

describe('parseObservations', () => {
  it('parses a single observation with all fields', () => {
    const xml = `
      <observation>
        <type>bugfix</type>
        <title>Fix login bug</title>
        <subtitle>Auth token expired</subtitle>
        <narrative>The token was not being refreshed</narrative>
        <facts><fact>Token TTL was 1 hour</fact><fact>Should be 24 hours</fact></facts>
        <concepts><concept>authentication</concept><concept>tokens</concept></concepts>
        <files_read><file>src/auth.ts</file></files_read>
        <files_modified><file>src/auth.ts</file><file>src/config.ts</file></files_modified>
      </observation>
    `;
    const result = parseObservations(xml, VALID_TYPES);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('bugfix');
    expect(result[0].title).toBe('Fix login bug');
    expect(result[0].subtitle).toBe('Auth token expired');
    expect(result[0].narrative).toBe('The token was not being refreshed');
    expect(result[0].facts).toEqual(['Token TTL was 1 hour', 'Should be 24 hours']);
    expect(result[0].concepts).toEqual(['authentication', 'tokens']);
    expect(result[0].files_read).toEqual(['src/auth.ts']);
    expect(result[0].files_modified).toEqual(['src/auth.ts', 'src/config.ts']);
  });

  it('parses multiple observations', () => {
    const xml = `
      <observation>
        <type>bugfix</type>
        <title>First</title>
      </observation>
      <observation>
        <type>feature</type>
        <title>Second</title>
      </observation>
    `;
    const result = parseObservations(xml, VALID_TYPES);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('First');
    expect(result[1].title).toBe('Second');
  });

  it('uses fallback type when type is missing', () => {
    const xml = `<observation><title>No type</title></observation>`;
    const result = parseObservations(xml, VALID_TYPES);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('bugfix'); // first valid type
  });

  it('uses fallback type when type is invalid', () => {
    const xml = `<observation><type>invalid_type</type><title>Bad type</title></observation>`;
    const result = parseObservations(xml, VALID_TYPES);
    expect(result[0].type).toBe('bugfix');
  });

  it('filters type from concepts array', () => {
    const xml = `
      <observation>
        <type>refactor</type>
        <concepts><concept>refactor</concept><concept>cleanup</concept></concepts>
      </observation>
    `;
    const result = parseObservations(xml, VALID_TYPES);
    expect(result[0].concepts).toEqual(['cleanup']);
  });

  it('handles missing optional fields', () => {
    const xml = `<observation><type>discovery</type></observation>`;
    const result = parseObservations(xml, VALID_TYPES);
    expect(result[0]).toEqual({
      type: 'discovery',
      title: null,
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
    });
  });

  it('returns empty array for no observations', () => {
    expect(parseObservations('no xml here', VALID_TYPES)).toEqual([]);
  });

  it('handles surrounding text', () => {
    const xml = `Here is my analysis:\n<observation><type>change</type><title>test</title></observation>\nDone.`;
    const result = parseObservations(xml, VALID_TYPES);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('test');
  });
});

describe('parseSummary', () => {
  it('parses a full summary', () => {
    const xml = `
      <summary>
        <request>Fix the auth bug</request>
        <investigated>Looked at token refresh logic</investigated>
        <learned>Token TTL was too short</learned>
        <completed>Extended token TTL to 24h</completed>
        <next_steps>Add token refresh tests</next_steps>
        <notes>May need to update docs</notes>
      </summary>
    `;
    const result = parseSummary(xml);
    expect(result).toEqual({
      request: 'Fix the auth bug',
      investigated: 'Looked at token refresh logic',
      learned: 'Token TTL was too short',
      completed: 'Extended token TTL to 24h',
      next_steps: 'Add token refresh tests',
      notes: 'May need to update docs',
    });
  });

  it('returns null when no summary found', () => {
    expect(parseSummary('no summary here')).toBeNull();
  });

  it('returns null when skip_summary is present', () => {
    const xml = `<skip_summary reason="too_short" />`;
    expect(parseSummary(xml)).toBeNull();
  });

  it('handles missing optional fields', () => {
    const xml = `<summary><request>Do something</request></summary>`;
    const result = parseSummary(xml);
    expect(result?.request).toBe('Do something');
    expect(result?.investigated).toBeNull();
    expect(result?.notes).toBeNull();
  });
});
