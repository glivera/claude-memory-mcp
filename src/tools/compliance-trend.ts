import { z } from 'zod';
import { getComplianceTrend } from '../db.js';
import { ValidationError } from '../errors.js';

export const complianceTrendInputSchema = z.object({
  project_id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'project_id must be kebab-case'),
  since_days: z.number().positive().max(365).optional().default(30),
});

export type ComplianceTrendInput = z.infer<typeof complianceTrendInputSchema>;

export async function handleComplianceTrend(input: ComplianceTrendInput) {
  const parsed = complianceTrendInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  return getComplianceTrend(parsed.data.project_id, parsed.data.since_days);
}
