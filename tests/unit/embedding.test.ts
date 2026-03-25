import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  class MockAPIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'APIError';
    }
  }

  const MockOpenAI = vi.fn().mockImplementation(() => ({
    embeddings: {
      create: mockCreate,
    },
  }));

  MockOpenAI.APIError = MockAPIError;

  return { default: MockOpenAI, APIError: MockAPIError };
});

vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    OPENROUTER_API_KEY: 'test-key',
    EMBEDDING_MODEL: 'openai/text-embedding-3-small',
  }),
}));

import { generateEmbedding, resetOpenAIClient } from '../../src/embedding.js';
import { EmbeddingError } from '../../src/errors.js';
import OpenAI from 'openai';

describe('generateEmbedding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOpenAIClient();
  });

  it('should return embedding array on success', async () => {
    const fakeEmbedding = Array(1536).fill(0.1);
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: fakeEmbedding }],
    });

    const result = await generateEmbedding('test text');
    expect(result).toEqual(fakeEmbedding);
    expect(result).toHaveLength(1536);
  });

  it('should call OpenAI with correct parameters', async () => {
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: [0.1, 0.2] }],
    });

    await generateEmbedding('hello world');
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'openai/text-embedding-3-small',
      input: 'hello world',
      encoding_format: 'float',
    });
  });

  it('should retry once on 429 error and succeed', async () => {
    const apiError = new (OpenAI.APIError as unknown as new (status: number, message: string) => Error)(429, 'Rate limited');
    mockCreate
      .mockRejectedValueOnce(apiError)
      .mockResolvedValueOnce({
        data: [{ embedding: [0.5] }],
      });

    const result = await generateEmbedding('retry test');
    expect(result).toEqual([0.5]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('should retry once on 500 error and succeed', async () => {
    const apiError = new (OpenAI.APIError as unknown as new (status: number, message: string) => Error)(500, 'Server error');
    mockCreate
      .mockRejectedValueOnce(apiError)
      .mockResolvedValueOnce({
        data: [{ embedding: [0.3] }],
      });

    const result = await generateEmbedding('server error test');
    expect(result).toEqual([0.3]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('should throw EmbeddingError after retry exhaustion on retryable error', async () => {
    const apiError = new (OpenAI.APIError as unknown as new (status: number, message: string) => Error)(502, 'Bad gateway');
    mockCreate
      .mockRejectedValueOnce(apiError)
      .mockRejectedValueOnce(apiError);

    await expect(generateEmbedding('fail test')).rejects.toThrow(EmbeddingError);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('should not retry on non-retryable error (e.g. 400)', async () => {
    const apiError = new (OpenAI.APIError as unknown as new (status: number, message: string) => Error)(400, 'Bad request');
    mockCreate.mockRejectedValueOnce(apiError);

    await expect(generateEmbedding('bad request')).rejects.toThrow(EmbeddingError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('should not retry on non-API errors', async () => {
    mockCreate.mockRejectedValueOnce(new TypeError('Network error'));

    await expect(generateEmbedding('network fail')).rejects.toThrow(EmbeddingError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('should include original error as cause in EmbeddingError', async () => {
    const originalErr = new (OpenAI.APIError as unknown as new (status: number, message: string) => Error)(400, 'Bad request');
    mockCreate.mockRejectedValueOnce(originalErr);

    try {
      await generateEmbedding('cause test');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingError);
      expect((err as EmbeddingError).cause).toBe(originalErr);
    }
  });
});

describe('resetOpenAIClient', () => {
  it('should allow creating a new client after reset', async () => {
    mockCreate.mockResolvedValue({
      data: [{ embedding: [0.1] }],
    });

    await generateEmbedding('first');
    resetOpenAIClient();
    await generateEmbedding('second');

    // OpenAI constructor called twice (once per client creation)
    const OpenAIMock = (await import('openai')).default;
    expect(OpenAIMock).toHaveBeenCalledTimes(2);
  });
});
