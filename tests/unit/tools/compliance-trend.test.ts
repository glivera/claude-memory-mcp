import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db.js', () => ({
  getComplianceTrend: vi.fn(),
}));

import { handleComplianceTrend } from '../../../src/tools/compliance-trend.js';
import { getComplianceTrend } from '../../../src/db.js';
import { ValidationError } from '../../../src/errors.js';

const mockGetComplianceTrend = vi.mocked(getComplianceTrend);

describe('handleComplianceTrend', () => {
  const complianceRows = [
    {
      id: 'c1',
      title: 'GO gate for release',
      status: 'resolved',
      tags: ['security'],
      created_at: '2026-04-01T00:00:00Z',
      linked_to: [],
    },
    {
      id: 'c2',
      title: 'NO-GO — outdated dependency',
      status: 'open',
      tags: ['dependency'],
      created_at: '2026-04-05T00:00:00Z',
      linked_to: ['c1'],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return array of compliance_check rows for project', async () => {
    mockGetComplianceTrend.mockResolvedValue(complianceRows);

    const result = await handleComplianceTrend({ project_id: 'my-project' });

    expect(result).toEqual(complianceRows);
  });

  it('should use default since_days=30 when not provided', async () => {
    mockGetComplianceTrend.mockResolvedValue([]);

    await handleComplianceTrend({ project_id: 'my-project' });

    expect(mockGetComplianceTrend).toHaveBeenCalledWith('my-project', 30);
  });

  it('should pass custom since_days to helper', async () => {
    mockGetComplianceTrend.mockResolvedValue([]);

    await handleComplianceTrend({ project_id: 'my-project', since_days: 7 });

    expect(mockGetComplianceTrend).toHaveBeenCalledWith('my-project', 7);
  });

  it('should return empty array for project with no compliance_checks', async () => {
    mockGetComplianceTrend.mockResolvedValue([]);

    const result = await handleComplianceTrend({ project_id: 'empty-project' });

    expect(result).toEqual([]);
  });

  it('should throw ValidationError for since_days > 365', async () => {
    await expect(
      handleComplianceTrend({ project_id: 'my-project', since_days: 366 })
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for since_days <= 0', async () => {
    await expect(
      handleComplianceTrend({ project_id: 'my-project', since_days: 0 })
    ).rejects.toThrow(ValidationError);
  });
});
