import { describe, it, expect } from 'vitest';
import { countTokens, truncateToTokenLimit, type TokenCappedEntry } from '../../src/token-counter.js';

function makeEntry(overrides: Partial<TokenCappedEntry> = {}): TokenCappedEntry {
  return {
    id: 'test-id',
    title: 'Test Title',
    content: 'Test content here',
    tags: [],
    similarity: 0.9,
    project_id: 'test-project',
    memory_type: 'decision',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('countTokens', () => {
  it('should return ceiling of text length / 4', () => {
    expect(countTokens('abcd')).toBe(1);      // 4 / 4 = 1
    expect(countTokens('abcde')).toBe(2);      // 5 / 4 = 1.25 → 2
    expect(countTokens('ab')).toBe(1);          // 2 / 4 = 0.5 → 1
    expect(countTokens('abcdefgh')).toBe(2);   // 8 / 4 = 2
  });

  it('should return 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('should handle long text', () => {
    const text = 'a'.repeat(1000);
    expect(countTokens(text)).toBe(250); // 1000 / 4 = 250
  });
});

describe('truncateToTokenLimit', () => {
  it('should return all entries when total tokens within limit', () => {
    const entries = [
      makeEntry({ title: 'Hi', content: 'abc' }),  // "Hi abc" = 6 chars → 2 tokens
      makeEntry({ title: 'Lo', content: 'def' }),  // "Lo def" = 6 chars → 2 tokens
    ];
    const result = truncateToTokenLimit(entries, 100);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('abc');
    expect(result[1].content).toBe('def');
  });

  it('should truncate content of the last fitting entry when limit exceeded', () => {
    // Each entry uses "title content" for token counting
    // Create entry with known sizes
    const smallEntry = makeEntry({ title: 'A', content: 'B' }); // "A B" = 3 chars → 1 token
    const largeContent = 'x'.repeat(400); // "Big " + 400 = 404 chars → 101 tokens
    const largeEntry = makeEntry({ title: 'Big', content: largeContent });

    const result = truncateToTokenLimit([smallEntry, largeEntry], 50);
    // smallEntry uses 1 token, remaining = 49 tokens > 20
    // 49 * 4 = 196 chars of content truncated
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('B');
    expect(result[1].content).toContain('[truncated]');
    expect(result[1].content.length).toBeLessThan(largeContent.length);
  });

  it('should skip entry entirely when remaining tokens <= 20', () => {
    // Fill up most of the budget with the first entry
    const bigContent = 'y'.repeat(380); // "T " + 380 = 382 chars → 96 tokens
    const firstEntry = makeEntry({ title: 'T', content: bigContent });
    const secondEntry = makeEntry({ title: 'Second', content: 'more content here' });

    // Total budget = 100 tokens
    // First entry: "T " + bigContent = 382 chars → 96 tokens, fits
    // Remaining: 4 tokens → <= 20, skip
    const result = truncateToTokenLimit([firstEntry, secondEntry], 100);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(bigContent);
  });

  it('should return empty array when first entry exceeds limit and remaining <= 20', () => {
    const hugeContent = 'z'.repeat(10000);
    const entry = makeEntry({ title: 'H', content: hugeContent });

    // "H " + 10000 = 10002 chars → 2501 tokens
    // limit = 10, remaining at start = 10 which is <= 20
    const result = truncateToTokenLimit([entry], 10);
    expect(result).toHaveLength(0);
  });

  it('should return empty array for empty entries input', () => {
    const result = truncateToTokenLimit([], 100);
    expect(result).toHaveLength(0);
  });

  it('should append [truncated] marker to truncated content', () => {
    const content = 'a'.repeat(500);
    const entry = makeEntry({ title: 'X', content });

    const result = truncateToTokenLimit([entry], 50);
    // "X " + 500 = 502 chars → 126 tokens, exceeds 50
    // remaining = 50 > 20, so truncate: 50 * 4 = 200 chars
    expect(result).toHaveLength(1);
    expect(result[0].content).toMatch(/ \[truncated\]$/);
  });
});
