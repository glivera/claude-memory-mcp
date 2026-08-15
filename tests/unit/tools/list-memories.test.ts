import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db.js', () => ({
  listMemories: vi.fn(),
}));

import { handleListMemories } from '../../../src/tools/list-memories.js';
import { listMemories } from '../../../src/db.js';
import { ValidationError } from '../../../src/errors.js';

const mockListMemories = vi.mocked(listMemories);

describe('handleListMemories', () => {
  const validProject = 'my-project';

  const result = {
    memories: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Some counter',
        memory_type: 'counter_argument',
        status: 'open',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ],
    total: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return {memories, total} on success', async () => {
    mockListMemories.mockResolvedValue(result);

    const output = await handleListMemories({ project_id: validProject });

    expect(output).toEqual(result);
  });

  it('should pass filters through to listMemories', async () => {
    mockListMemories.mockResolvedValue(result);

    await handleListMemories({
      project_id: validProject,
      memory_type: 'counter_argument',
      status: 'open',
      since_days: 30,
      limit: 20,
    });

    expect(mockListMemories).toHaveBeenCalledWith(validProject, {
      memoryType: 'counter_argument',
      status: 'open',
      sinceDays: 30,
      limit: 20,
    });
  });

  it('should default limit to 50 when omitted', async () => {
    mockListMemories.mockResolvedValue(result);

    await handleListMemories({ project_id: validProject });

    expect(mockListMemories).toHaveBeenCalledWith(validProject, {
      memoryType: undefined,
      status: undefined,
      sinceDays: undefined,
      limit: 50,
    });
  });

  it('should accept limit at the max of 100', async () => {
    mockListMemories.mockResolvedValue(result);

    await handleListMemories({ project_id: validProject, limit: 100 });

    expect(mockListMemories).toHaveBeenCalledWith(
      validProject,
      expect.objectContaining({ limit: 100 })
    );
  });

  it('should throw ValidationError for limit above 100', async () => {
    await expect(
      handleListMemories({ project_id: validProject, limit: 101 })
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for missing project_id', async () => {
    await expect(handleListMemories({} as any)).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for non-kebab-case project_id', async () => {
    await expect(
      handleListMemories({ project_id: 'My Project' })
    ).rejects.toThrow(ValidationError);
  });
});
