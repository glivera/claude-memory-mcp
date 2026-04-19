-- ============================================================================
-- Migration 003: Orchestration & Hardening Layer (v0.2)
-- Applied: 2026-04-19 via Supabase MCP as 003a/003b/003c
-- See: docs/MIGRATION-orchestration.md for fork migration guide
--
-- This file is a CONSOLIDATED documentation copy. Forks running it directly:
--   - All statements are idempotent (IF NOT EXISTS / CREATE OR REPLACE)
--   - Safe to re-run
--   - Run entire file in Supabase SQL Editor or via psql
--
-- Fully additive: no data loss, no re-embedding, no rename of existing
-- tables/columns/RPCs. Existing v0.1 tools continue working unchanged.
-- ============================================================================


-- --- Batch 1: CHECK constraint extension (SKIPPED on base schema) ---
-- Base schema (per README.md setup SQL) has no CHECK constraint on memory_type.
-- Validation lives in the Zod layer of the MCP server (src/tools/remember.ts).
-- If YOUR fork added a CHECK constraint on memory_type, extend it to include:
--   'goal', 'deviation', 'counter_argument', 'compliance_check'
-- alongside the existing 8 values (decision, bug_fix, pattern, context,
-- blocker, learning, convention, dependency). Example (run only if needed):
--   alter table all_global_project_memory drop constraint <your_constraint>;
--   alter table all_global_project_memory
--     add constraint all_global_project_memory_memory_type_check
--     check (memory_type in (
--       'decision', 'bug_fix', 'pattern', 'context', 'blocker',
--       'learning', 'convention', 'dependency',
--       'goal', 'deviation', 'counter_argument', 'compliance_check'
--     ));


-- ============================================================================
-- Batch 2: Add columns (linked_to, relation, status)
-- ============================================================================

alter table all_global_project_memory
  add column if not exists linked_to uuid[] not null default '{}';

alter table all_global_project_memory
  add column if not exists relation text;

alter table all_global_project_memory
  add column if not exists status text not null default 'open'
  check (status in ('open', 'resolved', 'waived', 'superseded'));


-- ============================================================================
-- Batch 3: Indexes (GIN + 2 partial btree)
-- ============================================================================
-- NOTE: memory_status_open_idx predicate is status='open' ONLY.
-- now() cannot appear in index WHERE (STABLE not IMMUTABLE — planner
-- refuses to match queries containing now() against frozen-at-creation
-- index time). expires_at filter is a query-time heap-access check on the
-- already-narrowed status='open' subset (~5-15% of rows).
-- ============================================================================

-- GIN index for linked_to lookups ("find all memories linked to X")
create index if not exists memory_linked_to_gin_idx
  on all_global_project_memory using gin (linked_to);

-- Partial index on status for open items (most-queried subset)
create index if not exists memory_status_open_idx
  on all_global_project_memory (project_id, memory_type, created_at desc)
  where status = 'open';

-- Partial index on memory_type for new orchestration types (hot path)
create index if not exists memory_orchestration_idx
  on all_global_project_memory (project_id, memory_type, status, created_at desc)
  where memory_type in ('goal', 'deviation', 'counter_argument', 'compliance_check');


-- ============================================================================
-- Batch 4: RPC functions (4 total)
-- 4a goal_progress_rpc       — plan completion stats per project
-- 4b compliance_trend_rpc    — compliance_check timeline
-- 4c link_memories_rpc       — atomic UPDATE...RETURNING linker (race-free)
-- 4d match_memories_with_links_rpc — vector match + optional one-hop expand
-- ============================================================================


-- --- §4a: goal_progress_rpc ---------------------------------------------------
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


-- --- §4b: compliance_trend_rpc ------------------------------------------------
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


-- --- §4c: link_memories_rpc (atomic linker — race-free) ----------------------
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


-- --- §4d: match_memories_with_links_rpc --------------------------------------
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


-- ============================================================================
-- Post-flight smoke checks (run after applying; NONE of these modify data)
-- ============================================================================
-- select count(*) from all_global_project_memory; -- baseline preserved
-- select column_name from information_schema.columns
--   where table_name='all_global_project_memory'
--     and column_name in ('linked_to','relation','status');  -- 3 rows
-- select proname from pg_proc where proname in
--   ('goal_progress_rpc','compliance_trend_rpc',
--    'link_memories_rpc','match_memories_with_links_rpc');  -- 4 rows
-- select proname from pg_proc where proname='all_global_match_memories';  -- 1 row
