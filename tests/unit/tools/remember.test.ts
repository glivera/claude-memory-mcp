import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/embedding.js', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../../../src/db.js', () => ({
  insertMemory: vi.fn(),
}));

import { handleRemember } from '../../../src/tools/remember.js';
import { generateEmbedding } from '../../../src/embedding.js';
import { insertMemory } from '../../../src/db.js';
import { ValidationError } from '../../../src/errors.js';

const mockGenerateEmbedding = vi.mocked(generateEmbedding);
const mockInsertMemory = vi.mocked(insertMemory);

describe('handleRemember', () => {
  const validInput = {
    project_id: 'my-project',
    memory_type: 'decision' as const,
    title: 'Use PostgreSQL',
    content: 'We decided to use PostgreSQL for the database layer.',
    tags: ['database', 'architecture'],
  };

  const fakeEmbedding = Array(1536).fill(0.1);
  const fakeRow = {
    id: 'uuid-123',
    project_id: 'my-project',
    memory_type: 'decision',
    title: 'Use PostgreSQL',
    content: 'We decided to use PostgreSQL for the database layer.',
    tags: ['database', 'architecture'],
    embedding: fakeEmbedding,
    session_id: null,
    created_at: '2026-01-01T00:00:00Z',
    expires_at: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue(fakeEmbedding);
    mockInsertMemory.mockResolvedValue(fakeRow);
  });

  it('should successfully remember a valid memory', async () => {
    const result = await handleRemember(validInput);

    expect(result).toEqual({
      id: 'uuid-123',
      project_id: 'my-project',
      title: 'Use PostgreSQL',
      memory_type: 'decision',
      created_at: '2026-01-01T00:00:00Z',
    });
  });

  it('should generate embedding from title + content', async () => {
    await handleRemember(validInput);

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      'Use PostgreSQL We decided to use PostgreSQL for the database layer.'
    );
  });

  it('should call insertMemory with correct parameters', async () => {
    await handleRemember(validInput);

    expect(mockInsertMemory).toHaveBeenCalledWith({
      project_id: 'my-project',
      memory_type: 'decision',
      title: 'Use PostgreSQL',
      content: 'We decided to use PostgreSQL for the database layer.',
      tags: ['database', 'architecture'],
      embedding: fakeEmbedding,
      session_id: null,
      expires_at: null,
    });
  });

  it('should throw ValidationError for invalid project_id (not kebab-case)', async () => {
    const input = { ...validInput, project_id: 'My Project' };
    await expect(handleRemember(input)).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for project_id with uppercase', async () => {
    const input = { ...validInput, project_id: 'MyProject' };
    await expect(handleRemember(input)).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for invalid memory_type', async () => {
    const input = { ...validInput, memory_type: 'invalid_type' as any };
    await expect(handleRemember(input)).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for title exceeding 120 chars', async () => {
    const input = { ...validInput, title: 'a'.repeat(121) };
    await expect(handleRemember(input)).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for empty content', async () => {
    const input = { ...validInput, content: '' };
    await expect(handleRemember(input)).rejects.toThrow(ValidationError);
  });

  it('should accept all valid memory types', async () => {
    const types = [
      'decision', 'bug_fix', 'pattern', 'context',
      'blocker', 'learning', 'convention', 'dependency',
    ];

    for (const memory_type of types) {
      const input = { ...validInput, memory_type: memory_type as any };
      await expect(handleRemember(input)).resolves.toBeDefined();
    }
  });

  it('should default tags to empty array when not provided', async () => {
    const { tags, ...inputWithoutTags } = validInput;
    await handleRemember(inputWithoutTags as any);

    expect(mockInsertMemory).toHaveBeenCalledWith(
      expect.objectContaining({ tags: [] })
    );
  });

  it('should calculate expires_at when expires_in_days is provided', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const input = { ...validInput, expires_in_days: 7 };
    await handleRemember(input);

    const expectedExpiry = new Date(now + 7 * 86400000).toISOString();
    expect(mockInsertMemory).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: expectedExpiry })
    );

    vi.restoreAllMocks();
  });

  it('should set expires_at to null when expires_in_days is not provided', async () => {
    await handleRemember(validInput);

    expect(mockInsertMemory).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: null })
    );
  });

  it('should accept title at exactly 120 chars', async () => {
    const input = { ...validInput, title: 'a'.repeat(120) };
    await expect(handleRemember(input)).resolves.toBeDefined();
  });
});
