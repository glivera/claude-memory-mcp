import { z } from 'zod';
import { getMemoryStats, getLatestContext } from '../db.js';

export const projectStatusInputSchema = z.object({
  project_id: z.string().optional(),
});

export type ProjectStatusInput = z.infer<typeof projectStatusInputSchema>;

export async function handleProjectStatus(input: ProjectStatusInput) {
  const { project_id } = input;

  const stats = await getMemoryStats(project_id);

  const projectMap = new Map<
    string,
    { memory_counts: Record<string, number>; total_memories: number; last_updated: string }
  >();

  for (const row of stats) {
    let entry = projectMap.get(row.project_id);
    if (!entry) {
      entry = { memory_counts: {}, total_memories: 0, last_updated: row.last_updated };
      projectMap.set(row.project_id, entry);
    }
    entry.memory_counts[row.memory_type] = row.count;
    entry.total_memories += row.count;
    if (row.last_updated > entry.last_updated) {
      entry.last_updated = row.last_updated;
    }
  }

  const projects = await Promise.all(
    Array.from(projectMap.entries()).map(async ([pid, entry]) => {
      const latestContext = await getLatestContext(pid);
      return {
        project_id: pid,
        memory_counts: entry.memory_counts,
        total_memories: entry.total_memories,
        last_updated: entry.last_updated,
        latest_context: latestContext,
      };
    })
  );

  return { projects };
}
