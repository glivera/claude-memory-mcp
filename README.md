# claude-memory-mcp

A persistent vector memory server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Gives Claude long-term memory across sessions — it can remember decisions, bugs, patterns, and context, then recall them semantically in future conversations. Includes a **Skill Patterns** system that tracks reusable work patterns and identifies candidates for automated skill generation.

## How It Works

```
Claude Code  ──HTTP POST──▸  memory-mcp container (Express + MCP SDK)
                                 │
                                 │  Memory Tools
                                 ├── remember        → OpenAI embed → Supabase insert
                                 ├── recall           → OpenAI embed → Supabase vector search
                                 ├── forget           → Supabase soft-delete (expires_at)
                                 ├── project_status  → Supabase stats query
                                 │
                                 │  Skill Pattern Tools
                                 ├── pattern_store          → deduplicate & store work patterns
                                 ├── pattern_search         → semantic search across patterns
                                 ├── pattern_mature         → find patterns ready for skill creation
                                 └── pattern_mark_as_skill  → mark patterns as converted to SKILL.md
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

Then run the Skill Patterns migration:

```sql
-- Skill patterns table for tracking reusable work patterns
create table if not exists skill_patterns (
  id uuid primary key default gen_random_uuid(),
  pattern_id text not null,
  description text not null,
  category text not null check (category in (
    'n8n', 'supabase', 'devops', 'client', 'content', 'code', 'architecture', 'other'
  )),
  project text,
  examples jsonb not null default '[]'::jsonb,
  count int not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  proposed_skill boolean not null default false,
  skill_created boolean not null default false,
  embedding vector(1536) not null,
  constraint skill_patterns_count_positive check (count > 0)
);

-- Indexes
create index if not exists skill_patterns_embedding_idx
  on skill_patterns using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists skill_patterns_category_idx
  on skill_patterns (category);
create index if not exists skill_patterns_count_idx
  on skill_patterns (count) where skill_created = false;
create index if not exists skill_patterns_project_idx
  on skill_patterns (project) where project is not null;

-- Semantic search for pattern deduplication
create or replace function match_skill_patterns(
  query_embedding vector(1536),
  match_threshold float default 0.9,
  match_count int default 1,
  filter_category text default null,
  filter_project text default null
)
returns table (
  id uuid, pattern_id text, description text, category text,
  project text, examples jsonb, count int, first_seen timestamptz,
  last_seen timestamptz, proposed_skill boolean, skill_created boolean,
  similarity float
)
language sql stable
as $$
  select sp.id, sp.pattern_id, sp.description, sp.category, sp.project,
    sp.examples, sp.count, sp.first_seen, sp.last_seen, sp.proposed_skill,
    sp.skill_created, 1 - (sp.embedding <=> query_embedding) as similarity
  from skill_patterns sp
  where 1 - (sp.embedding <=> query_embedding) > match_threshold
    and (filter_category is null or sp.category = filter_category)
    and (filter_project is null or sp.project = filter_project)
  order by sp.embedding <=> query_embedding
  limit match_count;
$$;

-- Get mature patterns ready for skill creation
create or replace function get_mature_patterns(
  min_count int default 3,
  filter_category text default null,
  exclude_created boolean default true
)
returns table (
  id uuid, pattern_id text, description text, category text,
  project text, examples jsonb, count int, first_seen timestamptz,
  last_seen timestamptz
)
language sql stable
as $$
  select sp.id, sp.pattern_id, sp.description, sp.category, sp.project,
    sp.examples, sp.count, sp.first_seen, sp.last_seen
  from skill_patterns sp
  where sp.count >= min_count
    and (not exclude_created or sp.skill_created = false)
    and (filter_category is null or sp.category = filter_category)
  order by sp.count desc, sp.last_seen desc;
$$;
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

---

## Skill Pattern Tools

Skill patterns track **reusable work approaches** that Claude discovers across sessions. When a pattern is seen 3+ times, it becomes a candidate for generating a Claude Code [custom slash command](https://docs.anthropic.com/en/docs/claude-code/slash-commands) (SKILL.md file).

**How it works:**
1. During work, Claude calls `pattern_store` when it notices a repeating approach
2. If a similar pattern already exists (cosine similarity > 0.9), it merges — incrementing the count and appending the new example
3. If no similar pattern exists, a new one is created
4. When a pattern reaches 3+ occurrences, it's flagged as `proposed_skill = true`
5. Use `pattern_mature` to see which patterns are ready for skill generation
6. After creating a SKILL.md file, mark the pattern with `pattern_mark_as_skill`

### `pattern_store`

Store a new pattern or merge into an existing one (automatic deduplication).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `description` | string | Yes | What the pattern is and when to apply it (10–1000 chars) |
| `category` | enum | Yes | One of: `n8n`, `supabase`, `devops`, `client`, `content`, `code`, `architecture`, `other` |
| `project` | string | No | Project name, or omit for universal patterns |
| `example` | string | Yes | Concrete example from the current session (10–2000 chars) |

**Returns:**
- `{ action: "created", pattern_id, count: 1 }` — new pattern
- `{ action: "merged", pattern_id, new_count, proposed_skill }` — merged into existing

### `pattern_search`

Semantic search across all stored patterns.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Natural language search query |
| `category` | string | No | Filter by category |
| `project` | string | No | Filter by project |
| `min_count` | number | No | Only return patterns seen at least N times |
| `limit` | number | No | Max results (1–50, default: 10) |

### `pattern_mature`

Retrieve patterns that have been seen enough times to be worth converting into skills.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `min_count` | number | No | Minimum occurrence count (default: 3) |
| `category` | string | No | Filter by category |
| `exclude_created` | boolean | No | Exclude patterns already converted to skills (default: true) |

Returns patterns grouped by category with full example history.

### `pattern_mark_as_skill`

Mark patterns as converted to SKILL.md files so they no longer appear in `pattern_mature`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pattern_ids` | string[] (UUIDs) | Yes | IDs of patterns to mark |

---

## Teaching Claude to Use Memory

Add instructions to `~/.claude/CLAUDE.md` (global) or your project's `CLAUDE.md` to tell Claude when and how to use memory. Here's a recommended configuration:

```markdown
## Memory System

You have a persistent memory MCP server with 8 tools:
- **Memory:** `remember`, `recall`, `forget`, `project_status`
- **Skill Patterns:** `pattern_store`, `pattern_search`, `pattern_mature`, `pattern_mark_as_skill`

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

### Skill Patterns (automatic)

**Store patterns when you notice repeating approaches:**
- Same debugging strategy used across projects → `pattern_store(category="code", ...)`
- Same Docker configuration pattern → `pattern_store(category="devops", ...)`
- Same Supabase migration approach → `pattern_store(category="supabase", ...)`
- Same client communication template → `pattern_store(category="client", ...)`

**Check before creating skills:**
- Call `pattern_mature()` to see patterns seen 3+ times
- Generate a SKILL.md file from the pattern's examples
- Call `pattern_mark_as_skill(pattern_ids=[...])` to mark as done

**Search existing patterns:**
- Before starting non-trivial work: `pattern_search(query=<task description>)`
- Filter by domain: `pattern_search(query="...", category="devops")`
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
    pattern-store.ts    — Smart upsert with deduplication (similarity > 0.9)
    pattern-search.ts   — Semantic search across skill patterns
    pattern-mature.ts   — Find patterns seen 3+ times (skill candidates)
    pattern-mark.ts     — Mark patterns as converted to SKILL.md
    patterns-index.ts   — Barrel: registers all 4 pattern tools
migrations/
  002_skill_patterns.sql — Skill patterns table, indexes, RPC functions
tests/unit/             — 121 unit tests (Vitest, mocks Supabase + OpenAI)
```

## License

MIT
