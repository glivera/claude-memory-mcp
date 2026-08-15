import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { rememberInputSchema, handleRemember } from './tools/remember.js';
import { recallInputSchema, handleRecall, wrapRecallResult } from './tools/recall.js';
import { getConfig } from './config.js';
import { forgetInputSchemaBase, handleForget } from './tools/forget.js';
import { projectStatusInputSchema, handleProjectStatus } from './tools/project-status.js';
import { ValidationError, EmbeddingError, DbError } from './errors.js';
import { registerPatternTools } from './tools/patterns-index.js';
import { registerOrchestrationTools } from './tools/orchestration-index.js';
import { logToolCall } from './log.js';

const TRANSPORT = process.env.MCP_TRANSPORT || 'http';
const PORT = parseInt(process.env.MCP_PORT || '3100', 10);

function formatError(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  const errorType =
    err instanceof ValidationError ? 'ValidationError' :
    err instanceof EmbeddingError ? 'EmbeddingError' :
    err instanceof DbError ? 'DbError' :
    'Error';

  return {
    content: [{ type: 'text' as const, text: `[${errorType}] ${message}` }],
    isError: true,
  };
}

function registerTools(server: McpServer): void {
  server.tool(
    'remember',
    'Save a decision, bug fix, pattern, convention, or context to long-term memory. Call after: architectural decisions, resolved bugs, discovered patterns, new conventions, session summaries. Requires project_id (kebab-case from directory name) and memory_type.',
    rememberInputSchema.shape,
    async (input) => {
      const startMs = Date.now();
      try {
        const result = await handleRemember(input);
        logToolCall('remember', input, startMs);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logToolCall('remember', input, startMs, err);
        return formatError(err);
      }
    }
  );

  server.tool(
    'recall',
    'Search memories by meaning. Call before: starting non-trivial work, using APIs/integrations, setting up features. Use project_id to search within a project, omit for cross-project search. Use since_days to filter recent memories (e.g., "what happened this week").',
    recallInputSchema.shape,
    async (input) => {
      const startMs = Date.now();
      try {
        const results = await handleRecall(input);
        logToolCall('recall', input, startMs);
        return { content: [{ type: 'text' as const, text: wrapRecallResult(results, getConfig().RECALL_ENVELOPE === '1') }] };
      } catch (err) {
        logToolCall('recall', input, startMs, err);
        return formatError(err);
      }
    }
  );

  server.tool(
    'forget',
    'Soft-delete outdated or incorrect memories. Requires project_id (kebab-case), which must match the owning project of the memory. Use memory_id to forget one entry, or omit it to forget all memories for the project. Add older_than_days to only forget old entries. Never hard-deletes: data can be recovered. Safe to repeat: re-forgetting an already-expired memory in the right project returns count 1 (expires_at refreshed), not 0.',
    forgetInputSchemaBase.shape,
    async (input) => {
      const startMs = Date.now();
      try {
        const result = await handleForget(input);
        logToolCall('forget', input, startMs);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logToolCall('forget', input, startMs, err);
        return formatError(err);
      }
    }
  );

  server.tool(
    'project_status',
    'Get memory counts and latest session context for a project. Call at session start to understand current state. Omit project_id to see all projects.',
    projectStatusInputSchema.shape,
    async (input) => {
      const startMs = Date.now();
      try {
        const result = await handleProjectStatus(input);
        logToolCall('project_status', input, startMs);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logToolCall('project_status', input, startMs, err);
        return formatError(err);
      }
    }
  );

  // Skill Pattern tools
  registerPatternTools(server);

  // Orchestration tools (v0.2)
  registerOrchestrationTools(server);
}

function checkStartupConfig(): void {
  const config = getConfig();
  if (config.SIMILARITY_THRESHOLD > 0.4) {
    console.error(
      `[memory-mcp] WARNING: SIMILARITY_THRESHOLD=${config.SIMILARITY_THRESHOLD} is above the documented empty-results boundary (0.4) for text-embedding-3-small. recall will silently return nothing. Check SIMILARITY_THRESHOLD/.env/EMBEDDING_MODEL coherence.`
    );
  }
}

async function startStdio(): Promise<void> {
  const server = new McpServer({ name: 'memory', version: '0.4.0' });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[memory-mcp] Running in stdio mode');
}

function startHttp(): void {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = new McpServer({ name: 'memory', version: '0.4.0' });
      registerTools(server);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const method = req.body?.method ?? (Array.isArray(req.body) ? 'batch' : '-');
      console.error(`[memory-mcp] ${new Date().toISOString()} method=${method} transport-error="${message}"`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'SSE not supported in stateless mode' });
  });

  app.delete('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'Sessions not supported in stateless mode' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.error(`[memory-mcp] Stateless HTTP server listening on port ${PORT}`);
    console.error(`[memory-mcp] MCP endpoint: http://localhost:${PORT}/mcp`);
  });
}

checkStartupConfig();

if (TRANSPORT === 'stdio') {
  startStdio();
} else {
  startHttp();
}
