import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/embedding.js', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../../../src/db.js', () => ({
  getSupabaseClient: vi.fn(),
}));

import { handlePatternSearch } from '../../../src/tools/pattern-search.js';
import { generateEmbedding } from '../../../src/embedding.js';
import { getSupabaseClient } from '../../../src/db.js';
import { ValidationError } from '../../../src/errors.js';

const mockGenerateEmbedding = vi.mocked(generateEmbedding);
const mockGetSupabaseClient = vi.mocked(getSupabaseClient);

const fakeEmbedding = new Array(1536).fill(0.1);

const samplePatterns = [
  {
    id: 'aaa-111', pattern_id: 'zod-validation', description: 'Use Zod at boundaries',
    category: 'code', project: 'my-project', examples: [], count: 5,
    first_seen: '2026-03-01T00:00:00Z', last_seen: '2026-03-29T00:00:00Z',
    proposed_skill: true, skill_created: false, similarity: 0.8,
  },
  {
    id: 'bbb-222', pattern_id: 'docker-multi-stage', description: 'Multi-stage Docker builds',
    category: 'devops', project: null, examples: [], count: 2,
    first_seen: '2026-03-10T00:00:00Z', last_seen: '2026-03-20T00:00:00Z',
    proposed_skill: false, skill_created: false, similarity: 0.6,
  },
];

describe('handlePatternSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue(fakeEmbedding);
  });

  it('should return matching patterns sorted by similarity', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: samplePatterns, error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    const results = await handlePatternSearch({ query: 'validation patterns' });

    expect(results).toHaveLength(2);
    expect(results[0].pattern_id).toBe('zod-validation');
    expect(results[0].similarity).toBe(0.8);
  });

  it('should pass threshold 0.25 for broad search', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    await handlePatternSearch({ query: 'test' });

    expect(mockClient.rpc).toHaveBeenCalledWith('match_skill_patterns', expect.objectContaining({
      match_threshold: 0.25,
    }));
  });

  it('should filter by min_count', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: samplePatterns, error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    const results = await handlePatternSearch({ query: 'patterns', min_count: 3 });

    expect(results).toHaveLength(1);
    expect(results[0].count).toBe(5);
  });

  it('should pass category filter to RPC', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    await handlePatternSearch({ query: 'docker', category: 'devops' });

    expect(mockClient.rpc).toHaveBeenCalledWith('match_skill_patterns', expect.objectContaining({
      filter_category: 'devops',
    }));
  });

  it('should pass project filter to RPC', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    await handlePatternSearch({ query: 'test', project: 'my-project' });

    expect(mockClient.rpc).toHaveBeenCalledWith('match_skill_patterns', expect.objectContaining({
      filter_project: 'my-project',
    }));
  });

  it('should respect limit parameter', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    await handlePatternSearch({ query: 'test', limit: 5 });

    expect(mockClient.rpc).toHaveBeenCalledWith('match_skill_patterns', expect.objectContaining({
      match_count: 5,
    }));
  });

  it('should return empty array when no matches', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    const results = await handlePatternSearch({ query: 'nothing matches' });

    expect(results).toEqual([]);
  });

  it('should reject empty query', async () => {
    await expect(
      handlePatternSearch({ query: '' })
    ).rejects.toThrow(ValidationError);
  });

  it('should throw on RPC error', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'RPC failed' } }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    await expect(
      handlePatternSearch({ query: 'test' })
    ).rejects.toThrow('Pattern search failed');
  });
});
