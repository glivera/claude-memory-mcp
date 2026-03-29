import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { patternStoreInputSchema, handlePatternStore } from './pattern-store.js';
import { patternSearchInputSchema, handlePatternSearch } from './pattern-search.js';
import { patternMatureInputSchema, handlePatternMature } from './pattern-mature.js';
import { patternMarkInputSchema, handlePatternMark } from './pattern-mark.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

function formatError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `[Error] ${message}` }],
    isError: true,
  };
}

export function registerPatternTools(server: McpServer): void {
  server.tool(
    'pattern_store',
    'Save a reusable work pattern (Docker setup, migration strategy, debugging approach, etc.). Auto-deduplicates: if a similar pattern exists, merges and increments count. When count reaches 3, flags as skill candidate. Call whenever you notice a repeating approach across projects.',
    patternStoreInputSchema.shape,
    async (input) => {
      try {
        const result = await handlePatternStore(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  server.tool(
    'pattern_search',
    'Search stored work patterns by meaning. Call before starting non-trivial tasks to check if a known approach exists. Filter by category (devops, code, supabase, etc.) or project.',
    patternSearchInputSchema.shape,
    async (input) => {
      try {
        const results = await handlePatternSearch(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  server.tool(
    'pattern_mature',
    'List patterns seen 3+ times — candidates for converting into SKILL.md files. Returns patterns grouped by category with all accumulated examples. Call periodically or when user asks about skill generation.',
    patternMatureInputSchema.shape,
    async (input) => {
      try {
        const result = await handlePatternMature(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  server.tool(
    'pattern_mark_as_skill',
    'Mark patterns as converted to SKILL.md files so they stop appearing in pattern_mature results. Call after generating a skill from a mature pattern.',
    patternMarkInputSchema.shape,
    async (input) => {
      try {
        const result = await handlePatternMark(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );
}
