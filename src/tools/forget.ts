import { z } from 'zod';
import { expireMemoryById } from '../db.js';
import { ValidationError } from '../errors.js';

export const forgetInputSchemaBase = z
  .object({
    memory_id: z.string().uuid(),
    project_id: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'project_id must be kebab-case'),
  })
  .strict();

export type ForgetInput = z.infer<typeof forgetInputSchemaBase>;

export async function handleForget(input: ForgetInput) {
  const parsed = forgetInputSchemaBase.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    if (issues.some((i) => i.code === 'unrecognized_keys')) {
      throw new ValidationError(
        'forget is by-id only: bulk params (older_than_days) are not supported; pass memory_id and project_id'
      );
    }
    if ((input as Partial<ForgetInput> | null)?.memory_id === undefined) {
      throw new ValidationError('forget requires memory_id: project-wide forget was removed');
    }
    throw new ValidationError(
      `Invalid input: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { memory_id, project_id } = parsed.data;
  const outcome = await expireMemoryById(memory_id, project_id);

  if (outcome === 'already_expired') {
    return { memory_id, project_id, expired_count: 0, already_expired: true };
  }
  return { memory_id, project_id, expired_count: 1 };
}
