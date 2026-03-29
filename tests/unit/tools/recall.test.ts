import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/embedding.js', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../../../src/db.js', () => ({
  matchMemories: vi.fn(),
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
import { matchMemories } from '../../../src/db.js';
import { getConfig } from '../../../src/config.js';
import { ValidationError } from '../../../src/errors.js';

const mockGenerateEmbedding = vi.mocked(generateEmbedding);
const mockMatchMemories = vi.mocked(matchMemories);
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
      0.7
    );
  });

  it('should use DEFAULT_RECALL_LIMIT when limit not provided', async () => {
    await handleRecall({ query: 'test query' });

    expect(mockMatchMemories).toHaveBeenCalledWith(
      fakeEmbedding,
      null,
      null,
      5,
      0.7
    );
  });

  it('should pass null for optional project_id and memory_type', async () => {
    await handleRecall({ query: 'test' });

    expect(mockMatchMemories).toHaveBeenCalledWith(
      fakeEmbedding,
      null,
      null,
      5,
      0.7
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
    it('should filter out memories older than since_days', async () => {
      const now = new Date();
      const twoDaysAgo = new Date(now);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const tenDaysAgo = new Date(now);
      tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

      mockMatchMemories.mockResolvedValue([
        {
          id: 'recent', project_id: 'proj', memory_type: 'context',
          title: 'Recent', content: 'Recent work.', tags: [],
          similarity: 0.8, session_id: null, created_at: twoDaysAgo.toISOString(),
        },
        {
          id: 'old', project_id: 'proj', memory_type: 'decision',
          title: 'Old', content: 'Old decision.', tags: [],
          similarity: 0.9, session_id: null, created_at: tenDaysAgo.toISOString(),
        },
      ]);

      const result = await handleRecall({ query: 'work', since_days: 7 });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('recent');
    });

    it('should return all memories when since_days not provided', async () => {
      const result = await handleRecall({ query: 'test' });
      expect(result).toHaveLength(2);
    });

    it('should request 3x more results when since_days is set to compensate for filtering', async () => {
      await handleRecall({ query: 'test', since_days: 7, limit: 5 });

      expect(mockMatchMemories).toHaveBeenCalledWith(
        fakeEmbedding, null, null, 15, 0.7
      );
    });

    it('should still respect limit after date filtering', async () => {
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
});
