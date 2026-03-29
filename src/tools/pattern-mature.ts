import { z } from 'zod';
import { getSupabaseClient } from '../db.js';
import { ValidationError, DbError } from '../errors.js';

export const patternMatureInputSchema = z.object({
  min_count: z.number().int().min(1).optional().default(3).describe('Minimum occurrence count to be considered mature'),
  category: z.string().optional().nullable().describe('Filter by category'),
  exclude_created: z.boolean().optional().default(true).describe('Exclude patterns already converted to skills'),
});

export type PatternMatureInput = z.infer<typeof patternMatureInputSchema>;

interface MaturePattern {
  id: string;
  pattern_id: string;
  description: string;
  category: string;
  project: string | null;
  examples: Array<{ text: string; date: string }>;
  count: number;
  first_seen: string;
  last_seen: string;
}

export async function handlePatternMature(input: PatternMatureInput) {
  const parsed = patternMatureInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { min_count, category, exclude_created } = parsed.data;

  const db = getSupabaseClient();

  const { data, error } = await db.rpc('get_mature_patterns', {
    min_count: min_count ?? 3,
    filter_category: category ?? null,
    exclude_created: exclude_created ?? true,
  });

  if (error) {
    throw new DbError(`Mature patterns query failed: ${error.message}`, { cause: error });
  }

  const patterns = (data ?? []) as MaturePattern[];

  // Group by category
  const grouped: Record<string, MaturePattern[]> = {};
  for (const p of patterns) {
    if (!grouped[p.category]) {
      grouped[p.category] = [];
    }
    grouped[p.category].push(p);
  }

  return {
    total: patterns.length,
    by_category: grouped,
  };
}
