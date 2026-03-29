import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db.js', () => ({
  getSupabaseClient: vi.fn(),
}));

import { handlePatternMark } from '../../../src/tools/pattern-mark.js';
import { getSupabaseClient } from '../../../src/db.js';
import { ValidationError } from '../../../src/errors.js';

const mockGetSupabaseClient = vi.mocked(getSupabaseClient);

function createMockClient(selectResult: { data: unknown; error: unknown }) {
  return {
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({
        in: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(selectResult),
        }),
      }),
    }),
  };
}

describe('handlePatternMark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should mark a single pattern as skill_created', async () => {
    const mockClient = createMockClient({
      data: [{ id: '550e8400-e29b-41d4-a716-446655440000' }],
      error: null,
    });
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    const result = await handlePatternMark({
      pattern_ids: ['550e8400-e29b-41d4-a716-446655440000'],
    });

    expect(result.updated_count).toBe(1);
    expect(result.pattern_ids).toEqual(['550e8400-e29b-41d4-a716-446655440000']);
  });

  it('should mark multiple patterns', async () => {
    const ids = [
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440002',
      '550e8400-e29b-41d4-a716-446655440003',
    ];
    const mockClient = createMockClient({
      data: ids.map((id) => ({ id })),
      error: null,
    });
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    const result = await handlePatternMark({ pattern_ids: ids });

    expect(result.updated_count).toBe(3);
  });

  it('should return 0 for non-existent IDs', async () => {
    const mockClient = createMockClient({ data: [], error: null });
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    const result = await handlePatternMark({
      pattern_ids: ['550e8400-e29b-41d4-a716-446655440099'],
    });

    expect(result.updated_count).toBe(0);
  });

  it('should reject empty array', async () => {
    await expect(
      handlePatternMark({ pattern_ids: [] })
    ).rejects.toThrow(ValidationError);
  });

  it('should reject non-UUID strings', async () => {
    await expect(
      handlePatternMark({ pattern_ids: ['not-a-uuid'] })
    ).rejects.toThrow(ValidationError);
  });

  it('should throw on DB error', async () => {
    const mockClient = createMockClient({ data: null, error: { message: 'DB error' } });
    mockGetSupabaseClient.mockReturnValue(mockClient as any);

    await expect(
      handlePatternMark({ pattern_ids: ['550e8400-e29b-41d4-a716-446655440000'] })
    ).rejects.toThrow('Pattern mark failed');
  });
});
