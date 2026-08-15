import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db.js', () => ({
  expireMemoryById: vi.fn(),
  expireMemoriesByProject: vi.fn(),
}));

import { handleForget } from '../../../src/tools/forget.js';
import { expireMemoryById, expireMemoriesByProject } from '../../../src/db.js';
import { ValidationError } from '../../../src/errors.js';

const mockExpireById = vi.mocked(expireMemoryById);
const mockExpireByProject = vi.mocked(expireMemoriesByProject);

describe('handleForget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('forget by memory_id', () => {
    it('should expire a single memory by ID', async () => {
      mockExpireById.mockResolvedValue(1);

      const result = await handleForget({
        memory_id: '550e8400-e29b-41d4-a716-446655440000',
        project_id: 'my-project',
      });

      expect(mockExpireById).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440000',
        'my-project'
      );
      expect(result.expired_count).toBe(1);
    });

    it('should use the provided project_id in the result', async () => {
      mockExpireById.mockResolvedValue(1);

      const result = await handleForget({
        memory_id: '550e8400-e29b-41d4-a716-446655440000',
        project_id: 'my-project',
      });

      expect(result.project_id).toBe('my-project');
    });
  });

  describe('forget by project_id', () => {
    it('should expire all memories for a project', async () => {
      mockExpireByProject.mockResolvedValue(5);

      const result = await handleForget({
        project_id: 'my-project',
      });

      expect(mockExpireByProject).toHaveBeenCalledWith('my-project', undefined);
      expect(result.expired_count).toBe(5);
      expect(result.project_id).toBe('my-project');
    });

    it('should include warning when expiring entire project (no older_than_days)', async () => {
      mockExpireByProject.mockResolvedValue(3);

      const result = await handleForget({
        project_id: 'my-project',
      });

      expect(result.warning).toContain('my-project');
      expect(result.warning).toContain('expired');
    });
  });

  describe('forget by project_id + older_than_days', () => {
    it('should expire old memories for a project', async () => {
      mockExpireByProject.mockResolvedValue(2);

      const result = await handleForget({
        project_id: 'my-project',
        older_than_days: 30,
      });

      expect(mockExpireByProject).toHaveBeenCalledWith('my-project', 30);
      expect(result.expired_count).toBe(2);
      expect(result.project_id).toBe('my-project');
    });

    it('should not include warning when older_than_days is specified', async () => {
      mockExpireByProject.mockResolvedValue(2);

      const result = await handleForget({
        project_id: 'my-project',
        older_than_days: 30,
      });

      expect(result.warning).toBeUndefined();
    });
  });

  describe('repeat forget (idempotency)', () => {
    it('should return count 1 without error when forgetting an already-expired memory in the right project', async () => {
      mockExpireById.mockResolvedValue(1);

      const result = await handleForget({
        memory_id: '550e8400-e29b-41d4-a716-446655440000',
        project_id: 'my-project',
      });

      expect(result.expired_count).toBe(1);
    });
  });

  describe('ownership', () => {
    it('should propagate a "belongs to project" error from the db layer', async () => {
      mockExpireById.mockRejectedValue(
        new ValidationError(
          'Memory 550e8400-e29b-41d4-a716-446655440000 belongs to project other-project, not my-project'
        )
      );

      await expect(
        handleForget({
          memory_id: '550e8400-e29b-41d4-a716-446655440000',
          project_id: 'my-project',
        })
      ).rejects.toThrow('belongs to project other-project, not my-project');
    });
  });

  describe('validation errors', () => {
    it('should throw ValidationError when project_id is missing', async () => {
      await expect(handleForget({} as any)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when project_id is not kebab-case', async () => {
      await expect(
        handleForget({ project_id: 'My Project' } as any)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid UUID memory_id', async () => {
      await expect(
        handleForget({ memory_id: 'not-a-uuid', project_id: 'my-project' })
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for negative older_than_days', async () => {
      await expect(
        handleForget({ project_id: 'my-project', older_than_days: -1 })
      ).rejects.toThrow(ValidationError);
    });
  });
});
