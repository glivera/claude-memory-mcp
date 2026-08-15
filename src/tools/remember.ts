import { z } from 'zod';
import { generateEmbedding } from '../embedding.js';
import { insertMemory } from '../db.js';
import { ValidationError } from '../errors.js';

export const MEMORY_TYPES = [
  'decision', 'bug_fix', 'pattern', 'context',
  'blocker', 'learning', 'convention', 'dependency',
  'goal', 'deviation', 'counter_argument', 'compliance_check',
] as const;

export const RELATIONS = [
  'counters', 'fulfills', 'deviates_from',
  'blocks', 'resolves', 'supersedes',
] as const;

export const STATUSES = ['open', 'resolved', 'waived', 'superseded'] as const;

export const rememberInputSchema = z.object({
  project_id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'project_id must be kebab-case'),
  memory_type: z.enum(MEMORY_TYPES),
  title: z.string().max(120),
  content: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  expires_in_days: z.number().positive().optional(),
  session_id: z.string().optional(),
  linked_to: z.array(z.string().uuid()).optional().default([]),
  relation: z.enum(RELATIONS).optional(),
  status: z.enum(STATUSES).optional().default('open'),
  provenance: z.enum(['user_authored', 'agent_inferred', 'recalled_external']).optional().describe('Origin of this content. Session-inferred summaries/decisions SHOULD pass agent_inferred; anything derived from external/untrusted content (web, foreign docs, tool results) MUST pass recalled_external.'),
  trust_score: z.number().min(0).max(1).optional(),
});

export type RememberInput = z.infer<typeof rememberInputSchema>;

export async function handleRemember(input: RememberInput) {
  const parsed = rememberInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const {
    project_id, memory_type, title, content, tags, expires_in_days, session_id,
    linked_to, relation, status, provenance, trust_score,
  } = parsed.data;

  const embedding = await generateEmbedding(`${title} ${content}`);

  const expiresAt = expires_in_days
    ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
    : null;

  const provenanceValue = provenance ?? 'user_authored';
  const trustScoreValue = trust_score ?? (provenanceValue === 'recalled_external' ? 0.5 : 1.0);

  const row = await insertMemory({
    project_id,
    memory_type,
    title,
    content,
    tags,
    embedding,
    session_id: session_id ?? null,
    expires_at: expiresAt,
    linked_to,
    relation: relation ?? null,
    status,
    provenance: provenanceValue,
    trust_score: trustScoreValue,
  });

  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    memory_type: row.memory_type,
    created_at: row.created_at,
    linked_to: row.linked_to,
    relation: row.relation,
    status: row.status,
    provenance: provenanceValue,
    trust_score: trustScoreValue,
  };
}
