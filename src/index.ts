import { randomUUID } from 'node:crypto';
import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { rememberInputSchema, handleRemember } from './tools/remember.js';
import { recallInputSchema, handleRecall } from './tools/recall.js';
import { forgetInputSchemaBase, handleForget } from './tools/forget.js';
import { projectStatusInputSchema, handleProjectStatus } from './tools/project-status.js';
import { ValidationError, EmbeddingError, DbError } from './errors.js';
import { registerPatternTools } from './tools/patterns-index.js';

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
    'Save a memory entry with auto-generated embedding for semantic search',
    rememberInputSchema.shape,
    async (input) => {
      try {
        const result = await handleRemember(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  server.tool(
    'recall',
    'Semantic search over memories using vector similarity',
    recallInputSchema.shape,
    async (input) => {
      try {
        const results = await handleRecall(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  server.tool(
    'forget',
    'Soft-delete memories by setting expires_at (never hard-deletes)',
    forgetInputSchemaBase.shape,
    async (input) => {
      try {
        const result = await handleForget(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  server.tool(
    'project_status',
    'Return project overview and memory stats (no embedding generated)',
    projectStatusInputSchema.shape,
    async (input) => {
      try {
        const result = await handleProjectStatus(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Skill Pattern tools
  registerPatternTools(server);
}

const app = express();
app.use(express.json());

// Track active sessions
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', sessions: Object.keys(transports).length });
});

// POST /mcp — handle MCP requests
app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  // New session — check if it's an initialize request
  const body = req.body;
  const isInit = body && typeof body === 'object' && body.method === 'initialize';

  if (isInit) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports[id] = transport;
        console.error(`[memory-mcp] Session initialized: ${id} (total: ${Object.keys(transports).length})`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.error(`[memory-mcp] Session closed: ${transport.sessionId} (total: ${Object.keys(transports).length})`);
      }
    };

    const server = new McpServer({ name: 'memory', version: '0.1.0' });
    registerTools(server);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Invalid or missing session. Send an initialize request first.' },
    id: null,
  });
});

// GET /mcp — SSE stream for server-to-client notifications
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).json({ error: 'Invalid or missing session' });
  }
});

// DELETE /mcp — close session
app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).json({ error: 'Invalid or missing session' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.error(`[memory-mcp] HTTP server listening on port ${PORT}`);
  console.error(`[memory-mcp] MCP endpoint: http://localhost:${PORT}/mcp`);
});
