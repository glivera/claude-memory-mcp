# Migration Guide — Orchestration & Hardening Layer

> **Scope:** memory-mcp v0.1.x → v0.2.x
> **Breaking changes:** None intentional (additive schema + tool signatures)
> **Required action for existing users:** Optional — see [Do I need to migrate?](#do-i-need-to-migrate)

---

## TL;DR

- **Your existing data is safe.** No rows touched, no embeddings regenerated, no columns dropped or renamed.
- **Your existing tools keep working unchanged.** `remember`, `recall`, `forget`, `project_status`, and all four `pattern_*` tools have the same behavior as v0.1.
- **This is an opt-in upgrade.** If you only use Claude Code's memory layer as-is, you can skip this migration indefinitely and stay on v0.1 with zero functional loss.
- **Upgrade when you need:** multi-agent orchestration, plan enforcement, devil's-advocate review, compliance tracking, or cross-memory relationships.

---

## Why this upgrade exists

The v0.1 server treats every memory as an island: a flat list of decisions, bugs, and patterns. That model works well for single-agent sessions — recall a bug fix, remember a convention — but it falls short the moment you build **multi-agent systems that need to reason about each other's work**.

Three concrete gaps in v0.1:

1. **No goal tracking.** You can save a plan as `memory_type: "context"`, but there's no way to ask *"how much of the plan is done?"* or *"which plan items are still open?"*.
2. **No relationships between memories.** A devil's-advocate agent writes a critique. A week later, you recall the decision it critiques — but the critique doesn't surface, because nothing links them.
3. **No lifecycle states.** A blocker becomes resolved. A deviation gets waived. A compliance check flips from NO-GO to GO. In v0.1, all of this hides in free-form content, undiscoverable by query.

The v0.2 changes close these three gaps with the smallest possible surface area: four new `memory_type` values, three new optional columns, three new tools. Everything else stays identical.

**Design constraint we committed to:** any v0.1 caller must continue to work without modification. We chose schema extension over new tables specifically to preserve the unified recall model — one query, one embedding search, all relevant context.

---

## What's new at a glance

### Four new `memory_type` values

| Type | Purpose |
|------|---------|
| `goal` | A plan item with acceptance criteria. Plan-enforcer agents read these. |
| `deviation` | Append-only log of when actual work diverged from a goal. |
| `counter_argument` | Output from a devil's-advocate agent, linked to the decision it critiques. |
| `compliance_check` | GO / NO-GO gate result per commit or deploy. |

### Three new columns on `all_global_project_memory`

| Column | Type | Purpose |
|--------|------|---------|
| `linked_to` | `uuid[]` (default `{}`) | IDs of related memories. A `deviation` points to its `goal`; a `counter_argument` points to its `decision`. |
| `relation` | `text` (nullable) | Semantic of the link: `counters`, `fulfills`, `deviates_from`, `blocks`, `resolves`, `supersedes`. |
| `status` | `text` (default `open`) | Lifecycle state: `open`, `resolved`, `waived`, `superseded`. Applies to goals, deviations, blockers, compliance_checks. |

### Four new RPC functions

- `goal_progress_rpc(project, goal_id?)` — returns `{ total_goals, completed, in_progress, deviations_open, completion_pct, ... }`.
- `compliance_trend_rpc(project, since_days)` — returns compliance_check rows over time.
- `link_memories_rpc(from_id, to_ids, relation?)` — atomic `UPDATE ... RETURNING` that merges new IDs into `linked_to` and sets `relation`. No read-then-write race.
- `match_memories_with_links_rpc(...)` — same as `all_global_match_memories` but can follow `linked_to` one hop in a single query.

### Three new MCP tools

| Tool | Use case |
|------|----------|
| `goal_progress` | "How much of the plan is done?" — called by orchestration dashboards. |
| `link_memories` | "This decision was countered by memory X" — post-hoc relationship setup. |
| `compliance_trend` | "Show all GO/NO-GO gate results for last 30 days" — for security auditors. |

### Extended existing tools (optional params only)

- `remember` — accepts `linked_to`, `relation`, `status` (all optional).
- `recall` — accepts `follow_links`, `status`, `linked_type` (all optional).

**Omit the new params → behavior is byte-identical to v0.1.**

---

## Breaking changes?

**None intentional.** Here's the full audit against v0.1:

| Area | v0.1 behavior | v0.2 behavior | Breaking? |
|------|---------------|---------------|-----------|
| Existing rows in `all_global_project_memory` | Stored as-is | Stored as-is, gain default values for 3 new columns | ❌ No |
| `memory_type` accepted values (DB) | No CHECK constraint → any text | Same — new enum lives only in Zod validation layer (Batch 1 of the migration is a no-op unless your fork added a constraint) | ❌ No |
| `all_global_match_memories` RPC | Unchanged signature and behavior | Unchanged signature and behavior | ❌ No |
| `all_global_memory_stats` view | Unchanged | Unchanged | ❌ No |
| Existing indexes | Unchanged | Unchanged | ❌ No |
| `remember({ project_id, memory_type, title, content })` | Inserts row | Inserts row with `linked_to=[]`, `status='open'`, `relation=null` defaults | ❌ No (response has 3 extra fields — see below) |
| `recall({ query })` | Vector match on active memories | Same — `follow_links` defaults to `false` | ❌ No (response rows have 3 extra fields) |
| `forget`, `project_status`, `pattern_*` tools | Unchanged | Unchanged | ❌ No |
| Response shape (`remember`, `recall`) | `{id, title, content, tags, similarity, ...}` | Same fields, **plus** `status`, `linked_to`, `relation` | ⚠️ Additive only |
| Embedding column and model | `text-embedding-3-small`, 1536d | Unchanged — no re-embed needed | ❌ No |

**The one edge case** where you might see impact: if your client-side code does strict schema validation on tool responses (e.g., Zod with `.strict()` forbidding unknown keys), the extra fields will fail validation. Standard MCP clients and JSON consumers ignore unknown fields. If you're unsure, run a test query after migration.

---

## Do I need to migrate?

Answer this: **Do you build multi-agent workflows where agents reason about each other's output?**

| Your situation | Recommendation |
|----------------|----------------|
| You use memory-mcp only as Claude Code's long-term memory for a single session at a time | **Skip the migration.** v0.1 covers you fully. |
| You save plans as "context" memories and manually track progress | **Optional.** Migrate if you want `goal_progress` stats. |
| You build custom sub-agents that orchestrate work or critique decisions | **Recommended.** The relationship layer + `link_memories` closes a real gap. |
| You need compliance / security audit trails per commit | **Required.** `compliance_check` + `compliance_trend` tool is the reason it exists. |

There's no deadline, no deprecation path, no forced upgrade. v0.1 will continue to work against a v0.2-migrated database (it just ignores the new columns).

---

## Migration steps for self-hosted forks

### 0. Prerequisites check

- You're running memory-mcp v0.1.x (check `package.json → version`).
- You have backup access to your Supabase database.
- Your Claude Code sessions are idle (or you're OK with a brief restart).

### 1. Backup (recommended, not required)

The migration is additive, but belt-and-suspenders:

```bash
# From Supabase Dashboard → Database → Backups, or via CLI:
pg_dump "$SUPABASE_CONNECTION_STRING" \
  --table=all_global_project_memory \
  --data-only \
  --file=memory-backup-$(date +%F).sql
```

### 2. Pull the new code

```bash
cd memory-mcp
git fetch origin
git checkout v0.2.0    # or the tag you're adopting
npm install            # if any new deps landed
```

### 3. Run the database migration

Open Supabase SQL Editor (or your preferred SQL runner) and execute:

```
migrations/003_orchestration_hardening.sql
```

The file is split into 4 batches. Run them one at a time and watch for errors. Each batch is idempotent (`if not exists` / `create or replace`). Safe to re-run.

**What this does:**
- Adds 3 columns to `all_global_project_memory` with defaults.
- Creates 3 new indexes on the same table (GIN on `linked_to`, partial on `status`, partial on new memory types).
- Creates 4 new RPC functions (`goal_progress_rpc`, `compliance_trend_rpc`, `link_memories_rpc`, `match_memories_with_links_rpc`).
- Leaves existing table rows, RPC, view, and indexes **untouched**.

**What it does NOT do:**
- Does NOT re-embed your memories.
- Does NOT delete or modify any existing row.
- Does NOT rename any column or function.

### 4. Rebuild the Docker container

```bash
docker compose up -d --build memory-mcp
```

The new server image registers 11 tools instead of 8. Multiple concurrent Claude Code sessions will each get a fresh MCP server instance on next connect.

### 5. Verify

```bash
# 11 tools listed
curl -s http://localhost:3101/mcp \
  -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq '.result.tools[].name'

# Expected output:
# "remember"
# "recall"
# "forget"
# "project_status"
# "pattern_store"
# "pattern_search"
# "pattern_mature"
# "pattern_mark_as_skill"
# "goal_progress"       ← new
# "link_memories"       ← new
# "compliance_trend"    ← new
```

### 6. Smoke test against an existing project

In a Claude Code session:

```
recall({ query: "anything you remember saving before", project_id: "your-project" })
```

Existing memories should return as before, now with extra fields (`status: "open"`, `linked_to: []`, `relation: null`). If an old memory comes back without those fields somehow, you hit a defaults-propagation edge case — file an issue.

---

## Rollback plan

If something goes wrong **after migration** but **before adopting new features**, rollback is safe and fast.

### Option A: revert server image, keep schema

```bash
cd memory-mcp
git checkout v0.1.x    # previous tag
docker compose up -d --build memory-mcp
```

The v0.1 server ignores the new columns — your data keeps the `linked_to`/`relation`/`status` columns but the server doesn't use them. No data loss.

### Option B: full schema rollback

Only if you want to return the database to exact v0.1 shape:

```sql
-- Drop new functions
drop function if exists goal_progress_rpc(text, uuid);
drop function if exists compliance_trend_rpc(text, int);
drop function if exists link_memories_rpc(uuid, uuid[], text);
drop function if exists match_memories_with_links_rpc(vector, text, text, text, int, float, timestamptz, boolean);

-- Drop new indexes
drop index if exists memory_linked_to_gin_idx;
drop index if exists memory_status_open_idx;
drop index if exists memory_orchestration_idx;

-- Drop new columns (safe — your data in original columns is untouched)
alter table all_global_project_memory drop column if exists linked_to;
alter table all_global_project_memory drop column if exists relation;
alter table all_global_project_memory drop column if exists status;
```

Rows in original columns (`id`, `project_id`, `memory_type`, `title`, `content`, `tags`, `embedding`, `session_id`, `created_at`, `expires_at`) are untouched by any of the above.

---

## FAQ

**Q: Will I need to regenerate embeddings?**
No. The `embedding` column is not touched. Same model (`text-embedding-3-small`), same 1536 dimensions, same `<=>` operator.

**Q: Can v0.1 and v0.2 servers run against the same database simultaneously?**
Yes. v0.1 tolerates the new columns (it ignores them). v0.2 tolerates v0.1-shaped rows (they get default values). Useful for blue/green deploys across a multi-container setup.

**Q: Are the new tools usable from Claude Desktop without server changes?**
No — they only exist inside the rebuilt server. Claude Desktop / Claude Code pick them up automatically on next connect once the container is rebuilt.

**Q: Does this affect query performance?**
Marginally, in both directions. Two new partial indexes add small write overhead on `INSERT` (≤1ms). The `match_memories_with_links_rpc` path with `follow_links=true` does an additional round-trip — only activated when you pass the flag. Default `recall` behavior is unchanged.

**Q: Does the upgrade reset my `skill_patterns` table?**
No. The `skill_patterns` table, its RPCs (`match_skill_patterns`, `get_mature_patterns`), and its tools (`pattern_store`, `pattern_search`, `pattern_mature`, `pattern_mark_as_skill`) are explicitly out of scope for this migration.

**Q: What if I already have a memory I want to retroactively link to another?**
Use `link_memories({ from_id, to_ids, relation })`. It's designed exactly for post-hoc relationship setup.

**Q: Why not use a separate `relationships` table instead of an array column?**
Because the primary query pattern is "recall memories semantically, then expand to their neighbors." Array columns + GIN index handle this in one query. A separate table forces two queries per recall.

**Q: I'm stuck on an older SDK version. Will that cause issues?**
The migration only depends on `@modelcontextprotocol/sdk ^1.12.1`, PostgreSQL + pgvector, and Node 20. Nothing moves.

---

## Versioning policy

We move the minor version (`0.1 → 0.2`) when:
- New tools are added (strict additive).
- Schema is extended (additive only, no drops or renames).
- Response shapes gain fields (never lose).

We move the major version (`0.x → 1.0`) only for genuinely breaking changes (tool rename, required field on existing tool, schema migration that mutates data).

---

## Getting help

If anything in this guide is ambiguous, the migration misbehaves, or you spot a real breaking change we missed:

- Open an issue with the label `migration-v0.2`
- Include: your Supabase Postgres version, memory-mcp commit SHA you're on, error output, and the migration batch that failed

---

**Last updated:** 2026-04-19 (initial publication)
