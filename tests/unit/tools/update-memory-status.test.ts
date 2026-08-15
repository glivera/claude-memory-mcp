import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db.js', () => ({
  updateStatus: vi.fn(),
}));

import { handleUpdateMemoryStatus } from '../../../src/tools/update-memory-status.js';
import { updateStatus } from '../../../src/db.js';
import { ValidationError, DbError } from '../../../src/errors.js';

const mockUpdateStatus = vi.mocked(updateStatus);

describe('handleUpdateMemoryStatus', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';
  const validProject = 'my-project';

  const row = {
    id: validId,
    project_id: validProject,
    memory_type: 'counter_argument',
    title: 'Some counter',
    content: 'Original content',
    tags: [],
    session_id: null,
    created_at: '2026-08-01T00:00:00.000Z',
    expires_at: null,
    status: 'resolved',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return {id, project_id, title, status} on success', async () => {
    mockUpdateStatus.mockResolvedValue(row);

    const result = await handleUpdateMemoryStatus({
      memory_id: validId,
      project_id: validProject,
      status: 'resolved',
      resolution_note: 'Plan changed to address it.',
    });

    expect(result).toEqual({
      id: row.id,
      project_id: row.project_id,
      title: row.title,
      status: row.status,
    });
  });

  it('should pass args through to updateStatus', async () => {
    mockUpdateStatus.mockResolvedValue(row);

    await handleUpdateMemoryStatus({
      memory_id: validId,
      project_id: validProject,
      status: 'resolved',
      resolution_note: 'Refuted with evidence X.',
    });

    expect(mockUpdateStatus).toHaveBeenCalledWith(
      validId,
      validProject,
      'resolved',
      'Refuted with evidence X.'
    );
  });

  it('should throw ValidationError for invalid memory_id UUID', async () => {
    await expect(
      handleUpdateMemoryStatus({
        memory_id: 'not-a-uuid',
        project_id: validProject,
        status: 'open',
      } as any)
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for missing project_id', async () => {
    await expect(
      handleUpdateMemoryStatus({
        memory_id: validId,
        status: 'open',
      } as any)
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for non-kebab-case project_id', async () => {
    await expect(
      handleUpdateMemoryStatus({
        memory_id: validId,
        project_id: 'My Project',
        status: 'open',
      })
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for invalid status enum', async () => {
    await expect(
      handleUpdateMemoryStatus({
        memory_id: validId,
        project_id: validProject,
        status: 'bogus' as any,
      })
    ).rejects.toThrow(ValidationError);
  });

  it.each(['open', 'resolved', 'waived', 'superseded'] as const)(
    'should accept valid status %s',
    async (status) => {
      mockUpdateStatus.mockResolvedValue({ ...row, status });

      const note = status === 'open' ? undefined : 'A required note.';
      const result = await handleUpdateMemoryStatus({
        memory_id: validId,
        project_id: validProject,
        status,
        resolution_note: note,
      });

      expect(result.status).toBe(status);
    }
  );

  it.each(['resolved', 'waived', 'superseded'] as const)(
    'should reject closing status %s without resolution_note',
    async (status) => {
      await expect(
        handleUpdateMemoryStatus({
          memory_id: validId,
          project_id: validProject,
          status,
        })
      ).rejects.toThrow(ValidationError);

      expect(mockUpdateStatus).not.toHaveBeenCalled();
    }
  );

  it('should allow open status without resolution_note', async () => {
    mockUpdateStatus.mockResolvedValue({ ...row, status: 'open' });

    await handleUpdateMemoryStatus({
      memory_id: validId,
      project_id: validProject,
      status: 'open',
    });

    expect(mockUpdateStatus).toHaveBeenCalledWith(validId, validProject, 'open', undefined);
  });

  it('should propagate ValidationError when memory not found or expired', async () => {
    mockUpdateStatus.mockRejectedValue(
      new ValidationError(`Memory ${validId} not found or expired`)
    );

    await expect(
      handleUpdateMemoryStatus({
        memory_id: validId,
        project_id: validProject,
        status: 'open',
      })
    ).rejects.toThrow(ValidationError);
  });

  it('should propagate ValidationError when memory belongs to another project', async () => {
    mockUpdateStatus.mockRejectedValue(
      new ValidationError(`Memory ${validId} belongs to project other-project, not ${validProject}`)
    );

    await expect(
      handleUpdateMemoryStatus({
        memory_id: validId,
        project_id: validProject,
        status: 'open',
      })
    ).rejects.toThrow(`belongs to project other-project, not ${validProject}`);
  });

  it('should propagate DbError from the db layer', async () => {
    mockUpdateStatus.mockRejectedValue(new DbError('Status update failed: DB down'));

    await expect(
      handleUpdateMemoryStatus({
        memory_id: validId,
        project_id: validProject,
        status: 'open',
      })
    ).rejects.toThrow(DbError);
  });
});
