import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db.js', () => ({
  getGoalProgress: vi.fn(),
}));

import { handleGoalProgress } from '../../../src/tools/goal-progress.js';
import { getGoalProgress } from '../../../src/db.js';
import { ValidationError } from '../../../src/errors.js';

const mockGetGoalProgress = vi.mocked(getGoalProgress);

describe('handleGoalProgress', () => {
  const happyProgress = {
    total_goals: 3,
    completed: 1,
    in_progress: 2,
    waived: 0,
    deviations_open: 1,
    blockers_open: 0,
    completion_pct: 33,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return GoalProgress object for valid project_id', async () => {
    mockGetGoalProgress.mockResolvedValue(happyProgress);

    const result = await handleGoalProgress({ project_id: 'my-project' });

    expect(result).toEqual(happyProgress);
  });

  it('should pass goal_id to getGoalProgress when provided', async () => {
    mockGetGoalProgress.mockResolvedValue(happyProgress);
    const goalId = '550e8400-e29b-41d4-a716-446655440000';

    await handleGoalProgress({ project_id: 'my-project', goal_id: goalId });

    expect(mockGetGoalProgress).toHaveBeenCalledWith('my-project', goalId);
  });

  it('should call getGoalProgress with undefined goal_id when omitted', async () => {
    mockGetGoalProgress.mockResolvedValue(happyProgress);

    await handleGoalProgress({ project_id: 'my-project' });

    expect(mockGetGoalProgress).toHaveBeenCalledWith('my-project', undefined);
  });

  it('should return zero-progress jsonb for empty project', async () => {
    const zeroProgress = {
      total_goals: 0,
      completed: 0,
      in_progress: 0,
      waived: 0,
      deviations_open: 0,
      blockers_open: 0,
      completion_pct: 0,
    };
    mockGetGoalProgress.mockResolvedValue(zeroProgress);

    const result = await handleGoalProgress({ project_id: 'empty-project' });

    expect(result).toEqual(zeroProgress);
  });

  it('should throw ValidationError for non-kebab-case project_id', async () => {
    await expect(
      handleGoalProgress({ project_id: 'My Project' })
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for invalid UUID goal_id', async () => {
    await expect(
      handleGoalProgress({ project_id: 'my-project', goal_id: 'not-a-uuid' })
    ).rejects.toThrow(ValidationError);
  });
});
