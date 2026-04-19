import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db.js', () => ({
  linkMemoriesAtomic: vi.fn(),
}));

import { handleLinkMemories } from '../../../src/tools/link-memories.js';
import { linkMemoriesAtomic } from '../../../src/db.js';
import { ValidationError } from '../../../src/errors.js';

const mockLinkMemoriesAtomic = vi.mocked(linkMemoriesAtomic);

describe('handleLinkMemories', () => {
  const validFrom = '550e8400-e29b-41d4-a716-446655440000';
  const validTo1 = '660e8400-e29b-41d4-a716-446655440001';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return {id, linked_to, relation} on success', async () => {
    mockLinkMemoriesAtomic.mockResolvedValue({
      id: validFrom,
      linked_to: [validTo1],
      relation: 'counters',
    });

    const result = await handleLinkMemories({
      from_id: validFrom,
      to_ids: [validTo1],
      relation: 'counters',
    });

    expect(result).toEqual({
      id: validFrom,
      linked_to: [validTo1],
      relation: 'counters',
    });
  });

  it('should pass null relation to linkMemoriesAtomic when omitted', async () => {
    mockLinkMemoriesAtomic.mockResolvedValue({
      id: validFrom,
      linked_to: [validTo1],
      relation: null,
    });

    await handleLinkMemories({ from_id: validFrom, to_ids: [validTo1] });

    expect(mockLinkMemoriesAtomic).toHaveBeenCalledWith(validFrom, [validTo1], null);
  });

  it('should pass provided relation enum value to helper', async () => {
    mockLinkMemoriesAtomic.mockResolvedValue({
      id: validFrom,
      linked_to: [validTo1],
      relation: 'fulfills',
    });

    await handleLinkMemories({
      from_id: validFrom,
      to_ids: [validTo1],
      relation: 'fulfills',
    });

    expect(mockLinkMemoriesAtomic).toHaveBeenCalledWith(validFrom, [validTo1], 'fulfills');
  });

  it('should throw ValidationError for invalid from_id UUID', async () => {
    await expect(
      handleLinkMemories({ from_id: 'not-a-uuid', to_ids: [validTo1] })
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for empty to_ids array', async () => {
    await expect(
      handleLinkMemories({ from_id: validFrom, to_ids: [] })
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for invalid to_ids UUIDs', async () => {
    await expect(
      handleLinkMemories({ from_id: validFrom, to_ids: ['not-a-uuid'] })
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for invalid relation enum', async () => {
    await expect(
      handleLinkMemories({
        from_id: validFrom,
        to_ids: [validTo1],
        relation: 'bogus' as any,
      })
    ).rejects.toThrow(ValidationError);
  });

  it('should propagate ValidationError when memory not found or expired', async () => {
    mockLinkMemoriesAtomic.mockRejectedValue(
      new ValidationError(`Memory ${validFrom} not found or expired`)
    );

    await expect(
      handleLinkMemories({ from_id: validFrom, to_ids: [validTo1] })
    ).rejects.toThrow(ValidationError);
  });
});
