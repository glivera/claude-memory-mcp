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
    'Store or merge a reusable work pattern with automatic deduplication (similarity > 0.9)',
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
    'Semantic search across stored skill patterns',
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
    'Retrieve mature patterns (seen 3+ times) ready for skill creation',
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
    'Mark patterns as converted to SKILL.md files',
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
