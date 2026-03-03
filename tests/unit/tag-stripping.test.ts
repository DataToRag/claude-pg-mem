import { describe, it, expect } from 'vitest';
import { stripMemoryTagsFromJson, stripMemoryTagsFromPrompt } from '../../src/utils/tag-stripping.js';

describe('stripMemoryTagsFromJson', () => {
  it('removes <private> tags and content', () => {
    const input = 'before <private>secret stuff</private> after';
    expect(stripMemoryTagsFromJson(input)).toBe('before  after');
  });

  it('removes <claude-pg-mem-context> tags and content', () => {
    const input = 'before <claude-pg-mem-context>injected context</claude-pg-mem-context> after';
    expect(stripMemoryTagsFromJson(input)).toBe('before  after');
  });

  it('removes multiple tags', () => {
    const input = '<private>a</private> middle <private>b</private>';
    expect(stripMemoryTagsFromJson(input)).toBe('middle');
  });

  it('handles multiline content inside tags', () => {
    const input = 'keep this\n<private>\nline1\nline2\n</private>\nand this';
    expect(stripMemoryTagsFromJson(input)).toBe('keep this\n\nand this');
  });

  it('returns empty string for fully private content', () => {
    const input = '<private>everything is private</private>';
    expect(stripMemoryTagsFromJson(input)).toBe('');
  });

  it('handles content with no tags', () => {
    expect(stripMemoryTagsFromJson('no tags here')).toBe('no tags here');
  });

  it('handles empty string', () => {
    expect(stripMemoryTagsFromJson('')).toBe('');
  });

  it('removes both tag types in same content', () => {
    const input = '<private>secret</private> visible <claude-pg-mem-context>ctx</claude-pg-mem-context>';
    expect(stripMemoryTagsFromJson(input)).toBe('visible');
  });
});

describe('stripMemoryTagsFromPrompt', () => {
  it('works identically to stripMemoryTagsFromJson', () => {
    const input = 'hello <private>world</private>';
    expect(stripMemoryTagsFromPrompt(input)).toBe('hello');
  });
});
