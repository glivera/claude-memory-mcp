import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db.js', () => ({
  getMemoryStats: vi.fn(),
  getLatestContext: vi.fn(),
}));

import { handleProjectStatus } from '../../../src/tools/project-status.js';
import { getMemoryStats, getLatestContext } from '../../../src/db.js';

const mockGetMemoryStats = vi.mocked(getMemoryStats);
const mockGetLatestContext = vi.mocked(getLatestContext);

describe('handleProjectStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return grouped project stats', async () => {
    mockGetMemoryStats.mockResolvedValue([
      { project_id: 'proj-a', memory_type: 'decision', count: 3, last_updated: '2026-01-10T00:00:00Z' },
      { project_id: 'proj-a', memory_type: 'bug_fix', count: 2, last_updated: '2026-01-08T00:00:00Z' },
      { project_id: 'proj-b', memory_type: 'pattern', count: 5, last_updated: '2026-01-12T00:00:00Z' },
    ]);
    mockGetLatestContext.mockResolvedValue('Some context text');

    const result = await handleProjectStatus({});

    expect(result.projects).toHaveLength(2);

    const projA = result.projects.find((p) => p.project_id === 'proj-a');
    expect(projA).toBeDefined();
    expect(projA!.memory_counts).toEqual({ decision: 3, bug_fix: 2 });
    expect(projA!.total_memories).toBe(5);
    expect(projA!.last_updated).toBe('2026-01-10T00:00:00Z');
    expect(projA!.latest_context).toBe('Some context text');

    const projB = result.projects.find((p) => p.project_id === 'proj-b');
    expect(projB).toBeDefined();
    expect(projB!.memory_counts).toEqual({ pattern: 5 });
    expect(projB!.total_memories).toBe(5);
  });

  it('should return empty projects array when no stats', async () => {
    mockGetMemoryStats.mockResolvedValue([]);

    const result = await handleProjectStatus({});

    expect(result.projects).toEqual([]);
  });

  it('should filter by project_id when provided', async () => {
    mockGetMemoryStats.mockResolvedValue([
      { project_id: 'my-project', memory_type: 'decision', count: 4, last_updated: '2026-02-01T00:00:00Z' },
    ]);
    mockGetLatestContext.mockResolvedValue(null);

    const result = await handleProjectStatus({ project_id: 'my-project' });

    expect(mockGetMemoryStats).toHaveBeenCalledWith('my-project');
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].project_id).toBe('my-project');
  });

  it('should call getMemoryStats without project_id when not provided', async () => {
    mockGetMemoryStats.mockResolvedValue([]);

    await handleProjectStatus({});

    expect(mockGetMemoryStats).toHaveBeenCalledWith(undefined);
  });

  it('should fetch latest context for each project', async () => {
    mockGetMemoryStats.mockResolvedValue([
      { project_id: 'proj-a', memory_type: 'decision', count: 1, last_updated: '2026-01-01T00:00:00Z' },
      { project_id: 'proj-b', memory_type: 'pattern', count: 2, last_updated: '2026-01-02T00:00:00Z' },
    ]);
    mockGetLatestContext
      .mockResolvedValueOnce('Context A')
      .mockResolvedValueOnce(null);

    const result = await handleProjectStatus({});

    expect(mockGetLatestContext).toHaveBeenCalledTimes(2);
    expect(mockGetLatestContext).toHaveBeenCalledWith('proj-a');
    expect(mockGetLatestContext).toHaveBeenCalledWith('proj-b');

    const projA = result.projects.find((p) => p.project_id === 'proj-a');
    expect(projA!.latest_context).toBe('Context A');

    const projB = result.projects.find((p) => p.project_id === 'proj-b');
    expect(projB!.latest_context).toBeNull();
  });

  it('should use the latest last_updated across memory types for a project', async () => {
    mockGetMemoryStats.mockResolvedValue([
      { project_id: 'proj-a', memory_type: 'decision', count: 1, last_updated: '2026-01-05T00:00:00Z' },
      { project_id: 'proj-a', memory_type: 'context', count: 2, last_updated: '2026-01-15T00:00:00Z' },
      { project_id: 'proj-a', memory_type: 'bug_fix', count: 1, last_updated: '2026-01-10T00:00:00Z' },
    ]);
    mockGetLatestContext.mockResolvedValue(null);

    const result = await handleProjectStatus({});

    expect(result.projects[0].last_updated).toBe('2026-01-15T00:00:00Z');
  });

  it('should sum total_memories across all memory types', async () => {
    mockGetMemoryStats.mockResolvedValue([
      { project_id: 'proj-a', memory_type: 'decision', count: 10, last_updated: '2026-01-01T00:00:00Z' },
      { project_id: 'proj-a', memory_type: 'bug_fix', count: 5, last_updated: '2026-01-01T00:00:00Z' },
      { project_id: 'proj-a', memory_type: 'pattern', count: 3, last_updated: '2026-01-01T00:00:00Z' },
    ]);
    mockGetLatestContext.mockResolvedValue(null);

    const result = await handleProjectStatus({});

    expect(result.projects[0].total_memories).toBe(18);
  });
});
