import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake supabase-js client. Every builder method returns the builder itself, so the
// test does not depend on the exact chain order inside expireMemoryById.
// Result routing: a builder on which update() was called resolves to the update
// result; otherwise it resolves to the lookup (select) result. maybeSingle()/single()
// resolve the same way, with array data collapsed to its first row.
interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

const state = vi.hoisted(() => ({
  lookup: { data: null, error: null } as FakeResult,
  update: { data: [], error: null } as FakeResult,
  updateSpy: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => {
      let isUpdate = false;
      const result = (): FakeResult => (isUpdate ? state.update : state.lookup);
      const first = (): FakeResult => {
        const r = result();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'or', 'is', 'gt', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      builder.update = (...args: unknown[]) => {
        isUpdate = true;
        state.updateSpy(...args);
        return builder;
      };
      builder.maybeSingle = () => Promise.resolve(first());
      builder.single = () => Promise.resolve(first());
      builder.then = (resolve: (v: FakeResult) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return builder;
    },
  })),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_KEY: 'test-key',
  })),
}));

vi.mock('../../src/embedding.js', () => ({
  generateEmbedding: vi.fn(),
}));

import { expireMemoryById, resetDbClient } from '../../src/db.js';
import { ValidationError } from '../../src/errors.js';

const MEMORY_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('expireMemoryById', () => {
  beforeEach(() => {
    resetDbClient();
    state.updateSpy = vi.fn();
    state.lookup = { data: null, error: null };
    state.update = { data: [], error: null };
  });

  it('should throw a not found ValidationError when the memory does not exist', async () => {
    state.lookup = { data: null, error: null };

    await expect(expireMemoryById(MEMORY_ID, 'proj-a')).rejects.toThrow(ValidationError);
    await expect(expireMemoryById(MEMORY_ID, 'proj-a')).rejects.toThrow(/not found/);
    expect(state.updateSpy).not.toHaveBeenCalled();
  });

  it('should throw a "belongs to project" ValidationError and not update on project mismatch', async () => {
    state.lookup = {
      data: { id: MEMORY_ID, project_id: 'proj-b', expires_at: null },
      error: null,
    };

    await expect(expireMemoryById(MEMORY_ID, 'proj-a')).rejects.toThrow(ValidationError);
    await expect(expireMemoryById(MEMORY_ID, 'proj-a')).rejects.toThrow(
      /belongs to project proj-b/
    );
    expect(state.updateSpy).not.toHaveBeenCalled();
  });

  it('should return already_expired and not update when the row is already expired', async () => {
    state.lookup = {
      data: { id: MEMORY_ID, project_id: 'proj-a', expires_at: '2020-01-01T00:00:00.000Z' },
      error: null,
    };

    const result = await expireMemoryById(MEMORY_ID, 'proj-a');

    expect(result).toBe('already_expired');
    expect(state.updateSpy).not.toHaveBeenCalled();
  });

  it('should call update and return expired for a live row', async () => {
    state.lookup = {
      data: { id: MEMORY_ID, project_id: 'proj-a', expires_at: null },
      error: null,
    };
    state.update = { data: [{ id: MEMORY_ID }], error: null };

    const result = await expireMemoryById(MEMORY_ID, 'proj-a');

    expect(result).toBe('expired');
    expect(state.updateSpy).toHaveBeenCalledTimes(1);
    expect(state.updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: expect.any(String) })
    );
  });

  it('should return already_expired when update affects zero rows (concurrent expiry)', async () => {
    state.lookup = {
      data: { id: MEMORY_ID, project_id: 'proj-a', expires_at: null },
      error: null,
    };
    state.update = { data: [], error: null };

    const result = await expireMemoryById(MEMORY_ID, 'proj-a');

    expect(result).toBe('already_expired');
    expect(state.updateSpy).toHaveBeenCalledTimes(1);
  });
});
