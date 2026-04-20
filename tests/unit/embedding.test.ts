import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    OLLAMA_URL: 'http://127.0.0.1:11434',
    EMBEDDING_MODEL: 'qwen3-embedding-0.6b',
  }),
}));

import { generateEmbedding } from '../../src/embedding.js';
import { EmbeddingError } from '../../src/errors.js';

const fetchMock = vi.fn();
const originalFetch = global.fetch;

function mockOk(embedding: number[]) {
  return {
    ok: true,
    json: async () => ({ embedding }),
    text: async () => JSON.stringify({ embedding }),
  };
}

function mockErr(status: number, message = 'error') {
  return {
    ok: false,
    status,
    json: async () => ({ error: message }),
    text: async () => message,
  };
}

describe('generateEmbedding', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should return embedding array on success', async () => {
    const fakeEmbedding = Array(1024).fill(0.1);
    fetchMock.mockResolvedValueOnce(mockOk(fakeEmbedding));

    const result = await generateEmbedding('test text');
    expect(result).toEqual(fakeEmbedding);
    expect(result).toHaveLength(1024);
  });

  it('should call Ollama with correct URL and payload', async () => {
    fetchMock.mockResolvedValueOnce(mockOk([0.1, 0.2]));

    await generateEmbedding('hello world');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3-embedding-0.6b',
          prompt: 'hello world',
        }),
      })
    );
  });

  it('should retry once on 429 error and succeed', async () => {
    fetchMock
      .mockResolvedValueOnce(mockErr(429, 'Rate limited'))
      .mockResolvedValueOnce(mockOk([0.5]));

    const result = await generateEmbedding('retry test');
    expect(result).toEqual([0.5]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should retry once on 500 error and succeed', async () => {
    fetchMock
      .mockResolvedValueOnce(mockErr(500, 'Server error'))
      .mockResolvedValueOnce(mockOk([0.3]));

    const result = await generateEmbedding('server error test');
    expect(result).toEqual([0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should throw EmbeddingError after retry exhaustion on retryable error', async () => {
    fetchMock
      .mockResolvedValueOnce(mockErr(502, 'Bad gateway'))
      .mockResolvedValueOnce(mockErr(502, 'Bad gateway'));

    await expect(generateEmbedding('fail test')).rejects.toThrow(EmbeddingError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should not retry on non-retryable error (e.g. 400)', async () => {
    fetchMock.mockResolvedValueOnce(mockErr(400, 'Bad request'));

    await expect(generateEmbedding('bad request')).rejects.toThrow(EmbeddingError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should not retry on network (non-status) errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network error'));

    await expect(generateEmbedding('network fail')).rejects.toThrow(EmbeddingError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should include original error as cause in EmbeddingError', async () => {
    const originalErr = new TypeError('Network fail');
    fetchMock.mockRejectedValueOnce(originalErr);

    try {
      await generateEmbedding('cause test');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingError);
      expect((err as Error & { cause?: unknown }).cause).toBe(originalErr);
    }
  });
});
