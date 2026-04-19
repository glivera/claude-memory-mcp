# TASK: Orchestration & Hardening Layer (Lv.4-5 support)

> Priority: HIGH
> Estimated effort: 6-10 hours
> Risk level: MEDIUM (additive schema + new tools, extends `remember`/`recall` signatures)

---

## Context

memory-mcp currently supports 8 tools across 2 tables:
- `all_global_project_memory` — general knowledge (decisions, bugs, patterns, etc.)
- `skill_patterns` — reusable work patterns

To support Lv.4 Orchestration (plan enforcement, deviation logging, goal tracking) and Lv.5 Hardening (devil's advocate, compliance checks, multi-agent security), the memory layer needs:
1. **4 new `memory_type` values**: `goal`, `deviation`, `counter_argument`, `compliance_check`
2. **Relationship layer**: `linked_to`, `relation`, `status` columns on `all_global_project_memory`
3. **3 new MCP tools**: `goal_progress`, `link_memories`, `compliance_trend`
4. **2 extended tools**: `remember` (accepts new fields), `recall` (filters + follow links)

Downstream consumers (to be built later in separate tasks, NOT part of this one):
- Architect `_templates/agents/plan-enforcer.md` — reads `goal` entries, logs `deviation` entries
- Architect `_templates/agents/devil-advocate.md` — writes `counter_argument` entries linked to decisions
- Architect `_templates/agents/security-auditor.md` — writes `compliance_check` entries per commit

## ⚠️ CRITICAL SAFETY RULES

1. **DO NOT modify** `src/embedding.ts`, `src/token-counter.ts`, `src/errors.ts`, `src/config.ts` signatures (import only)
2. **DO NOT alter** the `skill_patterns` table, its RPC functions, or `pattern-*.ts` tools
3. **DO NOT break** existing `remember` / `recall` behavior — new fields are OPTIONAL with safe defaults
4. **DO NOT change** the project_id regex or memory_type enum ordering — only EXTEND
5. **Run existing tests first** (`npm test`) → ALL 125 must pass before any change
6. **Run all tests again after** — they must still ALL pass, PLUS new tests added here
7. **If any existing test breaks — STOP, revert, report**
8. **All DB changes go through Supabase MCP** with pre-flight checks + batched execution
9. **Backward compat:** existing memories (without `linked_to`/`relation`/`status`) must still be recallable without error
10. **Downstream communication:** this server is open-source (GitHub). Forks rely on stable behavior. Treat `docs/MIGRATION-orchestration.md` as the canonical user-facing contract — keep it in sync with the actual implementation. If any of this task's steps force a real breaking change, STOP and consult the user before proceeding.

## Backward-Compat Audit (against v0.1 base schema — README.md setup SQL)

| Surface | v0.1 contract | v0.2 change | Risk |
|---------|---------------|-------------|------|
| `memory_type` column | Plain `text`, no CHECK constraint | Zod-level extension only; DB unchanged unless fork added a CHECK | None if base schema; Batch 1 handles forks with custom constraint |
| Data rows | 10-column shape | 3 new columns with defaults backfill existing rows | None — additive |
| `all_global_match_memories` RPC | Signature + behavior fixed | Not touched | None |
| `all_global_memory_stats` view | Exists | Not touched | None |
| `remember` input | 7 fields | +3 optional fields with defaults | None |
| `remember` response | 5 fields | +3 fields (status/linked_to/relation) | Strict Zod `.strict()` on client would reject unknown keys. Rare — documented in MIGRATION.md |
| `recall` input | 5 fields | +3 optional fields | None |
| `recall` response rows | 8 fields per row | +3 fields + optional `link_depth` when follow_links=true | Same strict-parse edge case |
| `forget` / `project_status` | Unchanged | Unchanged | None |
| `pattern_*` tools | Unchanged | Unchanged | None |
| Embedding model / dimensions | `text-embedding-3-small`, 1536d | Unchanged | None — no re-embed |
| Existing indexes | Unchanged | Unchanged; 3 new indexes added | None |

**Conclusion:** migration is purely additive. Only theoretical break is consumer code doing `.strict()` parse on tool responses — called out in `MIGRATION-orchestration.md` FAQ.

**TS-level safeguard:** declare `linked_to`, `relation`, `status` as OPTIONAL on the `MemoryRow`/`MatchResult` interfaces (not required) so downstream TypeScript consumers building rows manually don't get a compile break:

```ts
linked_to?: string[];
relation?: string | null;
status?: string;
```

Populate them from DB reads when present; omit when a fork speaks v0.1 schema.

---

## Execution Order (FOLLOW EXACTLY)

```
Phase 1: PREPARATION
  └─ npm test → confirm 125 tests pass
  └─ Report baseline

Phase 2: DATABASE MIGRATION (via Supabase MCP)
  └─ Pre-flight checks (4 queries)
  └─ Batch 1: extend memory_type constraint (if any)
  └─ Batch 2: add columns (linked_to, relation, status)
  └─ Batch 3: add indexes
  └─ Batch 4: new RPC functions (goal_progress_rpc, compliance_trend_rpc, link_memories_rpc, match_memories_with_links_rpc)
  └─ Post-flight checks
  └─ Save migrations/003_orchestration_hardening.sql
  └─ WAIT for user confirmation before Phase 3

Phase 3: TYPESCRIPT — DB layer
  └─ Extend src/db.ts: MemoryRow interface + new helpers (linkMemories, goalProgress, complianceTrend, matchMemoriesWithLinks)

Phase 4: TYPESCRIPT — extend existing tools
  └─ Modify src/tools/remember.ts (add linked_to, relation, status)
  └─ Modify src/tools/recall.ts (add follow_links, status, linked_type)
  └─ Add new MEMORY_TYPES entries
  └─ Keep existing behavior unchanged when new params absent

Phase 5: TYPESCRIPT — new tools
  └─ Create src/tools/goal-progress.ts
  └─ Create src/tools/link-memories.ts
  └─ Create src/tools/compliance-trend.ts
  └─ Create src/tools/orchestration-index.ts (barrel)
  └─ Modify src/index.ts (register 3 new tools)

Phase 6: TESTS
  └─ Update tests for remember.ts / recall.ts (new params)
  └─ Create tests for 3 new tools (~30 new tests expected)
  └─ Run ALL tests → must ALL pass

Phase 7: BUILD & VERIFY
  └─ npx tsc --noEmit
  └─ docker compose build memory-mcp
  └─ docker compose up -d memory-mcp
  └─ Smoke test via curl against /mcp
  └─ Report final status
```

**STOP and REPORT after each Phase. Do not auto-proceed.**

---

## Database Changes (Supabase SQL)

### Pre-flight checks (MANDATORY)

Run via Supabase MCP, report results:

```sql
-- Check 1: confirm table exists and its current columns
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'all_global_project_memory'
order by ordinal_position;
-- EXPECTED: columns id, project_id, memory_type, title, content, tags, embedding, session_id, created_at, expires_at
-- NONE of: linked_to, relation, status (these are what we add)

-- Check 2: current check constraint on memory_type (if any)
select con.conname, pg_get_constraintdef(con.oid)
from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
where rel.relname = 'all_global_project_memory'
  and con.contype = 'c';
-- SAVE result: constraint name + definition. If there's an enum check, we need to drop+recreate.

-- Check 3: safety baseline
select count(*) as total from all_global_project_memory;
-- SAVE this number.

-- Check 4: confirm existing RPC is intact
select proname, pronargs from pg_proc where proname = 'all_global_match_memories';
-- EXPECTED: one row
```

**If Check 1 shows any of `linked_to`/`relation`/`status` columns already exist → STOP, ask user.**

### Batch 1 — Extend memory_type constraint (if exists)

If Check 2 showed a CHECK constraint enumerating memory_type values, drop and recreate it. Otherwise skip.

```sql
-- Example template (adjust constraint name from Check 2):
alter table all_global_project_memory drop constraint if exists <constraint_name>;

alter table all_global_project_memory
  add constraint all_global_project_memory_memory_type_check
  check (memory_type in (
    'decision', 'bug_fix', 'pattern', 'context', 'blocker',
    'learning', 'convention', 'dependency',
    'goal', 'deviation', 'counter_argument', 'compliance_check'
  ));
```

If there was no CHECK constraint (free-form text column), skip this batch — validation stays in the Zod layer only.

### Batch 2 — Add columns

```sql
alter table all_global_project_memory
  add column if not exists linked_to uuid[] not null default '{}';

alter table all_global_project_memory
  add column if not exists relation text;

alter table all_global_project_memory
  add column if not exists status text not null default 'open'
  check (status in ('open', 'resolved', 'waived', 'superseded'));
```

Verify: `select linked_to, relation, status from all_global_project_memory limit 1;` — must succeed.

Verify baseline unchanged: `select count(*) from all_global_project_memory;` — must equal Check 3 number.

### Batch 3 — Indexes

```sql
-- GIN index for linked_to lookups ("find all memories linked to X")
create index if not exists memory_linked_to_gin_idx
  on all_global_project_memory using gin (linked_to);

-- Partial index on status for open items (most-queried subset)
-- NOTE: Predicate is status='open' only — NO now() comparison.
-- now() is STABLE not IMMUTABLE; PostgreSQL either rejects it in CREATE INDEX
-- or accepts with a frozen-time artifact that prevents planner from using
-- the index for queries containing `expires_at > now()` (index-time now()
-- ≠ query-time now()). Keeping predicate IMMUTABLE preserves planner usage.
-- The expires_at filter in queries becomes a heap-access check, which is
-- cheap since status='open' already narrows to ~5-15% of rows.
create index if not exists memory_status_open_idx
  on all_global_project_memory (project_id, memory_type, created_at desc)
  where status = 'open';

-- Partial index on memory_type for new orchestration types (hot path)
create index if not exists memory_orchestration_idx
  on all_global_project_memory (project_id, memory_type, status, created_at desc)
  where memory_type in ('goal', 'deviation', 'counter_argument', 'compliance_check');
```

Verify: 3 new indexes listed in `pg_indexes where tablename = 'all_global_project_memory'`.

### Batch 4 — RPC functions

#### 4a. `goal_progress_rpc`

```sql
create or replace function goal_progress_rpc(
  filter_project text,
  filter_goal_id uuid default null
)
returns jsonb
language plpgsql
stable
as $$
declare
  result jsonb;
begin
  with goals as (
    select id, status
    from all_global_project_memory
    where project_id = filter_project
      and memory_type = 'goal'
      and (expires_at is null or expires_at > now())
      and (filter_goal_id is null or id = filter_goal_id)
  ),
  deviations as (
    select count(*) as cnt
    from all_global_project_memory dev
    where dev.project_id = filter_project
      and dev.memory_type = 'deviation'
      and dev.status = 'open'
      and (dev.expires_at is null or dev.expires_at > now())
      and (
        filter_goal_id is null
        or filter_goal_id = any (dev.linked_to)
      )
  ),
  blockers as (
    select count(*) as cnt
    from all_global_project_memory blk
    where blk.project_id = filter_project
      and blk.memory_type = 'blocker'
      and blk.status = 'open'
      and (blk.expires_at is null or blk.expires_at > now())
  )
  select jsonb_build_object(
    'total_goals', (select count(*) from goals),
    'completed',   (select count(*) from goals where status = 'resolved'),
    'in_progress', (select count(*) from goals where status = 'open'),
    'waived',      (select count(*) from goals where status = 'waived'),
    'deviations_open', (select cnt from deviations),
    'blockers_open',   (select cnt from blockers),
    'completion_pct', case
      when (select count(*) from goals) = 0 then 0
      else round(100.0 * (select count(*) from goals where status = 'resolved') / (select count(*) from goals))
    end
  ) into result;
  return result;
end $$;
```

Test: `select goal_progress_rpc('nonexistent-project');` → expect all zeros.

#### 4b. `compliance_trend_rpc`

```sql
create or replace function compliance_trend_rpc(
  filter_project text,
  filter_since_days int default 30
)
returns table (
  id uuid,
  title text,
  status text,
  tags text[],
  created_at timestamptz,
  linked_to uuid[]
)
language sql
stable
as $$
  select id, title, status, tags, created_at, linked_to
  from all_global_project_memory
  where project_id = filter_project
    and memory_type = 'compliance_check'
    and created_at >= now() - make_interval(days => filter_since_days)
    and (expires_at is null or expires_at > now())
  order by created_at desc;
$$;
```

Test: `select * from compliance_trend_rpc('nonexistent-project', 30);` → empty result.

#### 4c. `link_memories_rpc` (atomic linker — no TS-level race)

```sql
create or replace function link_memories_rpc(
  from_id uuid,
  to_ids uuid[],
  relation_value text default null
)
returns table (
  id uuid,
  linked_to uuid[],
  relation text
)
language sql
as $$
  update all_global_project_memory m
  set
    linked_to = (
      select array_agg(distinct x)
      from unnest(m.linked_to || coalesce(to_ids, '{}'::uuid[])) as x
    ),
    relation = coalesce(relation_value, m.relation)
  where m.id = from_id
    and (m.expires_at is null or m.expires_at > now())
  returning m.id, m.linked_to, m.relation;
$$;
```

Test: `select * from link_memories_rpc('00000000-0000-0000-0000-000000000000'::uuid, array[gen_random_uuid()], 'counters');` → empty result (no matching row), no error.

Rationale: single `UPDATE ... RETURNING` is atomic at the row level. Two concurrent `link_memories` calls both succeed and merge — no TOCTOU gap.

#### 4d. `match_memories_with_links_rpc`

Extends existing match behavior with optional follow-links in a single round-trip.

```sql
create or replace function match_memories_with_links_rpc(
  query_embedding vector(1536),
  filter_project text default null,
  filter_type text default null,
  filter_status text default null,
  match_count int default 5,
  threshold float default 0.25,
  min_created_at timestamptz default null,
  follow_links boolean default false
)
returns table (
  id uuid,
  project_id text,
  memory_type text,
  title text,
  content text,
  tags text[],
  similarity float,
  status text,
  linked_to uuid[],
  relation text,
  session_id text,
  created_at timestamptz,
  link_depth int
)
language plpgsql
stable
as $$
declare
  matched_ids uuid[];
begin
  -- Phase 1: regular vector match
  return query
  with direct as (
    select
      m.id, m.project_id, m.memory_type, m.title, m.content, m.tags,
      1 - (m.embedding <=> query_embedding) as similarity,
      m.status, m.linked_to, m.relation, m.session_id, m.created_at,
      0 as link_depth
    from all_global_project_memory m
    where (m.expires_at is null or m.expires_at > now())
      and (filter_project is null or m.project_id = filter_project)
      and (filter_type is null or m.memory_type = filter_type)
      and (filter_status is null or m.status = filter_status)
      and (min_created_at is null or m.created_at >= min_created_at)
      and 1 - (m.embedding <=> query_embedding) > threshold
    order by m.embedding <=> query_embedding
    limit match_count
  )
  select * from direct;

  if not follow_links then
    return;
  end if;

  -- Phase 2: follow links (one hop) — only if requested
  select array_agg(d.id) into matched_ids from (
    select m.id
    from all_global_project_memory m
    where (m.expires_at is null or m.expires_at > now())
      and (filter_project is null or m.project_id = filter_project)
      and (filter_type is null or m.memory_type = filter_type)
      and (filter_status is null or m.status = filter_status)
      and (min_created_at is null or m.created_at >= min_created_at)
      and 1 - (m.embedding <=> query_embedding) > threshold
    order by m.embedding <=> query_embedding
    limit match_count
  ) d;

  return query
  select
    linked.id, linked.project_id, linked.memory_type, linked.title, linked.content, linked.tags,
    0::float as similarity,
    linked.status, linked.linked_to, linked.relation, linked.session_id, linked.created_at,
    1 as link_depth
  from all_global_project_memory linked
  where linked.id = any (
    select unnest(m.linked_to)
    from all_global_project_memory m
    where m.id = any (matched_ids)
  )
  and (linked.expires_at is null or linked.expires_at > now())
  and linked.id <> all (coalesce(matched_ids, '{}'::uuid[]));
end $$;
```

Test: `select * from match_memories_with_links_rpc(array_fill(0::real, array[1536])::vector, 'architect', null, null, 3, 0.0, null, false);` — should return up to 3 rows without error.

### Post-flight checks

```sql
-- 1. Row count: delta analysis, not strict equality
select count(*) as total from all_global_project_memory;
-- Rule:
--   delta < 0 (row loss)  → HARD ROLLBACK immediately, forensic
--   delta == 0            → ✅ clean, no concurrent writes
--   delta > 0 (row gain)  → FORENSIC on newest rows (select the latest
--                           <delta> rows, confirm all are legitimate
--                           concurrent writes from other sessions with
--                           correct DEFAULTs on new columns — if yes,
--                           update live baseline; if no, escalate)
-- Spirit: data integrity, not count stability. CREATE INDEX / ALTER TABLE
-- ADD COLUMN cannot insert rows; a positive delta during migration window
-- always traces to external sessions writing via existing tools.

-- 2. All new columns present with expected defaults
select linked_to, relation, status
from all_global_project_memory
limit 1;
-- linked_to = {}, status = 'open', relation = null

-- 3. All 4 RPCs callable
select proname from pg_proc
where proname in ('goal_progress_rpc', 'compliance_trend_rpc', 'link_memories_rpc', 'match_memories_with_links_rpc');
-- EXPECTED: 4 rows

-- 4. Existing RPC untouched
select proname from pg_proc where proname = 'all_global_match_memories';
-- EXPECTED: 1 row
```

Save migration under `migrations/003_orchestration_hardening.sql` with all 4 batches + comments.

---

## TypeScript Changes

### `src/db.ts` — Extend types + helpers

Update `MemoryRow` and `MatchResult` interfaces:

```ts
export interface MemoryRow {
  id: string;
  project_id: string;
  memory_type: string;
  title: string;
  content: string;
  tags: string[];
  embedding?: number[];
  session_id: string | null;
  created_at: string;
  expires_at: string | null;
  linked_to: string[];      // NEW — uuid[] → string[]
  relation: string | null;  // NEW
  status: string;           // NEW — default 'open'
}

export interface MatchResult {
  id: string;
  project_id: string;
  memory_type: string;
  title: string;
  content: string;
  tags: string[];
  similarity: number;
  session_id: string | null;
  created_at: string;
  status: string;           // NEW
  linked_to: string[];      // NEW
  relation: string | null;  // NEW
  link_depth?: number;      // NEW — 0 for direct match, 1 for followed link
}
```

Add helpers:

```ts
export interface GoalProgress {
  total_goals: number;
  completed: number;
  in_progress: number;
  waived: number;
  deviations_open: number;
  blockers_open: number;
  completion_pct: number;
}

export interface ComplianceCheckRow {
  id: string;
  title: string;
  status: string;
  tags: string[];
  created_at: string;
  linked_to: string[];
}

export async function getGoalProgress(
  projectId: string,
  goalId?: string
): Promise<GoalProgress> { /* rpc call */ }

export async function getComplianceTrend(
  projectId: string,
  sinceDays: number
): Promise<ComplianceCheckRow[]> { /* rpc call */ }

export async function matchMemoriesWithLinks(
  queryEmbedding: number[],
  filterProject: string | null,
  filterType: string | null,
  filterStatus: string | null,
  matchCount: number,
  threshold: number,
  minCreatedAt: string | null,
  followLinks: boolean
): Promise<MatchResult[]> { /* rpc call */ }

export async function linkMemoriesAtomic(
  fromId: string,
  toIds: string[],
  relation: string | null
): Promise<{ id: string; linked_to: string[]; relation: string | null }> {
  // Calls link_memories_rpc — atomic UPDATE RETURNING, no read-then-write race
  const db = getSupabaseClient();
  const { data, error } = await db.rpc('link_memories_rpc', {
    from_id: fromId,
    to_ids: toIds,
    relation_value: relation,
  });
  if (error) throw new DbError(`link_memories_rpc failed: ${error.message}`, { cause: error });
  const row = (data ?? [])[0];
  if (!row) throw new ValidationError(`Memory ${fromId} not found or expired`);
  return row;
}

export async function updateStatus(
  memoryId: string,
  status: 'open' | 'resolved' | 'waived' | 'superseded'
): Promise<MemoryRow> { /* update status */ }
```

Atomicity note: `linkMemoriesAtomic` wraps the `link_memories_rpc` UPDATE…RETURNING described in §4c. Dedupe happens inside SQL (`array_agg(distinct unnest(m.linked_to || to_ids))`), so no TS-side fetch→merge→update is required — eliminates the read-then-write race a PostgREST-level `array_cat` approach would introduce.

### `src/tools/remember.ts` — Extend schema

```ts
const MEMORY_TYPES = [
  'decision', 'bug_fix', 'pattern', 'context',
  'blocker', 'learning', 'convention', 'dependency',
  'goal', 'deviation', 'counter_argument', 'compliance_check',
] as const;

const RELATIONS = [
  'counters', 'fulfills', 'deviates_from', 'blocks', 'resolves', 'supersedes',
] as const;

const STATUSES = ['open', 'resolved', 'waived', 'superseded'] as const;

export const rememberInputSchema = z.object({
  project_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  memory_type: z.enum(MEMORY_TYPES),
  title: z.string().max(120),
  content: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  expires_in_days: z.number().positive().optional(),
  session_id: z.string().optional(),
  // NEW fields (all optional, backward compatible)
  linked_to: z.array(z.string().uuid()).optional().default([]),
  relation: z.enum(RELATIONS).optional(),
  status: z.enum(STATUSES).optional().default('open'),
});
```

Pass new fields to `insertMemory`. Existing callers omit them → defaults kick in. No behavior change.

### `src/tools/recall.ts` — Extend schema + RPC choice

```ts
export const recallInputSchema = z.object({
  query: z.string().min(1),
  project_id: z.string().optional(),
  memory_type: z.string().optional(),
  limit: z.number().min(1).max(20).optional(),
  since_days: z.number().positive().optional(),
  // NEW fields
  status: z.enum(['open', 'resolved', 'waived', 'superseded']).optional(),
  follow_links: z.boolean().optional().default(false),
  linked_type: z.string().optional(), // filter to only return links of this memory_type
});
```

When `follow_links=true` OR `status` is set → call `matchMemoriesWithLinks`. Otherwise call existing `matchMemories` (backward compatible).

When `follow_links=true`, response entries include `link_depth` field (0 direct, 1 via link).

When `linked_type` is set, post-filter the link entries (link_depth=1) to only include those with matching memory_type.

### New tool: `src/tools/goal-progress.ts`

```ts
import { z } from 'zod';
import { getGoalProgress } from '../db.js';
import { ValidationError } from '../errors.js';

export const goalProgressInputSchema = z.object({
  project_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  goal_id: z.string().uuid().optional(),
});

export type GoalProgressInput = z.infer<typeof goalProgressInputSchema>;

export async function handleGoalProgress(input: GoalProgressInput) {
  const parsed = goalProgressInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(/* ... */);
  }
  return getGoalProgress(parsed.data.project_id, parsed.data.goal_id);
}
```

MCP tool registration:
- `name`: `goal_progress`
- `description`: "Get plan completion stats for a project: total goals, completed, in-progress, deviations_open, blockers_open, completion_pct. Optionally filter by goal_id."

### New tool: `src/tools/link-memories.ts`

```ts
export const linkMemoriesInputSchema = z.object({
  from_id: z.string().uuid(),
  to_ids: z.array(z.string().uuid()).min(1),
  relation: z.enum([
    'counters', 'fulfills', 'deviates_from', 'blocks', 'resolves', 'supersedes',
  ]).optional(),
});

export async function handleLinkMemories(input: LinkMemoriesInput) {
  // 1. Validate Zod schema
  // 2. Call linkMemoriesAtomic — single RPC round-trip, atomic UPDATE RETURNING
  // 3. Return { id, linked_to, relation }
  // NOTE: Atomicity is enforced at the DB level via link_memories_rpc.
  // No read-then-write in TS — eliminates race window.
}
```

MCP registration:
- `name`: `link_memories`
- `description`: "Link an existing memory to one or more other memories (post-hoc relationship). Used when a decision is later countered, a goal is fulfilled, or a deviation resolves a plan item."

### New tool: `src/tools/compliance-trend.ts`

```ts
export const complianceTrendInputSchema = z.object({
  project_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  since_days: z.number().positive().max(365).optional().default(30),
});

export async function handleComplianceTrend(input: ComplianceTrendInput) {
  const parsed = complianceTrendInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(/* ... */);
  }
  return getComplianceTrend(parsed.data.project_id, parsed.data.since_days);
}
```

MCP registration:
- `name`: `compliance_trend`
- `description`: "Return all compliance_check memories for a project within the last N days (default 30), most recent first. Used to see GO/NO-GO trend over time."

### `src/tools/orchestration-index.ts` (barrel)

```ts
export { handleGoalProgress, goalProgressInputSchema } from './goal-progress.js';
export { handleLinkMemories, linkMemoriesInputSchema } from './link-memories.js';
export { handleComplianceTrend, complianceTrendInputSchema } from './compliance-trend.js';
```

### `src/index.ts` — Register 3 new tools

Import from barrel, call `server.registerTool` in the same style as existing tools. Follow existing naming/description conventions.

---

## Tests

Expected new test files (mirror existing structure):

```
tests/unit/tools/
  remember.test.ts        — UPDATE: add cases for new fields + defaults
  recall.test.ts          — UPDATE: add cases for follow_links + status filter
  goal-progress.test.ts   — NEW: 8-10 tests (happy path, empty, invalid project_id, with goal_id)
  link-memories.test.ts   — NEW: 8-10 tests (add, dedupe, multiple, invalid uuid, nonexistent)
  compliance-trend.test.ts — NEW: 8-10 tests (happy path, empty, since_days clamping)
```

All tests mock Supabase + OpenAI same as existing patterns in the repo.

**Success criterion:** all pre-existing 125 tests pass + ~30 new tests pass. Total ~155.

---

## Smoke test after Docker rebuild

```bash
# 1. Confirm container healthy
curl -s http://localhost:3101/mcp -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
# EXPECTED: 11 tools (8 existing + 3 new): remember, recall, forget, project_status,
#           pattern_store, pattern_search, pattern_mature, pattern_mark_as_skill,
#           goal_progress, link_memories, compliance_trend

# 2. Save a goal, check progress
# (use remember + goal_progress via MCP)

# 3. Save a decision + counter_argument linked to it, recall with follow_links
```

---

## Rollback plan

If anything breaks after Phase 2 (DB migration):
```sql
-- Columns are ADDITIVE with defaults — safe to keep even if TS changes revert.
-- If truly needed:
alter table all_global_project_memory drop column if exists linked_to;
alter table all_global_project_memory drop column if exists relation;
alter table all_global_project_memory drop column if exists status;
drop function if exists goal_progress_rpc(text, uuid);
drop function if exists compliance_trend_rpc(text, int);
drop function if exists link_memories_rpc(uuid, uuid[], text);
drop function if exists match_memories_with_links_rpc(vector, text, text, text, int, float, timestamptz, boolean);
-- Then re-add old memory_type CHECK constraint if one existed.
```

TS changes: `git revert` the Phase 3-5 commits. Existing tools keep working since they don't reference new columns.

---

## Done criteria (all must hold)

- [ ] Phase 1: baseline 125 tests pass
- [ ] Phase 2: DB migration executed, post-flight checks pass, migration file saved
- [ ] Phase 3-5: all TS compiles (`npx tsc --noEmit` clean), all 11 tools registered in `src/index.ts`
- [ ] Phase 6: all tests pass (existing + new, ~155 total)
- [ ] Phase 7: docker container rebuilt, healthy, `tools/list` returns 11 entries
- [ ] Backward compat: a `remember` call without new fields behaves identically to pre-change behavior
- [ ] Backward compat: a `recall` call without `follow_links`/`status` behaves identically
- [ ] No changes to `skill_patterns` table or pattern-* tools
- [ ] `docs/TASK-orchestration-hardening.md` (this file) moved to `docs/DONE/` or marked complete at top
- [ ] Session summary saved via `remember(memory_type="context", project_id="memory-mcp", ...)`
