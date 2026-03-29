import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db.js', () => ({
  getSupabaseClient: vi.fn(),
}));

import { handlePatternMature } from '../../../src/tools/pattern-mature.js';
import { getSupabaseClient } from '../../../src/db.js';

const mockGetSupabaseClient = vi.mocked(getSupabaseClient);

const maturePatterns = [
  {
    id: 'aaa-111', pattern_id: 'zod-validation', description: 'Use Zod',
    category: 'code', project: null, examples: [], count: 5,
    first_seen: '2026-03-01T00:00:00Z', last_seen: '2026-03-29T00:00:00Z',
  },
  {
    id: 'bbb-222', pattern_id: 'docker-multi-stage', description: 'Multi-stage builds',
    category: 'devops', project: null, examples: [], count: 3,
    first_seen: '2026-03-10T00:00:00Z', last_seen: '2026-03-20T00:00:00Z',
  },
  {
    id: 'ccc-333', pattern_id: 'error-classes', description: 'Custom error hierarchy',
    category: 'code', project: 'memory-mcp', examples: [], count: 4,
    first_seen: '2026-03-05T00:00:00Z', last_seen: '2026-03-25T00:00:00Z',
  },
];

describe('handlePatternMature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return patterns with count >= min_count', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: maturePatterns, error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    const result = await handlePatternMature({});

    expect(result.total).toBe(3);
    expect(mockClient.rpc).toHaveBeenCalledWith('get_mature_patterns', {
      min_count: 3,
      filter_category: null,
      exclude_created: true,
    });
  });

  it('should group results by category', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: maturePatterns, error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    const result = await handlePatternMature({});

    expect(result.by_category['code']).toHaveLength(2);
    expect(result.by_category['devops']).toHaveLength(1);
  });

  it('should pass min_count to RPC', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    await handlePatternMature({ min_count: 5 });

    expect(mockClient.rpc).toHaveBeenCalledWith('get_mature_patterns', expect.objectContaining({
      min_count: 5,
    }));
  });

  it('should pass category filter to RPC', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    await handlePatternMature({ category: 'devops' });

    expect(mockClient.rpc).toHaveBeenCalledWith('get_mature_patterns', expect.objectContaining({
      filter_category: 'devops',
    }));
  });

  it('should pass exclude_created=false when specified', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    await handlePatternMature({ exclude_created: false });

    expect(mockClient.rpc).toHaveBeenCalledWith('get_mature_patterns', expect.objectContaining({
      exclude_created: false,
    }));
  });

  it('should return empty when no mature patterns', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    const result = await handlePatternMature({});

    expect(result.total).toBe(0);
    expect(result.by_category).toEqual({});
  });

  it('should throw on RPC error', async () => {
    const mockClient = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }) };
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    await expect(handlePatternMature({})).rejects.toThrow('Mature patterns query failed');
  });
});
