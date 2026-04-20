import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, resetConfigCache } from '../../src/config.js';

describe('config', () => {
  const originalEnv = { ...process.env };

  function setRequiredEnv() {
    process.env.SUPABASE_URL = 'https://test-project.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
  }

  beforeEach(() => {
    resetConfigCache();
    // Clear all config-related env vars
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.OLLAMA_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.SIMILARITY_THRESHOLD;
    delete process.env.RECALL_TOKEN_CAP;
    delete process.env.DEFAULT_RECALL_LIMIT;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  it('should parse valid config with all required vars', () => {
    setRequiredEnv();
    const config = getConfig();
    expect(config.SUPABASE_URL).toBe('https://test-project.supabase.co');
    expect(config.SUPABASE_SERVICE_KEY).toBe('test-service-key');
  });

  it('should apply default values for optional vars', () => {
    setRequiredEnv();
    const config = getConfig();
    expect(config.OLLAMA_URL).toBe('http://127.0.0.1:11434');
    expect(config.EMBEDDING_MODEL).toBe('qwen3-embedding-0.6b');
    expect(config.SIMILARITY_THRESHOLD).toBe(0.25);
    expect(config.RECALL_TOKEN_CAP).toBe(2000);
    expect(config.DEFAULT_RECALL_LIMIT).toBe(5);
  });

  it('should allow overriding optional vars', () => {
    setRequiredEnv();
    process.env.OLLAMA_URL = 'http://ollama.local:8080';
    process.env.EMBEDDING_MODEL = 'custom-model';
    process.env.SIMILARITY_THRESHOLD = '0.9';
    process.env.RECALL_TOKEN_CAP = '1000';
    process.env.DEFAULT_RECALL_LIMIT = '10';
    const config = getConfig();
    expect(config.OLLAMA_URL).toBe('http://ollama.local:8080');
    expect(config.EMBEDDING_MODEL).toBe('custom-model');
    expect(config.SIMILARITY_THRESHOLD).toBe(0.9);
    expect(config.RECALL_TOKEN_CAP).toBe(1000);
    expect(config.DEFAULT_RECALL_LIMIT).toBe(10);
  });

  it('should throw when SUPABASE_URL is missing', () => {
    process.env.SUPABASE_SERVICE_KEY = 'key';
    expect(() => getConfig()).toThrow('Invalid configuration');
  });

  it('should throw when SUPABASE_SERVICE_KEY is missing', () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    expect(() => getConfig()).toThrow('Invalid configuration');
  });

  it('should throw when SUPABASE_URL is not a valid URL', () => {
    process.env.SUPABASE_URL = 'not-a-url';
    process.env.SUPABASE_SERVICE_KEY = 'key';
    expect(() => getConfig()).toThrow('Invalid configuration');
  });

  it('should throw when SIMILARITY_THRESHOLD is out of range', () => {
    setRequiredEnv();
    process.env.SIMILARITY_THRESHOLD = '1.5';
    expect(() => getConfig()).toThrow('Invalid configuration');
  });

  it('should throw when RECALL_TOKEN_CAP is not positive', () => {
    setRequiredEnv();
    process.env.RECALL_TOKEN_CAP = '0';
    expect(() => getConfig()).toThrow('Invalid configuration');
  });

  it('should throw when DEFAULT_RECALL_LIMIT exceeds 20', () => {
    setRequiredEnv();
    process.env.DEFAULT_RECALL_LIMIT = '21';
    expect(() => getConfig()).toThrow('Invalid configuration');
  });

  it('should cache config on subsequent calls', () => {
    setRequiredEnv();
    const first = getConfig();
    // Change env after first call
    process.env.SUPABASE_URL = 'https://changed.supabase.co';
    const second = getConfig();
    expect(second.SUPABASE_URL).toBe(first.SUPABASE_URL);
  });

  it('should return fresh config after resetConfigCache', () => {
    setRequiredEnv();
    getConfig();
    resetConfigCache();
    process.env.SUPABASE_URL = 'https://changed.supabase.co';
    const second = getConfig();
    expect(second.SUPABASE_URL).toBe('https://changed.supabase.co');
  });
});
