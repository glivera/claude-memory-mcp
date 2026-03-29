import { z } from 'zod';
import { generateEmbedding } from '../embedding.js';
import { getSupabaseClient } from '../db.js';
import { ValidationError, EmbeddingError, DbError } from '../errors.js';

const PATTERN_CATEGORIES = [
  'n8n', 'supabase', 'devops', 'client', 'content', 'code', 'architecture', 'other',
] as const;

const DEDUP_THRESHOLD = 0.75;
const TABLE = 'skill_patterns';

export const patternStoreInputSchema = z.object({
  description: z.string().min(10).max(1000).describe('What the pattern is and when it applies'),
  category: z.enum(PATTERN_CATEGORIES).describe('Pattern category'),
  project: z.string().max(100).optional().nullable().describe('Project name or null for universal patterns'),
  example: z.string().min(10).max(2000).describe('Concrete example from the current session'),
});

export type PatternStoreInput = z.infer<typeof patternStoreInputSchema>;

function generatePatternId(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function handlePatternStore(input: PatternStoreInput) {
  const parsed = patternStoreInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { description, category, project, example } = parsed.data;

  let embedding: number[];
  try {
    embedding = await generateEmbedding(description);
  } catch (err) {
    throw new EmbeddingError(
      `Failed to embed pattern description: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  const db = getSupabaseClient();

  // Check for similar existing pattern
  const { data: matches, error: matchError } = await db.rpc('match_skill_patterns', {
    query_embedding: embedding,
    match_threshold: DEDUP_THRESHOLD,
    match_count: 1,
    filter_category: category,
    filter_project: project ?? null,
  });

  if (matchError) {
    throw new DbError(`Pattern match query failed: ${matchError.message}`, { cause: matchError });
  }

  const exampleEntry = { text: example, date: new Date().toISOString() };

  if (matches && matches.length > 0) {
    const existing = matches[0];
    const newCount = existing.count + 1;
    const updatedExamples = [...(existing.examples as Array<{ text: string; date: string }>), exampleEntry];

    const { error: updateError } = await db
      .from(TABLE)
      .update({
        count: newCount,
        examples: updatedExamples,
        last_seen: new Date().toISOString(),
        proposed_skill: newCount >= 3,
      })
      .eq('id', existing.id);

    if (updateError) {
      throw new DbError(`Pattern update failed: ${updateError.message}`, { cause: updateError });
    }

    return {
      action: 'merged' as const,
      pattern_id: existing.pattern_id,
      new_count: newCount,
      proposed_skill: newCount >= 3,
      message: `Merged into existing pattern "${existing.pattern_id}" (count: ${newCount})`,
    };
  }

  // Create new pattern
  const patternId = generatePatternId(description);

  const { error: insertError } = await db
    .from(TABLE)
    .insert({
      pattern_id: patternId,
      description,
      category,
      project: project ?? null,
      examples: [exampleEntry],
      count: 1,
      embedding,
    });

  if (insertError) {
    throw new DbError(`Pattern insert failed: ${insertError.message}`, { cause: insertError });
  }

  return {
    action: 'created' as const,
    pattern_id: patternId,
    count: 1,
    message: `Created new pattern "${patternId}"`,
  };
}
