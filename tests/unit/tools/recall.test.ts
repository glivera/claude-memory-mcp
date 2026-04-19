import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/embedding.js', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../../../src/db.js', () => ({
  matchMemories: vi.fn(),
  matchMemoriesWithLinks: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    SIMILARITY_THRESHOLD: 0.7,
    RECALL_TOKEN_CAP: 2000,
    DEFAULT_RECALL_LIMIT: 5,
  }),
}));

import { handleRecall } from '../../../src/tools/recall.js';
import { generateEmbedding } from '../../../src/embedding.js';
import { matchMemories, matchMemoriesWithLinks } from '../../../src/db.js';
import { getConfig } from '../../../src/config.js';
import { ValidationError } from '../../../src/errors.js';

const mockGenerateEmbedding = vi.mocked(generateEmbedding);
const mockMatchMemories = vi.mocked(matchMemories);
const mockMatchMemoriesWithLinks = vi.mocked(matchMemoriesWithLinks);
const mockGetConfig = vi.mocked(getConfig);

describe('handleRecall', () => {
  const fakeEmbedding = Array(1536).fill(0.1);

  const fakeResults = [
    {
      id: 'id-1',
      project_id: 'my-project',
      memory_type: 'decision',
      title: 'Use PostgreSQL',
      content: 'Database decision details.',
      tags: ['db'],
      similarity: 0.95,
      session_id: null,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'id-2',
      project_id: 'my-project',
      memory_type: 'pattern',
      title: 'Repository pattern',
      content: 'We use the repository pattern.',
      tags: ['architecture'],
      similarity: 0.85,
      session_id: null,
      created_at: '2026-01-02T00:00:00Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue(fakeEmbedding);
    mockMatchMemories.mockResolvedValue(fakeResults);
    mockGetConfig.mockReturnValue({
      SIMILARITY_THRESHOLD: 0.7,
      RECALL_TOKEN_CAP: 2000,
      DEFAULT_RECALL_LIMIT: 5,
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_KEY: 'key',
      OPENROUTER_API_KEY: 'key',
      EMBEDDING_MODEL: 'openai/text-embedding-3-small',
    });
  });

  it('should return matching memories', async () => {
    const result = await handleRecall({ query: 'database choice' });

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('id-1');
    expect(result[0].title).toBe('Use PostgreSQL');
    expect(result[1].id).toBe('id-2');
  });

  it('should generate embedding for the query', async () => {
    await handleRecall({ query: 'database choice' });

    expect(mockGenerateEmbedding).toHaveBeenCalledWith('database choice');
  });

  it('should call matchMemories with correct parameters', async () => {
    await handleRecall({
      query: 'search query',
      project_id: 'my-project',
      memory_type: 'decision',
      limit: 10,
    });

    expect(mockMatchMemories).toHaveBeenCalledWith(
      fakeEmbedding,
      'my-project',
      'decision',
      10,
      0.7,
      null
    );
  });

  it('should use DEFAULT_RECALL_LIMIT when limit not provided', async () => {
    await handleRecall({ query: 'test query' });

    expect(mockMatchMemories).toHaveBeenCalledWith(
      fakeEmbedding,
      null,
      null,
      5,
      0.7,
      null
    );
  });

  it('should pass null for optional project_id and memory_type', async () => {
    await handleRecall({ query: 'test' });

    expect(mockMatchMemories).toHaveBeenCalledWith(
      fakeEmbedding,
      null,
      null,
      5,
      0.7,
      null
    );
  });

  it('should throw ValidationError for empty query', async () => {
    await expect(handleRecall({ query: '' })).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for limit below 1', async () => {
    await expect(
      handleRecall({ query: 'test', limit: 0 })
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for limit above 20', async () => {
    await expect(
      handleRecall({ query: 'test', limit: 21 })
    ).rejects.toThrow(ValidationError);
  });

  it('should return empty array when no matches', async () => {
    mockMatchMemories.mockResolvedValue([]);

    const result = await handleRecall({ query: 'no match' });
    expect(result).toEqual([]);
  });

  it('should apply token truncation for large results', async () => {
    // Create results with very large content that exceeds token cap
    const largeResults = [
      {
        id: 'id-big',
        project_id: 'proj',
        memory_type: 'context',
        title: 'Big Memory',
        content: 'x'.repeat(10000),
        tags: [],
        similarity: 0.9,
        session_id: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    mockMatchMemories.mockResolvedValue(largeResults);

    const result = await handleRecall({ query: 'big search' });

    // With 2000 token cap, the content should be truncated
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('[truncated]');
    expect(result[0].content.length).toBeLessThan(10000);
  });

  describe('since_days filtering', () => {
    it('should pass min_created_at to matchMemories when since_days is set', async () => {
      const before = new Date();
      before.setDate(before.getDate() - 7);

      await handleRecall({ query: 'work', since_days: 7 });

      const after = new Date();
      after.setDate(after.getDate() - 7);

      expect(mockMatchMemories).toHaveBeenCalledWith(
        fakeEmbedding, null, null, 5, 0.7,
        expect.any(String)
      );

      const passedDate = new Date(mockMatchMemories.mock.calls[0][5] as string);
      expect(passedDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(passedDate.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should pass null min_created_at when since_days not provided', async () => {
      await handleRecall({ query: 'test' });

      expect(mockMatchMemories).toHaveBeenCalledWith(
        fakeEmbedding, null, null, 5, 0.7, null
      );
    });

    it('should not request extra results when since_days is set (filtering is server-side)', async () => {
      await handleRecall({ query: 'test', since_days: 7, limit: 5 });

      expect(mockMatchMemories).toHaveBeenCalledWith(
        fakeEmbedding, null, null, 5, 0.7,
        expect.any(String)
      );
    });

    it('should still respect limit after server-side date filtering', async () => {
      const now = new Date();
      const recentResults = Array.from({ length: 10 }, (_, i) => ({
        id: `id-${i}`, project_id: 'proj', memory_type: 'context',
        title: `Memory ${i}`, content: `Content ${i}`, tags: [],
        similarity: 0.8 - i * 0.01, session_id: null,
        created_at: now.toISOString(),
      }));
      mockMatchMemories.mockResolvedValue(recentResults);

      const result = await handleRecall({ query: 'test', since_days: 7, limit: 3 });

      expect(result).toHaveLength(3);
    });
  });

  it('should map MatchResult fields to TokenCappedEntry', async () => {
    const result = await handleRecall({ query: 'test' });

    expect(result[0]).toEqual({
      id: 'id-1',
      title: 'Use PostgreSQL',
      content: 'Database decision details.',
      tags: ['db'],
      similarity: 0.95,
      project_id: 'my-project',
      memory_type: 'decision',
      created_at: '2026-01-01T00:00:00Z',
    });
  });

  describe('v0.2 orchestration features', () => {
    const extendedResult = {
      id: 'ext-1',
      project_id: 'my-project',
      memory_type: 'decision',
      title: 'Extended match',
      content: 'Matched via extended RPC',
      tags: [],
      similarity: 0.9,
      session_id: null,
      created_at: '2026-01-01T00:00:00Z',
      status: 'open',
      linked_to: [],
      relation: null,
      link_depth: 0,
    };

    beforeEach(() => {
      mockMatchMemoriesWithLinks.mockResolvedValue([extendedResult]);
    });

    it('should route to matchMemoriesWithLinks when follow_links=true', async () => {
      await handleRecall({ query: 'test', follow_links: true });

      expect(mockMatchMemoriesWithLinks).toHaveBeenCalled();
      expect(mockMatchMemories).not.toHaveBeenCalled();
    });

    it('should use matchMemories when follow_links=false (backward compat)', async () => {
      await handleRecall({ query: 'test', follow_links: false });

      expect(mockMatchMemories).toHaveBeenCalled();
      expect(mockMatchMemoriesWithLinks).not.toHaveBeenCalled();
    });

    it('should trigger extended RPC when status filter is set (no follow_links)', async () => {
      await handleRecall({ query: 'test', status: 'open' });

      expect(mockMatchMemoriesWithLinks).toHaveBeenCalled();
      expect(mockMatchMemories).not.toHaveBeenCalled();
    });

    it('should apply linked_type post-filter: keep depth=0, filter depth=1 by memory_type', async () => {
      mockMatchMemoriesWithLinks.mockResolvedValue([
        { ...extendedResult, id: 'direct', memory_type: 'decision', link_depth: 0 },
        { ...extendedResult, id: 'linked-match', memory_type: 'counter_argument', link_depth: 1 },
        { ...extendedResult, id: 'linked-skip', memory_type: 'deviation', link_depth: 1 },
      ]);

      const result = await handleRecall({
        query: 'test',
        follow_links: true,
        linked_type: 'counter_argument',
      });

      const ids = result.map((r) => r.id);
      expect(ids).toContain('direct');
      expect(ids).toContain('linked-match');
      expect(ids).not.toContain('linked-skip');
    });

    it('should throw ValidationError for invalid status enum', async () => {
      await expect(
        handleRecall({ query: 'test', status: 'bogus' as any })
      ).rejects.toThrow(ValidationError);
    });
  });
});
