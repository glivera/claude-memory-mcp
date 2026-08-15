import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/embedding.js', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../../../src/db.js', () => ({
  matchMemories: vi.fn(),
  matchMemoriesWithLinks: vi.fn(),
  matchMemoriesHybrid: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    SIMILARITY_THRESHOLD: 0.25,
    RECALL_TOKEN_CAP: 2000,
    DEFAULT_RECALL_LIMIT: 5,
    RECALL_HYBRID: '0',
    RECALL_ENVELOPE: '0',
  }),
}));

import { handleRecall, wrapRecallResult, RECALL_NOTICE } from '../../../src/tools/recall.js';
import { generateEmbedding } from '../../../src/embedding.js';
import { matchMemories, matchMemoriesWithLinks, matchMemoriesHybrid } from '../../../src/db.js';
import { getConfig } from '../../../src/config.js';
import { ValidationError } from '../../../src/errors.js';

const mockGenerateEmbedding = vi.mocked(generateEmbedding);
const mockMatchMemories = vi.mocked(matchMemories);
const mockMatchMemoriesWithLinks = vi.mocked(matchMemoriesWithLinks);
const mockMatchMemoriesHybrid = vi.mocked(matchMemoriesHybrid);
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
    mockMatchMemoriesHybrid.mockResolvedValue(fakeResults);
    mockGetConfig.mockReturnValue({
      SIMILARITY_THRESHOLD: 0.25,
      RECALL_TOKEN_CAP: 2000,
      DEFAULT_RECALL_LIMIT: 5,
      RECALL_HYBRID: '0',
      RECALL_ENVELOPE: '0',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_KEY: 'key',
      OPENAI_API_KEY: 'key',
      EMBEDDING_MODEL: 'openai/text-embedding-3-small',
    } as any);
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
      0.25,
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
      0.25,
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
      0.25,
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
        fakeEmbedding, null, null, 5, 0.25,
        expect.any(String)
      );

      const passedDate = new Date(mockMatchMemories.mock.calls[0][5] as string);
      expect(passedDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(passedDate.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should pass null min_created_at when since_days not provided', async () => {
      await handleRecall({ query: 'test' });

      expect(mockMatchMemories).toHaveBeenCalledWith(
        fakeEmbedding, null, null, 5, 0.25, null
      );
    });

    it('should not request extra results when since_days is set (filtering is server-side)', async () => {
      await handleRecall({ query: 'test', since_days: 7, limit: 5 });

      expect(mockMatchMemories).toHaveBeenCalledWith(
        fakeEmbedding, null, null, 5, 0.25,
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

  describe('v0.3 hybrid recall routing', () => {
    it('should use matchMemories (not matchMemoriesHybrid) when RECALL_HYBRID is not set (default)', async () => {
      await handleRecall({ query: 'test' });

      expect(mockMatchMemories).toHaveBeenCalled();
      expect(mockMatchMemoriesHybrid).not.toHaveBeenCalled();
    });

    it('should route to matchMemoriesHybrid with the query text as second arg when RECALL_HYBRID=1', async () => {
      mockGetConfig.mockReturnValue({
        SIMILARITY_THRESHOLD: 0.25,
        RECALL_TOKEN_CAP: 2000,
        DEFAULT_RECALL_LIMIT: 5,
        RECALL_HYBRID: '1',
        RECALL_ENVELOPE: '0',
      } as any);

      await handleRecall({ query: 'database choice' });

      expect(mockMatchMemoriesHybrid).toHaveBeenCalled();
      expect(mockMatchMemories).not.toHaveBeenCalled();
      expect(mockMatchMemoriesHybrid.mock.calls[0][1]).toBe('database choice');
    });

    it('should always use matchMemoriesWithLinks for the extended path (follow_links=true), regardless of RECALL_HYBRID', async () => {
      mockGetConfig.mockReturnValue({
        SIMILARITY_THRESHOLD: 0.25,
        RECALL_TOKEN_CAP: 2000,
        DEFAULT_RECALL_LIMIT: 5,
        RECALL_HYBRID: '1',
        RECALL_ENVELOPE: '0',
      } as any);
      mockMatchMemoriesWithLinks.mockResolvedValue(
        fakeResults.map((r) => ({ ...r, status: 'open', linked_to: [], relation: null, link_depth: 0 }))
      );

      await handleRecall({ query: 'test', follow_links: true });

      expect(mockMatchMemoriesWithLinks).toHaveBeenCalled();
      expect(mockMatchMemoriesHybrid).not.toHaveBeenCalled();
      expect(mockMatchMemories).not.toHaveBeenCalled();
    });
  });

  describe('v0.3 provenance and trust_score fields on entries', () => {
    it('should include provenance and trust_score in entries when the mocked result rows carry them', async () => {
      mockMatchMemories.mockResolvedValue([
        { ...fakeResults[0], provenance: 'user_authored', trust_score: 1.0 },
      ]);

      const result = await handleRecall({ query: 'test' });

      expect(result[0]).toEqual(
        expect.objectContaining({ provenance: 'user_authored', trust_score: 1.0 })
      );
    });

    it('should omit provenance and trust_score keys when result rows have them null/undefined', async () => {
      mockMatchMemories.mockResolvedValue([
        { ...fakeResults[0], provenance: null, trust_score: null },
      ]);

      const result = await handleRecall({ query: 'test' });

      expect(result[0]).not.toHaveProperty('provenance');
      expect(result[0]).not.toHaveProperty('trust_score');
    });
  });
});

describe('wrapRecallResult', () => {
  const sampleEntries = [
    {
      id: 'id-1',
      title: 'Use PostgreSQL',
      content: 'Database decision details.',
      tags: ['db'],
      similarity: 0.95,
      project_id: 'my-project',
      memory_type: 'decision',
      created_at: '2026-01-01T00:00:00Z',
    },
  ];

  it('should return a plain JSON array string when envelopeEnabled is false', () => {
    const output = wrapRecallResult(sampleEntries as any, false);
    const parsed = JSON.parse(output);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('id-1');
  });

  it('should return a notice-wrapped JSON object when envelopeEnabled is true', () => {
    const output = wrapRecallResult(sampleEntries as any, true);
    const parsed = JSON.parse(output);

    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.notice).toBe(RECALL_NOTICE);
    expect(Array.isArray(parsed.memories)).toBe(true);
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0].id).toBe('id-1');
  });

  it('should handle an empty entries array in plain mode (envelopeEnabled=false)', () => {
    const output = wrapRecallResult([], false);
    expect(JSON.parse(output)).toEqual([]);
  });

  it('should handle an empty entries array in envelope mode (envelopeEnabled=true)', () => {
    const output = wrapRecallResult([], true);
    const parsed = JSON.parse(output);

    expect(parsed.notice).toBe(RECALL_NOTICE);
    expect(parsed.memories).toEqual([]);
  });
});
