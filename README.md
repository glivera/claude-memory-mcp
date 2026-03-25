# claude-memory-mcp

A persistent vector memory server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Gives Claude long-term memory across sessions — it can remember decisions, bugs, patterns, and context, then recall them semantically in future conversations.

## How It Works

```
Claude Code  ──HTTP POST──▸  memory-mcp container (Express + MCP SDK)
                                 │
                                 ├── remember  → OpenAI embed → Supabase insert
                                 ├── recall    → OpenAI embed → Supabase vector search
                                 ├── forget    → Supabase soft-delete (expires_at)
                                 └── project_status → Supabase stats query
```

- **Transport:** Streamable HTTP on port 3101 (multiple Claude Code sessions share one server)
- **Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions)
- **Storage:** Supabase PostgreSQL + pgvector
- **Runtime:** Node.js 20 in Docker (Alpine)

## Prerequisites

- Docker & Docker Compose
- A [Supabase](https://supabase.com/) project (free tier works)
- An [OpenAI API key](https://platform.openai.com/api-keys) (for embeddings only, not chat)

## Setup

### 1. Set Up Supabase Database

Run the following SQL in your Supabase SQL editor (**Dashboard > SQL Editor > New query**):

```sql
-- Enable pgvector extension
create extension if not exists vector;

-- Create the memories table
create table all_global_project_memory (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  memory_type text not null,
  title text not null,
  content text not null,
  tags text[] default '{}',
  embedding vector(1536),
  session_id text,
  created_at timestamptz default now(),
  expires_at timestamptz
);

-- Create index for vector similarity search
create index on all_global_project_memory
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Create index for project_id filtering
create index on all_global_project_memory (project_id);

-- Create the vector search function
create or replace function all_global_match_memories(
  query_embedding vector(1536),
  filter_project text default null,
  filter_type text default null,
  match_count int default 5,
  threshold float default 0.25
)
returns table (
  id uuid,
  project_id text,
  memory_type text,
  title text,
  content text,
  tags text[],
  similarity float,
  session_id text,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
    select
      m.id,
      m.project_id,
      m.memory_type,
      m.title,
      m.content,
      m.tags,
      1 - (m.embedding <=> query_embedding) as similarity,
      m.session_id,
      m.created_at
    from all_global_project_memory m
    where (m.expires_at is null or m.expires_at > now())
      and (filter_project is null or m.project_id = filter_project)
      and (filter_type is null or m.memory_type = filter_type)
      and 1 - (m.embedding <=> query_embedding) > threshold
    order by m.embedding <=> query_embedding
    limit match_count;
end;
$$;

-- Create stats view
create or replace view all_global_memory_stats as
  select
    project_id,
    memory_type,
    count(*)::int as count,
    max(created_at)::text as last_updated
  from all_global_project_memory
  where expires_at is null or expires_at > now()
  group by project_id, memory_type;
```

### 2. Clone and Configure

```bash
git clone https://github.com/glivera/claude-memory-mcp.git
cd claude-memory-mcp

cp .env.example .env
```

Edit `.env` with your credentials:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...your-service-role-key
OPENAI_API_KEY=sk-...your-openai-key
EMBEDDING_MODEL=text-embedding-3-small
SIMILARITY_THRESHOLD=0.25
RECALL_TOKEN_CAP=2000
DEFAULT_RECALL_LIMIT=5
MCP_PORT=3101
```

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key (not anon key) |
| `OPENAI_API_KEY` | Yes | OpenAI API key for embeddings |
| `EMBEDDING_MODEL` | No | Default: `text-embedding-3-small` |
| `SIMILARITY_THRESHOLD` | No | Default: `0.25` (keep between 0.2–0.3, see [note](#similarity-threshold)) |
| `RECALL_TOKEN_CAP` | No | Max tokens returned by recall. Default: `2000` |
| `DEFAULT_RECALL_LIMIT` | No | Max memories per recall. Default: `5` |
| `MCP_PORT` | No | Server port. Default: `3101` |

### 3. Build and Run

```bash
docker compose up -d memory-mcp
```

Verify it's running:

```bash
curl -s http://localhost:3101/health
# {"status":"ok","sessions":0}
```

### 4. Connect to Claude Code

Add the MCP server to your Claude Code configuration. Edit (or create) `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "type": "streamable-http",
      "url": "http://localhost:3101/mcp"
    }
  }
}
```

Restart Claude Code. You should see the memory tools available — verify by asking Claude: *"What MCP tools do you have?"*

## Tools

### `remember`

Save a memory with automatic embedding generation.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Kebab-case project identifier (e.g., `my-app`) |
| `memory_type` | enum | Yes | One of: `decision`, `bug_fix`, `pattern`, `context`, `blocker`, `learning`, `convention`, `dependency` |
| `title` | string | Yes | Short title (max 120 chars), used for search |
| `content` | string | Yes | Full memory content |
| `tags` | string[] | No | Tags for filtering |
| `expires_in_days` | number | No | Auto-expire after N days |

### `recall`

Semantic search across memories using vector similarity.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Natural language search query |
| `project_id` | string | No | Filter to specific project (omit for cross-project search) |
| `memory_type` | string | No | Filter by memory type |
| `limit` | number | No | Max results (1–20, default: 5) |

Returns memories ranked by semantic similarity, capped at `RECALL_TOKEN_CAP` tokens.

### `forget`

Soft-delete memories (sets `expires_at`, never hard-deletes).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `memory_id` | string (UUID) | No* | Delete a specific memory |
| `project_id` | string | No* | Delete all memories for a project |
| `older_than_days` | number | No | Only expire memories older than N days (requires `project_id`) |

\* At least one of `memory_id` or `project_id` is required.

### `project_status`

Get memory counts and latest context per project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | No | Filter to specific project (omit for all projects) |

## Teaching Claude to Use Memory

Add instructions to `~/.claude/CLAUDE.md` (global) or your project's `CLAUDE.md` to tell Claude when and how to use memory. Here's a recommended configuration:

```markdown
## Memory System

You have a persistent memory MCP server with 4 tools: `remember`, `recall`, `forget`, `project_status`.

### Determining project_id

Derive project_id from the current working directory name, converted to kebab-case.
Example: `/home/user/projects/My Cool App` -> `my-cool-app`

### Session Start (before any coding)

1. Call `project_status(project_id=<current>)` — get memory counts
2. Call `recall(query=<user's task>, project_id=<current>)` — project memories
3. Call `recall(query=<user's task>)` — cross-project search
4. Summarize relevant findings

### During Work (automatically)

**Remember after:**
- Architectural decision -> `memory_type: "decision"`
- Bug fixed -> `memory_type: "bug_fix"`
- Reusable pattern discovered -> `memory_type: "pattern"`
- Blocker or limitation hit -> `memory_type: "blocker"`
- Something unexpected learned -> `memory_type: "learning"`
- New convention established -> `memory_type: "convention"`
- Dependency added/changed -> `memory_type: "dependency"`

**Recall before:**
- Any non-trivial implementation — search related decisions and bugs
- Using an API or integration — search related patterns
- Setting up a new feature — search conventions

### Session End (before finishing)

Save a session summary:
`remember(project_id=<current>, memory_type="context", title="Session summary YYYY-MM-DD", content=<what was done, what's next, blockers>, tags=["session-summary"])`

### Cross-Project Knowledge

Save reusable knowledge without `project_id`:
`remember(memory_type="pattern", title="...", content="...", tags=["cross-project", ...])`
```

## Similarity Threshold

`text-embedding-3-small` produces low cosine similarity scores (typically 0.05–0.35) for general queries against technical content. Setting the threshold above 0.4 will cause most queries to return empty results. The default of `0.25` works well for most use cases. Adjust down to `0.2` if you're getting too few results, or up to `0.3` if you're getting too much noise.

## Development

```bash
# Dev mode with hot reload
docker compose up dev

# Run tests
docker compose run --rm test

# Rebuild production image after changes
docker compose up -d --build memory-mcp
```

## Project Structure

```
src/
  index.ts              — Express server, MCP session management, tool registration
  config.ts             — Zod-validated environment config
  db.ts                 — Supabase client + typed query helpers
  embedding.ts          — OpenAI embedding generation (retry on 429/5xx)
  token-counter.ts      — Token counting + truncation for recall responses
  errors.ts             — Custom error classes (ValidationError, EmbeddingError, DbError)
  tools/
    remember.ts         — Embed title+content -> insert into Supabase
    recall.ts           — Embed query -> vector search -> token-capped response
    forget.ts           — Soft-delete by ID, project, or age
    project-status.ts   — Stats view query + latest context
tests/unit/             — Unit tests (Vitest, mocks Supabase + OpenAI)
```

## License

MIT
