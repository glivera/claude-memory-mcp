import { z } from 'zod';
import { expireMemoryById, expireMemoriesByProject } from '../db.js';
import { ValidationError } from '../errors.js';

export const forgetInputSchemaBase = z.object({
  memory_id: z.string().uuid().optional(),
  project_id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'project_id must be kebab-case'),
  older_than_days: z.number().positive().optional(),
});

export type ForgetInput = z.infer<typeof forgetInputSchemaBase>;

export async function handleForget(input: ForgetInput) {
  const parsed = forgetInputSchemaBase.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { memory_id, project_id, older_than_days } = parsed.data;

  let expiredCount: number;

  if (memory_id) {
    expiredCount = await expireMemoryById(memory_id, project_id);
  } else {
    expiredCount = await expireMemoriesByProject(project_id, older_than_days);
  }

  const result: Record<string, unknown> = {
    expired_count: expiredCount,
    project_id,
  };

  if (!memory_id && !older_than_days) {
    result.warning = `All non-expired memories for project "${project_id}" have been expired.`;
  }

  return result;
}
