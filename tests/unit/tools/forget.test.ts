import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db.js', () => ({
  expireMemoryById: vi.fn(),
}));

import { handleForget } from '../../../src/tools/forget.js';
import { expireMemoryById } from '../../../src/db.js';
import { ValidationError } from '../../../src/errors.js';

const mockExpireById = vi.mocked(expireMemoryById);

const MEMORY_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('handleForget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('forget by memory_id', () => {
    it('should call expireMemoryById with (memory_id, project_id)', async () => {
      mockExpireById.mockResolvedValue('expired');

      await handleForget({ memory_id: MEMORY_ID, project_id: 'my-project' });

      expect(mockExpireById).toHaveBeenCalledTimes(1);
      expect(mockExpireById).toHaveBeenCalledWith(MEMORY_ID, 'my-project');
    });

    it('should return expired_count 1 and echo ids when the memory was expired', async () => {
      mockExpireById.mockResolvedValue('expired');

      const result = await handleForget({ memory_id: MEMORY_ID, project_id: 'my-project' });

      expect(result).toEqual({
        memory_id: MEMORY_ID,
        project_id: 'my-project',
        expired_count: 1,
      });
    });

    it('should not include a warning or already_expired field on a fresh expiry', async () => {
      mockExpireById.mockResolvedValue('expired');

      const result = await handleForget({ memory_id: MEMORY_ID, project_id: 'my-project' });

      expect(result).not.toHaveProperty('warning');
      expect(result).not.toHaveProperty('already_expired');
    });
  });

  describe('project-only call', () => {
    it('should throw ValidationError mentioning memory_id when memory_id is missing', async () => {
      await expect(handleForget({ project_id: 'my-project' } as any)).rejects.toThrow(
        ValidationError
      );
      await expect(handleForget({ project_id: 'my-project' } as any)).rejects.toThrow(
        /forget requires memory_id/
      );
    });

    it('should not call the db when memory_id is missing', async () => {
      await expect(handleForget({ project_id: 'my-project' } as any)).rejects.toThrow();

      expect(mockExpireById).not.toHaveBeenCalled();
    });
  });

  describe('bulk params rejected', () => {
    it('should reject {project_id, older_than_days} with a by-id only ValidationError', async () => {
      const call = () => handleForget({ project_id: 'my-project', older_than_days: 30 } as any);

      await expect(call()).rejects.toThrow(ValidationError);
      await expect(call()).rejects.toThrow(/by-id only/);
    });

    it('should reject {memory_id, project_id, older_than_days} with a by-id only ValidationError', async () => {
      const call = () =>
        handleForget({
          memory_id: MEMORY_ID,
          project_id: 'my-project',
          older_than_days: 30,
        } as any);

      await expect(call()).rejects.toThrow(ValidationError);
      await expect(call()).rejects.toThrow(/by-id only/);
    });

    it('should not call the db when bulk params are present', async () => {
      await expect(
        handleForget({ project_id: 'my-project', older_than_days: 30 } as any)
      ).rejects.toThrow();
      await expect(
        handleForget({
          memory_id: MEMORY_ID,
          project_id: 'my-project',
          older_than_days: 30,
        } as any)
      ).rejects.toThrow();

      expect(mockExpireById).not.toHaveBeenCalled();
    });
  });

  describe('already-expired no-op', () => {
    it('should return expired_count 0 and already_expired true', async () => {
      mockExpireById.mockResolvedValue('already_expired');

      const result = await handleForget({ memory_id: MEMORY_ID, project_id: 'my-project' });

      expect(result).toEqual({
        memory_id: MEMORY_ID,
        project_id: 'my-project',
        expired_count: 0,
        already_expired: true,
      });
    });

    it('should not include a warning field', async () => {
      mockExpireById.mockResolvedValue('already_expired');

      const result = await handleForget({ memory_id: MEMORY_ID, project_id: 'my-project' });

      expect(result).not.toHaveProperty('warning');
    });
  });

  describe('ownership', () => {
    it('should propagate a "belongs to project" ValidationError from the db layer', async () => {
      mockExpireById.mockRejectedValue(
        new ValidationError(`Memory ${MEMORY_ID} belongs to project other-project, not my-project`)
      );

      const call = () => handleForget({ memory_id: MEMORY_ID, project_id: 'my-project' });

      await expect(call()).rejects.toThrow(ValidationError);
      await expect(call()).rejects.toThrow('belongs to project other-project, not my-project');
    });
  });

  describe('validation errors', () => {
    it('should throw ValidationError for an invalid UUID memory_id', async () => {
      await expect(
        handleForget({ memory_id: 'not-a-uuid', project_id: 'my-project' })
      ).rejects.toThrow(ValidationError);
      expect(mockExpireById).not.toHaveBeenCalled();
    });

    it('should throw ValidationError when project_id is not kebab-case', async () => {
      await expect(
        handleForget({ memory_id: MEMORY_ID, project_id: 'My Project' })
      ).rejects.toThrow(ValidationError);
      expect(mockExpireById).not.toHaveBeenCalled();
    });

    it('should throw ValidationError when project_id is missing', async () => {
      await expect(handleForget({ memory_id: MEMORY_ID } as any)).rejects.toThrow(
        ValidationError
      );
      expect(mockExpireById).not.toHaveBeenCalled();
    });
  });
});
