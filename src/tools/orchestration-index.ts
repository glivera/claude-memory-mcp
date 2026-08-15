import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { handleGoalProgress, goalProgressInputSchema } from './goal-progress.js';
import { handleLinkMemories, linkMemoriesInputSchema } from './link-memories.js';
import { handleComplianceTrend, complianceTrendInputSchema } from './compliance-trend.js';
import { handleUpdateMemoryStatus, updateMemoryStatusInputSchema } from './update-memory-status.js';
import { handleListMemories, listMemoriesInputSchema } from './list-memories.js';

export { handleGoalProgress, goalProgressInputSchema, type GoalProgressInput } from './goal-progress.js';
export { handleLinkMemories, linkMemoriesInputSchema, type LinkMemoriesInput } from './link-memories.js';
export { handleComplianceTrend, complianceTrendInputSchema, type ComplianceTrendInput } from './compliance-trend.js';
export { handleUpdateMemoryStatus, updateMemoryStatusInputSchema, type UpdateMemoryStatusInput } from './update-memory-status.js';
export { handleListMemories, listMemoriesInputSchema, type ListMemoriesInput } from './list-memories.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

function formatError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `[Error] ${message}` }],
    isError: true,
  };
}

export function registerOrchestrationTools(server: McpServer): void {
  server.tool(
    'goal_progress',
    'Get plan completion stats for a project. Returns total_goals, completed, in_progress, deviations_open, completion_pct.',
    goalProgressInputSchema.shape,
    async (input) => {
      try {
        const result = await handleGoalProgress(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  server.tool(
    'link_memories',
    'Link a memory to other memories with a semantic relation (counters, fulfills, deviates_from, blocks, resolves, supersedes). Atomic — race-free.',
    linkMemoriesInputSchema.shape,
    async (input) => {
      try {
        const result = await handleLinkMemories(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  server.tool(
    'compliance_trend',
    'Return compliance_check memories for a project within the last N days (default 30, max 365), most recent first.',
    complianceTrendInputSchema.shape,
    async (input) => {
      try {
        const results = await handleComplianceTrend(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  server.tool(
    'update_memory_status',
    'Update the status of an existing memory (open, resolved, waived, superseded). Requires project_id ownership match — refuses memories belonging to another project. resolution_note is required when closing (resolved, waived, superseded); it is appended to the memory content with a date-stamped [CLOSURE] line and the content is re-embedded. No transition guard — last-write-wins, re-opening a closed memory is allowed. Refuses expired or not-found rows.',
    updateMemoryStatusInputSchema.shape,
    async (input) => {
      try {
        const result = await handleUpdateMemoryStatus(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  server.tool(
    'list_memories',
    'Enumerate memories for a project by exact filters (memory_type, status, since_days) — no semantic search, no embedding. Use this for sweeps and counts where recall\'s embedding-ranked top-N would miss or misrank results. Returns compact rows (id, title, memory_type, status, created_at) plus an exact total count.',
    listMemoriesInputSchema.shape,
    async (input) => {
      try {
        const result = await handleListMemories(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );
}
