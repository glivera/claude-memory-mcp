import { z } from 'zod';
import { getSupabaseClient } from '../db.js';
import { ValidationError, DbError } from '../errors.js';

const TABLE = 'skill_patterns';

export const patternMarkInputSchema = z.object({
  pattern_ids: z.array(z.string().uuid()).min(1).describe('UUIDs of patterns to mark as skill_created'),
});

export type PatternMarkInput = z.infer<typeof patternMarkInputSchema>;

export async function handlePatternMark(input: PatternMarkInput) {
  const parsed = patternMarkInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { pattern_ids } = parsed.data;

  const db = getSupabaseClient();

  const { data, error } = await db
    .from(TABLE)
    .update({ skill_created: true })
    .in('id', pattern_ids)
    .select('id');

  if (error) {
    throw new DbError(`Pattern mark failed: ${error.message}`, { cause: error });
  }

  return {
    updated_count: data?.length ?? 0,
    pattern_ids,
  };
}
