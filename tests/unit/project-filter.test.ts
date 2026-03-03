import { describe, it, expect } from 'vitest';
import { isProjectExcluded } from '../../src/utils/project-filter.js';

describe('isProjectExcluded', () => {
  it('returns false for empty patterns', () => {
    expect(isProjectExcluded('/Users/me/project', '')).toBe(false);
    expect(isProjectExcluded('/Users/me/project', '  ')).toBe(false);
  });

  it('matches exact path', () => {
    expect(isProjectExcluded('/tmp/scratch', '/tmp/scratch')).toBe(true);
  });

  it('does not match partial path', () => {
    expect(isProjectExcluded('/tmp/scratch-pad', '/tmp/scratch')).toBe(false);
  });

  it('matches wildcard pattern', () => {
    expect(isProjectExcluded('/tmp/scratch', '/tmp/*')).toBe(true);
  });

  it('wildcard does not cross directory boundaries', () => {
    expect(isProjectExcluded('/tmp/a/b', '/tmp/*')).toBe(false);
  });

  it('matches globstar pattern', () => {
    expect(isProjectExcluded('/tmp/a/b/c', '/tmp/**')).toBe(true);
  });

  it('matches comma-separated patterns', () => {
    expect(isProjectExcluded('/opt/secret', '/tmp/*,/opt/secret')).toBe(true);
  });

  it('returns false when no patterns match', () => {
    expect(isProjectExcluded('/Users/me/project', '/tmp/*,/opt/*')).toBe(false);
  });

  it('handles tilde expansion', () => {
    const home = require('os').homedir();
    expect(isProjectExcluded(`${home}/scratch`, '~/scratch')).toBe(true);
  });

  it('handles ? single-char wildcard', () => {
    expect(isProjectExcluded('/tmp/a', '/tmp/?')).toBe(true);
    expect(isProjectExcluded('/tmp/ab', '/tmp/?')).toBe(false);
  });
});
