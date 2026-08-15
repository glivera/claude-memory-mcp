import { z } from 'zod';
import { listMemories } from '../db.js';
import { ValidationError } from '../errors.js';
import { MEMORY_TYPES, STATUSES } from './remember.js';

export const listMemoriesInputSchema = z.object({
  project_id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'project_id must be kebab-case'),
  memory_type: z.enum(MEMORY_TYPES).optional(),
  status: z.enum(STATUSES).optional(),
  since_days: z.number().positive().optional(),
  limit: z.number().positive().max(100).optional().default(50),
});

export type ListMemoriesInput = z.infer<typeof listMemoriesInputSchema>;

export async function handleListMemories(input: ListMemoriesInput) {
  const parsed = listMemoriesInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { project_id, memory_type, status, since_days, limit } = parsed.data;

  return listMemories(project_id, {
    memoryType: memory_type,
    status,
    sinceDays: since_days,
    limit,
  });
}
