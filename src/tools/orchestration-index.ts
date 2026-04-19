import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { handleGoalProgress, goalProgressInputSchema } from './goal-progress.js';
import { handleLinkMemories, linkMemoriesInputSchema } from './link-memories.js';
import { handleComplianceTrend, complianceTrendInputSchema } from './compliance-trend.js';

export { handleGoalProgress, goalProgressInputSchema, type GoalProgressInput } from './goal-progress.js';
export { handleLinkMemories, linkMemoriesInputSchema, type LinkMemoriesInput } from './link-memories.js';
export { handleComplianceTrend, complianceTrendInputSchema, type ComplianceTrendInput } from './compliance-trend.js';

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
}
