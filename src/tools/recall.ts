import { z } from 'zod';
import { generateEmbedding } from '../embedding.js';
import { matchMemories } from '../db.js';
import { getConfig } from '../config.js';
import { truncateToTokenLimit, type TokenCappedEntry } from '../token-counter.js';
import { ValidationError } from '../errors.js';

export const recallInputSchema = z.object({
  query: z.string().min(1),
  project_id: z.string().optional(),
  memory_type: z.string().optional(),
  limit: z.number().min(1).max(20).optional(),
  since_days: z.number().positive().optional().describe('Only return memories created within the last N days'),
});

export type RecallInput = z.infer<typeof recallInputSchema>;

export async function handleRecall(input: RecallInput) {
  const parsed = recallInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { query, project_id, memory_type, limit, since_days } = parsed.data;
  const config = getConfig();

  const queryEmbedding = await generateEmbedding(query);

  const results = await matchMemories(
    queryEmbedding,
    project_id ?? null,
    memory_type ?? null,
    since_days ? (limit ?? config.DEFAULT_RECALL_LIMIT) * 3 : (limit ?? config.DEFAULT_RECALL_LIMIT),
    config.SIMILARITY_THRESHOLD
  );

  let filtered = results;
  if (since_days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - since_days);
    filtered = results.filter((r) => new Date(r.created_at) >= cutoff);
  }

  const entries: TokenCappedEntry[] = filtered
    .slice(0, limit ?? config.DEFAULT_RECALL_LIMIT)
    .map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      tags: r.tags,
      similarity: r.similarity,
      project_id: r.project_id,
      memory_type: r.memory_type,
      created_at: r.created_at,
    }));

  return truncateToTokenLimit(entries, config.RECALL_TOKEN_CAP);
}
