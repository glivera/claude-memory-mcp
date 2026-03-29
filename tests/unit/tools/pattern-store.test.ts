import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/embedding.js', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../../../src/db.js', () => ({
  getSupabaseClient: vi.fn(),
}));

import { handlePatternStore } from '../../../src/tools/pattern-store.js';
import { generateEmbedding } from '../../../src/embedding.js';
import { getSupabaseClient } from '../../../src/db.js';
import { ValidationError } from '../../../src/errors.js';

const mockGenerateEmbedding = vi.mocked(generateEmbedding);
const mockGetSupabaseClient = vi.mocked(getSupabaseClient);

const fakeEmbedding = new Array(1536).fill(0.1);

function createMockClient(rpcResult: { data: unknown; error: unknown }, insertResult?: { data: unknown; error: unknown }) {
  const fromChain = {
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnValue({ error: insertResult?.error ?? null }),
    eq: vi.fn().mockReturnThis(),
  };
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
    from: vi.fn().mockReturnValue(fromChain),
    _fromChain: fromChain,
  };
}

describe('handlePatternStore', () => {
  const validInput = {
    description: 'Always use Zod validation at API boundaries for runtime type safety',
    category: 'code' as const,
    project: 'my-project',
    example: 'In memory-mcp, every tool handler validates input with patternStoreInputSchema.safeParse()',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue(fakeEmbedding);
  });

  describe('creating new patterns', () => {
    it('should create a new pattern when no similar exists', async () => {
      const mockClient = createMockClient({ data: [], error: null });
      mockGetSupabaseClient.mockReturnValue(mockClient as any);

      const result = await handlePatternStore(validInput);

      expect(result.action).toBe('created');
      expect(result.count).toBe(1);
      expect(result.pattern_id).toBe('always-use-zod-validation-at-api-boundaries-for-runtime-type');
      expect(mockGenerateEmbedding).toHaveBeenCalledWith(validInput.description);
    });

    it('should generate a valid pattern_id from description', async () => {
      const mockClient = createMockClient({ data: [], error: null });
      mockGetSupabaseClient.mockReturnValue(mockClient as any);

      const result = await handlePatternStore({
        ...validInput,
        description: 'Use Docker multi-stage builds for SMALLER images!!!',
      });

      expect(result.pattern_id).toBe('use-docker-multi-stage-builds-for-smaller-images');
    });

    it('should truncate pattern_id to 60 chars', async () => {
      const mockClient = createMockClient({ data: [], error: null });
      mockGetSupabaseClient.mockReturnValue(mockClient as any);

      const result = await handlePatternStore({
        ...validInput,
        description: 'This is a very long description that should be truncated to sixty characters for the pattern identifier',
      });

      expect(result.pattern_id.length).toBeLessThanOrEqual(60);
    });

    it('should pass embedding and all fields to insert', async () => {
      const mockClient = createMockClient({ data: [], error: null });
      mockGetSupabaseClient.mockReturnValue(mockClient as any);

      await handlePatternStore(validInput);

      expect(mockClient.from).toHaveBeenCalledWith('skill_patterns');
      const insertCall = mockClient._fromChain.insert.mock.calls[0][0];
      expect(insertCall.pattern_id).toBeDefined();
      expect(insertCall.description).toBe(validInput.description);
      expect(insertCall.category).toBe('code');
      expect(insertCall.project).toBe('my-project');
      expect(insertCall.embedding).toBe(fakeEmbedding);
      expect(insertCall.count).toBe(1);
      expect(insertCall.examples).toHaveLength(1);
      expect(insertCall.examples[0].text).toBe(validInput.example);
    });
  });

  describe('merging into existing patterns', () => {
    const existingPattern = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      pattern_id: 'existing-pattern',
      count: 2,
      examples: [{ text: 'old example', date: '2026-03-20T00:00:00Z' }],
      similarity: 0.95,
    };

    it('should merge when similar pattern found', async () => {
      const mockClient = createMockClient({ data: [existingPattern], error: null });
      mockGetSupabaseClient.mockReturnValue(mockClient as any);

      const result = await handlePatternStore(validInput);

      expect(result.action).toBe('merged');
      expect(result.pattern_id).toBe('existing-pattern');
      expect(result.new_count).toBe(3);
    });

    it('should increment count on merge', async () => {
      const mockClient = createMockClient({ data: [{ ...existingPattern, count: 5 }], error: null });
      mockGetSupabaseClient.mockReturnValue(mockClient as any);

      const result = await handlePatternStore(validInput);

      expect(result.new_count).toBe(6);
    });

    it('should set proposed_skill=true when count reaches 3', async () => {
      const mockClient = createMockClient({ data: [existingPattern], error: null });
      mockGetSupabaseClient.mockReturnValue(mockClient as any);

      const result = await handlePatternStore(validInput);

      expect(result.proposed_skill).toBe(true);
    });

    it('should append example to existing examples on merge', async () => {
      const mockClient = createMockClient({ data: [existingPattern], error: null });
      mockGetSupabaseClient.mockReturnValue(mockClient as any);

      await handlePatternStore(validInput);

      const updateCall = mockClient._fromChain.update.mock.calls[0][0];
      expect(updateCall.examples).toHaveLength(2);
      expect(updateCall.examples[0].text).toBe('old example');
      expect(updateCall.examples[1].text).toBe(validInput.example);
    });

    it('should call RPC with dedup threshold 0.75', async () => {
      const mockClient = createMockClient({ data: [], error: null });
      mockGetSupabaseClient.mockReturnValue(mockClient as any);

      await handlePatternStore(validInput);

      expect(mockClient.rpc).toHaveBeenCalledWith('match_skill_patterns', expect.objectContaining({
        match_threshold: 0.75,
        match_count: 1,
      }));
    });
  });

  describe('validation', () => {
    it('should reject description shorter than 10 chars', async () => {
      await expect(
        handlePatternStore({ ...validInput, description: 'short' })
      ).rejects.toThrow(ValidationError);
    });

    it('should reject invalid category', async () => {
      await expect(
        handlePatternStore({ ...validInput, category: 'invalid' as any })
      ).rejects.toThrow(ValidationError);
    });

    it('should reject example shorter than 10 chars', async () => {
      await expect(
        handlePatternStore({ ...validInput, example: 'short' })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('error handling', () => {
    it('should throw EmbeddingError on embedding failure', async () => {
      mockGenerateEmbedding.mockRejectedValue(new Error('OpenAI down'));

      await expect(handlePatternStore(validInput)).rejects.toThrow('Failed to embed pattern description');
    });

    it('should throw DbError on RPC failure', async () => {
      const mockClient = createMockClient({ data: null, error: { message: 'DB down' } });
      mockGetSupabaseClient.mockReturnValue(mockClient as any);

      await expect(handlePatternStore(validInput)).rejects.toThrow('Pattern match query failed');
    });
  });
});
