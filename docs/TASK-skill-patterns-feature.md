# TASK: Add Skill Patterns Feature to memory-mcp

> Priority: HIGH
> Estimated effort: 2-4 hours
> Risk level: LOW (additive only — no changes to existing code)

---

## Context

memory-mcp is a persistent vector memory MCP server for Claude Code. It currently has 4 tools: `remember`, `recall`, `forget`, `project_status`. It stores memories in Supabase PostgreSQL with pgvector (embeddings via OpenAI text-embedding-3-small, 1536 dimensions).

We are adding a NEW feature: **Skill Pattern Tracking** — 4 new tools that allow Claude Code subagents to store, search, and manage reusable work patterns discovered during sessions. These patterns accumulate over time and, when mature (seen 3+ times), can be used to generate Claude Code skills (SKILL.md files).

## ⚠️ CRITICAL SAFETY RULES

1. **DO NOT modify any existing files** unless explicitly listed in "Files to modify" section
2. **DO NOT alter** the existing table `all_global_project_memory` in any way
3. **DO NOT alter** the existing RPC function `all_global_match_memories` in any way
4. **DO NOT alter** the existing view `all_global_memory_stats` in any way
5. **DO NOT change** the existing tools: `remember`, `recall`, `forget`, `project_status`
6. **DO NOT change** `src/embedding.ts`, `src/token-counter.ts`, `src/errors.ts`, `src/config.ts` signatures — you may IMPORT from them but not modify their exports
7. **All new code goes into NEW files** — the only existing file you modify is `src/index.ts` (to register new tools)
8. **Run existing tests first** (`npm test`) and confirm they ALL pass before making any changes
9. **Run existing tests again after** all changes — they must still ALL pass
10. **If any existing test breaks — STOP immediately and revert your changes**

---

## Execution Order (FOLLOW THIS EXACTLY)

```
Phase 1: PREPARATION
  └─ Run existing tests (npm test) → confirm ALL pass
  └─ Report test results to user

Phase 2: DATABASE MIGRATION (via Supabase MCP)
  └─ Pre-flight checks (3 queries)
  └─ Report results → wait for user confirmation
  └─ Batch 1: create table → verify
  └─ Batch 2: create indexes → verify
  └─ Batch 3: create RPC functions → verify
  └─ Post-flight checks (4 queries)
  └─ Report ALL results → wait for user confirmation

Phase 3: TYPESCRIPT CODE (only after Phase 2 confirmed)
  └─ Create src/tools/pattern-store.ts
  └─ Create src/tools/pattern-search.ts
  └─ Create src/tools/pattern-mature.ts
  └─ Create src/tools/pattern-mark.ts
  └─ Create src/tools/patterns-index.ts
  └─ Modify src/index.ts (add 2 lines only)
  └─ Save migration SQL to migrations/002_skill_patterns.sql

Phase 4: TESTS
  └─ Create all 4 test files
  └─ Run ALL tests (existing + new) → confirm ALL pass
  └─ If existing tests broke → REVERT all changes immediately

Phase 5: BUILD & VERIFY
  └─ TypeScript compile check (npx tsc --noEmit)
  └─ Docker build (docker compose build memory-mcp)
  └─ Report final status to user
```

**STOP and REPORT after each Phase. Do not proceed to next Phase without user confirmation.**

---

## Database Changes (Supabase SQL)

### New table: `skill_patterns`

Save a migration file `migrations/002_skill_patterns.sql` in the repo (for documentation), containing ALL the SQL from the "Migration Execution" section below. This file is for reference only — the actual migration is executed via Supabase MCP.

### Migration Execution (Claude Code does this via Supabase MCP)

**IMPORTANT: Execute the migration FIRST, before writing any TypeScript code.**

Use the Supabase MCP tools to run the migration. Follow this exact sequence:

#### Step 1: Pre-flight checks (MANDATORY before any SQL)

Run these queries via Supabase MCP one by one and REPORT the results:

```sql
-- Check 1: Confirm skill_patterns does NOT exist yet
select exists (
  select from information_schema.tables 
  where table_name = 'skill_patterns'
);
-- EXPECTED: false
-- If true → STOP. Table already exists. Ask the user what to do.

-- Check 2: Record current memory count (safety baseline)
select count(*) as total_memories from all_global_project_memory;
-- SAVE this number. You will verify it hasn't changed after migration.

-- Check 3: Confirm existing RPC function is intact
select proname from pg_proc where proname = 'all_global_match_memories';
-- EXPECTED: one row returned
```

**If ANY check fails or returns unexpected results → STOP and report to user. Do NOT proceed.**

#### Step 2: Run migration in 3 separate batches

DO NOT run all SQL in one shot. Split into 3 batches to isolate failures:

**Batch 1 — Create table:**
```sql
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
```
→ Verify: `select count(*) from skill_patterns;` — must return 0.

**Batch 2 — Create indexes:**
```sql
create index if not exists skill_patterns_embedding_idx 
  on skill_patterns 
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists skill_patterns_category_idx 
  on skill_patterns (category);

create index if not exists skill_patterns_count_idx 
  on skill_patterns (count) where skill_created = false;

create index if not exists skill_patterns_project_idx 
  on skill_patterns (project) where project is not null;
```
→ Verify: `select indexname from pg_indexes where tablename = 'skill_patterns';` — must return 4 indexes.

**Batch 3 — Create RPC functions:**
```sql
create or replace function match_skill_patterns(
  query_embedding vector(1536),
  match_threshold float default 0.9,
  match_count int default 1,
  filter_category text default null,
  filter_project text default null
)
returns table (
  id uuid,
  pattern_id text,
  description text,
  category text,
  project text,
  examples jsonb,
  count int,
  first_seen timestamptz,
  last_seen timestamptz,
  proposed_skill boolean,
  skill_created boolean,
  similarity float
)
language sql stable
as $$
  select
    sp.id,
    sp.pattern_id,
    sp.description,
    sp.category,
    sp.project,
    sp.examples,
    sp.count,
    sp.first_seen,
    sp.last_seen,
    sp.proposed_skill,
    sp.skill_created,
    1 - (sp.embedding <=> query_embedding) as similarity
  from skill_patterns sp
  where 1 - (sp.embedding <=> query_embedding) > match_threshold
    and (filter_category is null or sp.category = filter_category)
    and (filter_project is null or sp.project = filter_project)
  order by sp.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function get_mature_patterns(
  min_count int default 3,
  filter_category text default null,
  exclude_created boolean default true
)
returns table (
  id uuid,
  pattern_id text,
  description text,
  category text,
  project text,
  examples jsonb,
  count int,
  first_seen timestamptz,
  last_seen timestamptz
)
language sql stable
as $$
  select
    sp.id,
    sp.pattern_id,
    sp.description,
    sp.category,
    sp.project,
    sp.examples,
    sp.count,
    sp.first_seen,
    sp.last_seen
  from skill_patterns sp
  where sp.count >= min_count
    and (not exclude_created or sp.skill_created = false)
    and (filter_category is null or sp.category = filter_category)
  order by sp.count desc, sp.last_seen desc;
$$;
```
→ Verify: `select proname from pg_proc where proname in ('match_skill_patterns', 'get_mature_patterns');` — must return 2 rows.

#### Step 3: Post-flight checks (MANDATORY after migration)

```sql
-- Check A: Existing memories untouched
select count(*) as total_memories from all_global_project_memory;
-- MUST match the number from Step 1 Check 2. If different → ALERT USER IMMEDIATELY.

-- Check B: Existing RPC still works
select proname from pg_proc where proname = 'all_global_match_memories';
-- MUST still return one row.

-- Check C: New table structure correct
select column_name, data_type, is_nullable 
from information_schema.columns 
where table_name = 'skill_patterns' 
order by ordinal_position;
-- MUST return 12 columns matching the schema above.

-- Check D: New RPC functions exist
select proname from pg_proc 
where proname in ('match_skill_patterns', 'get_mature_patterns');
-- MUST return 2 rows.
```

**Report ALL check results to the user before proceeding to TypeScript code.**

#### Rollback (only if something goes wrong)

If migration caused ANY issue with existing data or functions:
```sql
-- Safe rollback: only drops NEW objects
drop function if exists get_mature_patterns;
drop function if exists match_skill_patterns;
drop table if exists skill_patterns;
```
This rollback CANNOT affect existing tables/functions — it only removes what we just created.

---

## New Source Files

### File: `src/tools/pattern-store.ts`

New tool: `pattern_store` — smart upsert with automatic deduplication.

**Behavior:**
1. Accept: `description` (string), `category` (enum), `project` (string|null), `example` (string)
2. Generate embedding for `description` using existing `generateEmbedding()` from `src/embedding.ts`
3. Call Supabase RPC `match_skill_patterns` with threshold 0.9 to find similar existing patterns
4. If similar pattern found (similarity > 0.9):
   - Increment its `count`
   - Append new example to `examples` jsonb array (format: `{ "text": "...", "date": "ISO-string" }`)
   - Update `last_seen` to now
   - Set `proposed_skill = true` if new count >= 3
   - Return: `{ action: "merged", pattern_id, new_count, message }`
5. If no similar pattern found:
   - Generate `pattern_id` from description: lowercase, replace non-alphanumeric with hyphens, truncate to 60 chars
   - Insert new row with count=1
   - Return: `{ action: "created", pattern_id, count: 1, message }`

**Zod input schema:**
```typescript
{
  description: z.string().min(10).max(1000).describe("What the pattern is and when it applies"),
  category: z.enum(["n8n", "supabase", "devops", "client", "content", "code", "architecture", "other"]).describe("Pattern category"),
  project: z.string().max(100).optional().nullable().describe("Project name or null for universal patterns"),
  example: z.string().min(10).max(2000).describe("Concrete example from the current session")
}
```

**Error handling:** Use existing error classes from `src/errors.ts`. Wrap Supabase errors in `DatabaseError`, embedding errors in `EmbeddingError`. Return structured MCP error responses — never throw unhandled.

### File: `src/tools/pattern-search.ts`

New tool: `pattern_search` — semantic search across stored patterns.

**Behavior:**
1. Accept: `query` (string), `category` (string|null), `project` (string|null), `min_count` (int|null), `limit` (int, default 10)
2. Generate embedding for `query`
3. Call Supabase RPC `match_skill_patterns` with threshold 0.25 (same as recall — we want broad results)
4. Apply post-filters: `min_count`, `category`, `project`
5. Return array of matching patterns with similarity scores

### File: `src/tools/pattern-mature.ts`

New tool: `pattern_mature` — retrieve patterns ready for skill creation.

**Behavior:**
1. Accept: `min_count` (int, default 3), `category` (string|null), `exclude_created` (bool, default true)
2. Call Supabase RPC `get_mature_patterns`
3. Return grouped by category, with full examples

### File: `src/tools/pattern-mark.ts`

New tool: `pattern_mark_as_skill` — mark patterns as converted to skills.

**Behavior:**
1. Accept: `pattern_ids` (string[] — UUIDs)
2. Update `skill_created = true` for all matching IDs
3. Return count of updated records

### File: `src/tools/patterns-index.ts`

Barrel file that exports all 4 pattern tool registration functions. Each tool function should accept `(server: McpServer, supabase: SupabaseClient)` and register itself.

---

## Files to Modify

### `src/index.ts` — ONLY addition, no changes to existing code

Add at the end of the tool registration block (after existing tools are registered):

```typescript
// Skill Pattern tools
import { registerPatternTools } from './tools/patterns-index.js';
registerPatternTools(server, supabase);
```

**DO NOT change anything else in this file.** The existing tool registrations, session management, Express routes, and health endpoint must remain exactly as they are.

---

## New Test Files

### File: `tests/unit/pattern-store.test.ts`

Test cases:
- Creates new pattern when no similar exists
- Merges into existing pattern when similar found (similarity > 0.9)
- Increments count correctly on merge
- Sets proposed_skill=true when count reaches 3
- Appends example to examples array on merge
- Generates valid pattern_id from description
- Validates input with Zod (rejects missing fields, too short description, invalid category)
- Handles Supabase errors gracefully (returns MCP error, doesn't crash)
- Handles embedding errors gracefully

### File: `tests/unit/pattern-search.test.ts`

Test cases:
- Returns matching patterns sorted by similarity
- Filters by category
- Filters by project
- Filters by min_count
- Returns empty array when no matches
- Respects limit parameter

### File: `tests/unit/pattern-mature.test.ts`

Test cases:
- Returns patterns with count >= min_count
- Excludes skill_created=true when exclude_created=true
- Includes all when exclude_created=false
- Groups by category
- Returns empty when no mature patterns

### File: `tests/unit/pattern-mark.test.ts`

Test cases:
- Marks single pattern as skill_created
- Marks multiple patterns
- Returns 0 for non-existent IDs
- Handles empty array input

**Testing approach:** Mock Supabase and OpenAI the same way existing tests do. Look at existing test files for mock patterns and follow the same structure exactly.

---

## Verification Checklist

After all changes are complete, verify in this exact order:

```bash
# 1. Existing tests still pass (CRITICAL)
npm test

# 2. New tests pass
npm test -- --reporter=verbose

# 3. TypeScript compiles without errors  
npx tsc --noEmit

# 4. Docker builds successfully
docker compose build memory-mcp

# 5. Container starts and health endpoint responds
docker compose up -d memory-mcp
curl http://localhost:3101/health

# 6. Existing tools still work (manual smoke test)
# From any Claude Code session, verify:
# - remember tool works
# - recall tool works  
# - forget tool works
# - project_status tool works

# 7. New tools are visible
# From Claude Code, verify that pattern_store, pattern_search, 
# pattern_mature, pattern_mark_as_skill appear in available tools
```

---

## File Tree After Changes

```
memory-mcp/
├── src/
│   ├── index.ts                    ← MODIFIED (add import + registration)
│   ├── config.ts                   ← NOT TOUCHED
│   ├── embedding.ts                ← NOT TOUCHED  
│   ├── errors.ts                   ← NOT TOUCHED
│   ├── token-counter.ts            ← NOT TOUCHED
│   ├── tools/
│   │   ├── remember.ts             ← NOT TOUCHED
│   │   ├── recall.ts               ← NOT TOUCHED
│   │   ├── forget.ts               ← NOT TOUCHED
│   │   ├── project-status.ts       ← NOT TOUCHED
│   │   ├── patterns-index.ts       ← NEW
│   │   ├── pattern-store.ts        ← NEW
│   │   ├── pattern-search.ts       ← NEW
│   │   ├── pattern-mature.ts       ← NEW
│   │   └── pattern-mark.ts         ← NEW
├── tests/
│   └── unit/
│       ├── [existing tests]        ← NOT TOUCHED
│       ├── pattern-store.test.ts   ← NEW
│       ├── pattern-search.test.ts  ← NEW
│       ├── pattern-mature.test.ts  ← NEW
│       └── pattern-mark.test.ts    ← NEW
├── migrations/
│   └── 002_skill_patterns.sql      ← NEW
└── [all other files]               ← NOT TOUCHED
```

---

## What NOT to Do

- DO NOT rename any existing files or functions
- DO NOT add new dependencies to package.json (use existing: @supabase/supabase-js, openai, zod, @modelcontextprotocol/sdk)
- DO NOT change the Docker configuration or port
- DO NOT modify the existing Supabase schema
- DO NOT add environment variables (reuse existing SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY, EMBEDDING_MODEL)
- DO NOT change the MCP transport or session management
- DO NOT modify the existing SIMILARITY_THRESHOLD constant for pattern_search — define a separate PATTERN_SIMILARITY_THRESHOLD = 0.9 for deduplication and use the existing 0.25 for pattern_search queries
