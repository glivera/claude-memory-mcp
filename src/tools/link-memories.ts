import { z } from 'zod';
import { linkMemoriesAtomic } from '../db.js';
import { ValidationError } from '../errors.js';
import { RELATIONS } from './remember.js';

export const linkMemoriesInputSchema = z.object({
  from_id: z.string().uuid(),
  to_ids: z.array(z.string().uuid()).min(1),
  relation: z.enum(RELATIONS).optional(),
});

export type LinkMemoriesInput = z.infer<typeof linkMemoriesInputSchema>;

export async function handleLinkMemories(input: LinkMemoriesInput) {
  const parsed = linkMemoriesInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }

  const { from_id, to_ids, relation } = parsed.data;
  return linkMemoriesAtomic(from_id, to_ids, relation ?? null);
}
