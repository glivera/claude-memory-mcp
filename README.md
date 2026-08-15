# claude-memory-mcp

A persistent vector memory server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Gives Claude long-term memory across sessions — it can remember decisions, bugs, patterns, and context, then recall them semantically in future conversations. Includes a **Skill Patterns** system that tracks reusable work patterns and identifies candidates for automated skill generation.

> **✅ v0.2 Released (2026-04-19) — Orchestration & Hardening layer.** Adds an optional relationship layer (`linked_to` / `relation` / `status`), four new memory types (`goal`, `deviation`, `counter_argument`, `compliance_check`), and three new tools (`goal_progress`, `link_memories`, `compliance_trend`) for multi-agent orchestration. **Fully additive — no breaking changes, no re-embedding required.** If you're on v0.1 and want these features, apply [`migrations/003_orchestration_hardening.sql`](migrations/003_orchestration_hardening.sql) — full upgrade guide in [`docs/MIGRATION-orchestration.md`](docs/MIGRATION-orchestration.md). Existing v0.1 users can skip and continue using the 8-tool surface indefinitely.

## How It Works

```
Claude Code  ──HTTP POST──▸  memory-mcp container (Express + MCP SDK)
                                 │
                                 │  Memory Tools (v0.1)
                                 ├── remember        → OpenAI embed → Supabase insert
                                 ├── recall           → OpenAI embed → Supabase vector search
                                 ├── forget           → Supabase soft-delete (expires_at)
                                 ├── project_status  → Supabase stats query
                                 │
                                 │  Skill Pattern Tools (v0.1)
                                 ├── pattern_store          → deduplicate & store work patterns
                                 ├── pattern_search         → semantic search across patterns
                                 ├── pattern_mature         → find patterns ready for skill creation
                                 ├── pattern_mark_as_skill  → mark patterns as converted to SKILL.md
                                 │
                                 │  Orchestration Tools (v0.2, optional)
                                 ├── goal_progress     → plan completion stats for a project
                                 ├── link_memories     → atomic relation link between memories
                                 └── compliance_trend  → compliance_check entries over time
```

- **Transport:** Streamable HTTP on port 3101 (multiple Claude Code sessions share one server), stdio also supported
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

-- The vector search function this app actually calls is
-- all_global_match_memories_v2. Its canonical definition (plus the
-- captured v1 that predates versioning, per commit 9a0cbc4) lives in
-- migrations/005_recall_full_columns.sql -- apply that file rather
-- than hand-writing the RPC here, since v1's signature drifted
-- out-of-band from this README for ~4.5 months and this block is not
-- kept in sync. v2 signature:
--
-- all_global_match_memories_v2(
--   query_embedding vector,
--   filter_project text default null,
--   filter_type text default null,
--   match_count integer default 5,
--   threshold double precision default 0.25,
--   min_created_at timestamptz default null
-- ) returns table (
--   id uuid, project_id text, memory_type text, title text, content text,
--   tags text[], similarity double precision, session_id text,
--   created_at timestamptz, status text, provenance text, trust_score real
-- )

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

> **Note:** `match_skill_patterns` below has a SQL default `match_threshold` of `0.9`, but the app (`pattern-store.ts`) always passes `0.75` explicitly (empirically calibrated, see `#pattern_store` below). The SQL default is inert and never actually used.

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

**(Optional) Apply v0.2 orchestration layer.** If you want `goal`, `deviation`, `counter_argument`, and `compliance_check` memory types plus the three new tools, additionally run the migration file [`migrations/003_orchestration_hardening.sql`](migrations/003_orchestration_hardening.sql) in the Supabase SQL editor. Fully additive — safe to apply anytime, even on a populated database. Skip if you only need v0.1 functionality.

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
| `RECALL_ENVELOPE` | No | `0` or `1`. Default: `1`. When `1`, wraps `recall` results in the untrusted-data notice (see [`RECALL_NOTICE`](src/tools/recall.ts)) instead of returning a plain array. |
| `RECALL_HYBRID` | No | `0` or `1`. Default: `0`, deliberately off. Enables the FTS + vector hybrid RPC (`all_global_match_memories_hybrid`, migration 004). Stays off because it failed its eval flip rule (see `docs/TASK-recall-upgrade.md`); do not flip without re-running that eval. |
| `MCP_PORT` | No | Server port. Default: `3101` |
| `MCP_TRANSPORT` | No | `http` (default) or `stdio` |

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

The easiest way is via the CLI:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer memory-mcp-local" \
  -s user memory http://localhost:3101/mcp
```

Or manually add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "http://localhost:3101/mcp",
      "headers": {
        "Authorization": "Bearer memory-mcp-local"
      }
    }
  }
}
```

> **Important:** The `Authorization` header is required. Without it, Claude Code tries OAuth discovery, fails, and shows only an `authenticate` tool instead of the real memory tools. The token value can be anything — the server does not validate it — but the header must be present to bypass the OAuth flow.

Restart Claude Code. Verify by asking Claude: *"What MCP tools do you have?"* — you should see `remember`, `recall`, `forget`, `project_status`, and the pattern tools.

## Troubleshooting

### Claude Code shows `authenticate` instead of real tools

Claude Code's native binary probes OAuth endpoints before connecting to HTTP MCP servers. If no `Authorization` header is provided, it marks the server as "needs authentication" regardless of server response.

**Fix:** Add the `--header "Authorization: Bearer memory-mcp-local"` flag (see [Connect to Claude Code](#4-connect-to-claude-code)).

### Conflicting MCP configs

Claude Code reads MCP configs from multiple files: `~/.claude.json` and `~/.claude/.mcp.json`. If the same server name exists in both, they may conflict.

**Fix:** Keep the memory server in only one config file. Check both:
```bash
# See all MCP servers
claude mcp list
```

### recall returns empty results

`text-embedding-3-small` produces low cosine similarity (0.05–0.35) for general queries. If `SIMILARITY_THRESHOLD` is above 0.4, most queries return nothing.

**Fix:** Keep `SIMILARITY_THRESHOLD` between `0.2` and `0.3` (default: `0.25`).

### Container works but Claude Code can't connect

Verify the server is running:
```bash
curl -s http://localhost:3101/health
# {"status":"ok"}
```

If health check passes but Claude Code still can't connect, restart Claude Code (`/exit` and relaunch).

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
| `since_days` | number | No | Only return memories from the last N days (e.g., `since_days: 7` for this week) |

Returns memories ranked by semantic similarity, capped at `RECALL_TOKEN_CAP` tokens.

### `forget`

Soft-delete memories (sets `expires_at`, never hard-deletes). `project_id` is required on every call and must match the memory's owning project (ownership check), protecting against cross-project id confusion.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | kebab-case project identifier; must match the memory's owning project |
| `memory_id` | string (UUID) | No | Delete a specific memory. Omit to delete all memories for the project |
| `older_than_days` | number | No | Only expire memories older than N days |

**Examples:**

```
forget(memory_id: "550e8400-e29b-41d4-a716-446655440000", project_id: "my-project")
forget(project_id: "my-project", older_than_days: 90)
```

**Repeat-forget is safe.** Calling `forget` again on an already-expired memory in the right project always matches the row and returns `expired_count: 1` (it refreshes `expires_at`, which is harmless). This is not "count 0 for already-expired": there is no pre-read; the semantics are "the row was matched", not "the row's expiry state changed".

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
2. If a similar pattern already exists (cosine similarity > 0.75, empirically calibrated in commit 0dc52e3, 0.9 produced zero merges with text-embedding-3-small), it merges: incrementing the count and appending the new example
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

## Orchestration Tools (v0.2, optional)

These five tools become available after applying [`migrations/003_orchestration_hardening.sql`](migrations/003_orchestration_hardening.sql). They enable multi-agent orchestration — plan enforcement, decision stress-testing, compliance trends, and status closure — on top of the same unified memory table.

### `goal_progress`

Get plan completion stats for a project. Returns counts of goals (open / in-progress / completed), open deviations, and a completion percentage.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | kebab-case project identifier |
| `goal_id` | string (UUID) | No | Filter to a specific goal |

### `link_memories`

Create a semantic relation between one memory and one or more other memories. Atomic (single SQL UPDATE RETURNING — no fetch-merge race).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from_id` | string (UUID) | Yes | Memory that gets the link |
| `to_ids` | string[] (UUIDs) | Yes | Memories being linked to |
| `relation` | enum | Yes | `counters` \| `fulfills` \| `deviates_from` \| `blocks` \| `resolves` \| `supersedes` |

### `compliance_trend`

Return `compliance_check` memory entries for a project within the last N days, most recent first. Useful for surfacing repeated security findings, audit drift, or compliance rot over time.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | kebab-case project identifier |
| `since_days` | number (1-365) | No | Lookback window (default 30) |

### `update_memory_status`

Update the status of an existing memory (`open`, `resolved`, `waived`, `superseded`). Requires a `project_id` ownership match — refuses to touch a memory belonging to another project. `resolution_note` is required when closing (`resolved`, `waived`, `superseded`); it is appended to the memory's `content` as a date-stamped `[CLOSURE ...]` line and the content is re-embedded, so a later `recall` of the memory surfaces the why and when. No transition guard — last-write-wins, re-opening a closed memory is allowed. Refuses expired or not-found rows.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `memory_id` | string (UUID) | Yes | Memory to update |
| `project_id` | string | Yes | kebab-case project identifier, must match the memory's owning project |
| `status` | enum | Yes | `open` \| `resolved` \| `waived` \| `superseded` |
| `resolution_note` | string | Required for closing statuses | Appended to content with a `[CLOSURE <date> -> <status>]` prefix, then re-embedded |

### `list_memories`

Enumerate memories for a project by exact filters — no semantic search, no embedding. Use this for sweeps and counts where `recall`'s embedding-ranked top-N would miss or misrank results.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | kebab-case project identifier |
| `memory_type` | enum | No | Filter to a single memory type |
| `status` | enum | No | Filter to `open` \| `resolved` \| `waived` \| `superseded` |
| `since_days` | number | No | Only memories created within the last N days |
| `limit` | number | No | Max rows to return (default 50, max 100) |

Returns compact rows (`id`, `title`, `memory_type`, `status`, `created_at`) plus an exact total count.

### New `memory_type` values (v0.2)

The `remember` tool now accepts four additional types:
- **`goal`** — a planned outcome; use `status` to track progress (`open` → `resolved`)
- **`deviation`** — plan drift detected by an enforcer agent; typically linked via `relation=deviates_from`
- **`counter_argument`** — adversarial pushback against a decision; linked via `relation=counters`
- **`compliance_check`** — individual security/compliance audit result; queryable via `compliance_trend`

### Extended fields on `remember` / `recall` (v0.2)

- `remember` additionally accepts: `linked_to` (UUID[]), `relation` (enum), `status` (`open` | `resolved` | `waived` | `superseded`, default `open`)
- `recall` additionally accepts: `status` (filter), `follow_links` (bool), `linked_type` (string, filter linked memories by their type)

Existing callers on v0.1 signatures continue to work unchanged — all new fields default to safe values.

---

## Teaching Claude to Use Memory

Add instructions to `~/.claude/CLAUDE.md` (global) or your project's `CLAUDE.md` to tell Claude when and how to use memory. Here's a recommended configuration:

```markdown
## Memory System

You have a persistent memory MCP server with up to 13 tools:
- **Memory (v0.1):** `remember`, `recall`, `forget`, `project_status`
- **Skill Patterns (v0.1):** `pattern_store`, `pattern_search`, `pattern_mature`, `pattern_mark_as_skill`
- **Orchestration (v0.2, if migration 003 applied):** `goal_progress`, `link_memories`, `compliance_trend`, `update_memory_status`, `list_memories`

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

## Development

```bash
# Dev mode with hot reload
docker compose up dev

# Run tests (--run = run-once, non-watch)
docker compose run --rm test --run

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
    pattern-store.ts    — Smart upsert with deduplication (similarity > 0.75)
    pattern-search.ts   — Semantic search across skill patterns
    pattern-mature.ts   — Find patterns seen 3+ times (skill candidates)
    pattern-mark.ts     — Mark patterns as converted to SKILL.md
    patterns-index.ts   — Barrel: registers all 4 pattern tools
    goal-progress.ts    — Plan completion stats via goal_progress_rpc
    link-memories.ts    — Atomic relation link via link_memories_rpc
    compliance-trend.ts — compliance_check entries over N days via compliance_trend_rpc
    update-memory-status.ts — Update status, append + re-embed content on closing statuses
    list-memories.ts    — Exact-filter enumeration with count, no embedding
    orchestration-index.ts — Barrel: registers all 5 orchestration tools
migrations/
  002_skill_patterns.sql — Skill patterns table, indexes, RPC functions
tests/unit/             — 199 unit tests (Vitest, mocks Supabase + OpenAI)
```

## License

MIT
