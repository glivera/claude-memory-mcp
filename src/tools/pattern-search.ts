import { z } from 'zod';
import { generateEmbedding } from '../embedding.js';
import { getSupabaseClient } from '../db.js';
import { ValidationError, EmbeddingError, DbError } from '../errors.js';

const SEARCH_THRESHOLD = 0.25;

export const patternSearchInputSchema = z.object({
  query: z.string().min(1).describe('Semantic search query'),
  category: z.string().optional().nullable().describe('Filter by category'),
  project: z.string().optional().nullable().describe('Filter by project'),
  min_count: z.number().int().min(1).optional().describe('Minimum occurrence count'),
  limit: z.number().int().min(1).max(50).optional().default(10).describe('Max results'),
});

export type PatternSearchInput = z.infer<typeof patternSearchInputSchema>;

export async function handlePatternSearch(input: PatternSearchInput) {
  const parsed = patternSearchInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { query, category, project, min_count, limit } = parsed.data;

  let embedding: number[];
  try {
    embedding = await generateEmbedding(query);
  } catch (err) {
    throw new EmbeddingError(
      `Failed to embed search query: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  const db = getSupabaseClient();

  const { data, error } = await db.rpc('match_skill_patterns', {
    query_embedding: embedding,
    match_threshold: SEARCH_THRESHOLD,
    match_count: limit ?? 10,
    filter_category: category ?? null,
    filter_project: project ?? null,
  });

  if (error) {
    throw new DbError(`Pattern search failed: ${error.message}`, { cause: error });
  }

  let results = (data ?? []) as Array<{
    id: string;
    pattern_id: string;
    description: string;
    category: string;
    project: string | null;
    examples: Array<{ text: string; date: string }>;
    count: number;
    first_seen: string;
    last_seen: string;
    proposed_skill: boolean;
    skill_created: boolean;
    similarity: number;
  }>;

  if (min_count !== undefined) {
    results = results.filter((r) => r.count >= min_count);
  }

  return results.map((r) => ({
    id: r.id,
    pattern_id: r.pattern_id,
    description: r.description,
    category: r.category,
    project: r.project,
    count: r.count,
    examples: r.examples,
    proposed_skill: r.proposed_skill,
    skill_created: r.skill_created,
    similarity: r.similarity,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  }));
}
