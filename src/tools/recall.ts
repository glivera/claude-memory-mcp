import { z } from 'zod';
import { generateEmbedding } from '../embedding.js';
import { matchMemories, matchMemoriesWithLinks, type MatchResult } from '../db.js';
import { getConfig } from '../config.js';
import { truncateToTokenLimit, type TokenCappedEntry } from '../token-counter.js';
import { ValidationError } from '../errors.js';
import { STATUSES } from './remember.js';

export const recallInputSchema = z.object({
  query: z.string().min(1),
  project_id: z.string().optional(),
  memory_type: z.string().optional(),
  limit: z.number().min(1).max(20).optional(),
  since_days: z.number().positive().optional().describe('Only return memories created within the last N days'),
  status: z.enum(STATUSES).optional(),
  follow_links: z.boolean().optional().default(false),
  linked_type: z.string().optional(),
});

type RecallEntry = TokenCappedEntry & {
  status?: string;
  linked_to?: string[];
  relation?: string | null;
  link_depth?: number;
};

export type RecallInput = z.infer<typeof recallInputSchema>;

export async function handleRecall(input: RecallInput) {
  const parsed = recallInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const {
    query, project_id, memory_type, limit, since_days,
    status, follow_links, linked_type,
  } = parsed.data;
  const config = getConfig();

  const queryEmbedding = await generateEmbedding(query);

  let minCreatedAt: string | null = null;
  if (since_days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - since_days);
    minCreatedAt = cutoff.toISOString();
  }

  const useExtendedRpc = follow_links || status !== undefined;

  let results: MatchResult[];
  if (useExtendedRpc) {
    results = await matchMemoriesWithLinks(
      queryEmbedding,
      project_id ?? null,
      memory_type ?? null,
      status ?? null,
      limit ?? config.DEFAULT_RECALL_LIMIT,
      config.SIMILARITY_THRESHOLD,
      minCreatedAt,
      follow_links,
    );
  } else {
    results = await matchMemories(
      queryEmbedding,
      project_id ?? null,
      memory_type ?? null,
      limit ?? config.DEFAULT_RECALL_LIMIT,
      config.SIMILARITY_THRESHOLD,
      minCreatedAt,
    );
  }

  if (linked_type && useExtendedRpc) {
    results = results.filter((r) => r.link_depth === 0 || r.memory_type === linked_type);
  }

  const entries: RecallEntry[] = results
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
      status: r.status,
      linked_to: r.linked_to,
      relation: r.relation,
      link_depth: r.link_depth,
    }));

  return truncateToTokenLimit(entries, config.RECALL_TOKEN_CAP) as RecallEntry[];
}
