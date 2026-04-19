import { z } from 'zod';
import { getGoalProgress } from '../db.js';
import { ValidationError } from '../errors.js';

export const goalProgressInputSchema = z.object({
  project_id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'project_id must be kebab-case'),
  goal_id: z.string().uuid().optional(),
});

export type GoalProgressInput = z.infer<typeof goalProgressInputSchema>;

export async function handleGoalProgress(input: GoalProgressInput) {
  const parsed = goalProgressInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  return getGoalProgress(parsed.data.project_id, parsed.data.goal_id);
}
