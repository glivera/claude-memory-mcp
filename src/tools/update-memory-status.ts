import { z } from 'zod';
import { updateStatus } from '../db.js';
import { ValidationError } from '../errors.js';
import { STATUSES } from './remember.js';

const CLOSING_STATUSES = ['resolved', 'waived', 'superseded'] as const;

export const updateMemoryStatusInputSchema = z.object({
  memory_id: z.string().uuid(),
  project_id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'project_id must be kebab-case'),
  status: z.enum(STATUSES),
  resolution_note: z.string().optional(),
});

export type UpdateMemoryStatusInput = z.infer<typeof updateMemoryStatusInputSchema>;

export async function handleUpdateMemoryStatus(input: UpdateMemoryStatusInput) {
  const parsed = updateMemoryStatusInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { memory_id, project_id, status, resolution_note } = parsed.data;

  if (CLOSING_STATUSES.includes(status as (typeof CLOSING_STATUSES)[number]) && !resolution_note) {
    throw new ValidationError(
      `resolution_note is required when setting status to a closing status (${CLOSING_STATUSES.join(', ')})`
    );
  }

  const row = await updateStatus(memory_id, project_id, status, resolution_note);

  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    status: row.status,
  };
}
