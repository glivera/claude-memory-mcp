import { z } from 'zod';
import { expireMemoryById, expireMemoriesByProject } from '../db.js';
import { ValidationError } from '../errors.js';

export const forgetInputSchemaBase = z.object({
  memory_id: z.string().uuid().optional(),
  project_id: z.string().optional(),
  older_than_days: z.number().positive().optional(),
});

export const forgetInputSchema = forgetInputSchemaBase
  .refine(
    (data) => data.memory_id || data.project_id,
    { message: 'At least memory_id or project_id is required' }
  )
  .refine(
    (data) => !(data.older_than_days && !data.project_id),
    { message: 'older_than_days requires project_id' }
  );

export type ForgetInput = z.infer<typeof forgetInputSchema>;

export async function handleForget(input: ForgetInput) {
  const parsed = forgetInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { memory_id, project_id, older_than_days } = parsed.data;

  let expiredCount: number;
  let targetProject: string;

  if (memory_id) {
    expiredCount = await expireMemoryById(memory_id);
    targetProject = project_id ?? 'unknown';
  } else {
    expiredCount = await expireMemoriesByProject(project_id!, older_than_days);
    targetProject = project_id!;
  }

  const result: Record<string, unknown> = {
    expired_count: expiredCount,
    project_id: targetProject,
  };

  if (!memory_id && !older_than_days) {
    result.warning = `All non-expired memories for project "${targetProject}" have been expired.`;
  }

  return result;
}
