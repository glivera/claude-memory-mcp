# Project: memory-mcp

> MCP server providing persistent vector memory for Claude Code.
> Tools: remember, recall, forget, project_status.

## ID: memory-mcp

## Tech Stack

- **Runtime:** Node.js 20 (Alpine Docker)
- **Language:** TypeScript 5.x (strict mode, ES modules)
- **MCP SDK:** @modelcontextprotocol/sdk ^1.12.1
- **Transport:** Streamable HTTP (Express 5, port 3101)
- **Database:** Supabase PostgreSQL + pgvector (cloud instance `nlvvhfwagdlfjjhouuae`)
- **Embeddings:** OpenAI text-embedding-3-small (1536 dims, direct API)
- **Testing:** Vitest (85 unit tests)

## Architecture

```
Claude Code → HTTP POST http://localhost:3101/mcp (Streamable HTTP, JSON-RPC)
                    ↓
        memory-mcp Docker container (Express + MCP SDK)
          ├── remember → OpenAI embed → Supabase insert
          ├── recall   → OpenAI embed → Supabase RPC (vector search)
          ├── forget   → Supabase update (soft-delete via expires_at)
          └── project_status → Supabase view query (no embedding)
```

- Each session gets its own McpServer + StreamableHTTPServerTransport instance
- Sessions tracked in memory by session ID (UUID)
- All persistent state in Supabase — container is stateless

## Running

```bash
# Production (always running)
docker compose up -d memory-mcp

# Dev mode (with hot reload via tsx)
docker compose up dev

# Tests
docker compose run --rm test

# Rebuild after code changes
docker compose up -d --build memory-mcp
```

## Environment (.env)

```
SUPABASE_URL          — Supabase project URL
SUPABASE_SERVICE_KEY  — service role key
OPENAI_API_KEY        — direct OpenAI API key (NOT OpenRouter)
EMBEDDING_MODEL       — default: text-embedding-3-small
SIMILARITY_THRESHOLD  — default: 0.25 (see note below)
RECALL_TOKEN_CAP      — default: 2000
DEFAULT_RECALL_LIMIT  — default: 5
MCP_PORT              — default: 3101
```

**SIMILARITY_THRESHOLD note:** text-embedding-3-small gives low cosine similarity (0.05–0.35) for general queries against technical content. Threshold above 0.4 will silently return empty results. Keep at 0.2–0.3.

## Database (DO NOT MODIFY — managed externally)

- **Table:** `all_global_project_memory` (id, project_id, memory_type, title, content, tags, embedding vector(1536), session_id, created_at, expires_at)
- **RPC:** `all_global_match_memories(query_embedding, filter_project, filter_type, match_count, threshold)` — vector similarity search, filters expired entries
- **View:** `all_global_memory_stats` — per-project stats (project_id, memory_type, count, last_updated)

All queries must filter `expires_at IS NULL OR expires_at > now()`. Never DELETE rows — only soft-delete via `expires_at = now()`.

## Project Structure

```
src/
  index.ts              — Express + MCP server, session management, tool registration
  config.ts             — Zod-validated env config
  db.ts                 — Supabase client + typed query helpers
  embedding.ts          — OpenAI embedding generation (retry once on 429/5xx)
  token-counter.ts      — Approximate token counting + truncation for recall
  errors.ts             — ValidationError, EmbeddingError, DbError
  tools/
    remember.ts         — embed title+content → insert
    recall.ts           — embed query → RPC vector search → token cap
    forget.ts           — soft-delete (by id, project, or age)
    project-status.ts   — stats view query + latest context
tests/unit/             — 85 tests (mirrors src/ structure, mocks Supabase+OpenAI)
```

## Coding Standards

- **Strict TypeScript:** no `any`, explicit types, Zod for validation
- **Error handling:** custom error classes with `cause`, tool errors → MCP error response (never crash)
- **Logging:** stderr only (console.error) — stdout not used (was stdio, now HTTP)
- **Naming:** files kebab-case, types PascalCase, functions camelCase, constants UPPER_SNAKE_CASE
- **Imports:** named only, grouped: node builtins → external → internal

## Safety Boundaries

**DO autonomously:** create/modify files in this project, build Docker images, start/stop project containers, run tests, install npm packages inside containers, git commits, fetch docs via Context7/Supabase MCP

**ASK before:** rm -rf, docker prune, modifying files outside project, git push, git reset --hard, stopping other containers, sudo, any DDL against Supabase (CREATE/ALTER/DROP)

## Known Issues

- MCP client loses session after container restart — requires Claude Code session restart
- `.env.example` still references OpenRouter (outdated, actual config uses direct OpenAI)
- Some unit tests reference `OPENROUTER_API_KEY` (outdated, should be `OPENAI_API_KEY`)
- dev and memory-mcp services both bind port 3101 — can't run simultaneously
