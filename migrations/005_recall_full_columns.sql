-- ============================================================
-- 005_recall_full_columns.sql
-- Versions the previously out-of-band drift (commit 9a0cbc4, ~4.5
-- months ago) that changed the live `all_global_match_memories` RPC
-- without ever landing a migration file, and closes R2: recall's
-- default and extended paths gain `status`, `provenance`, `trust_score`
-- so unfiltered recall can label resolved/superseded/waived entries
-- and the RECALL_NOTICE envelope's provenance/trust_score claim
-- becomes true on every live path.
-- Prepared per architect plan rev.2 (audit e4179a72, 2026-08-15),
-- bodies captured verbatim from the LIVE pg_proc dumps of
-- `all_global_match_memories` and `match_memories_with_links_rpc`
-- (project nlvvhfwagdlfjjhouuae, dumped 2026-08-15) -- NOT from
-- README.md or migration 003, both of which were stale (no
-- min_created_at param on the base RPC).
--
-- Properties:
--   - ADDITIVE ONLY. Section 1 re-declares the existing
--     `all_global_match_memories` name via CREATE OR REPLACE with the
--     SAME return shape as the live function -- legal without DROP,
--     and makes v1 recreatable from a versioned file instead of only
--     existing as an undocumented pg_proc-only rollback target.
--     Sections 2-3 add NEW function names (`_v2` suffix); no existing
--     RPC signature used by a live caller is touched.
--   - `all_global_match_memories_hybrid` (migration 004) is untouched
--     byte-for-byte -- out of scope for this migration.
--   - All statements idempotent (CREATE OR REPLACE).
--   - Rollback block at bottom (commented), per 004 convention.
--   - PREREQUISITE: Sections 2-3 select m.status (added in migration
--     003) and m.provenance/m.trust_score (added in migration 004).
--     Apply 002, 003, and 004 before this file on a fresh database.
--
-- Drop schedule: v1 (`all_global_match_memories`) and the old
-- extended RPC (`match_memories_with_links_rpc`) are scheduled for
-- DROP by migration 006, once `all_global_match_memories_v2` /
-- `match_memories_with_links_v2` have been live 2 weeks with no
-- rollback. Criterion date: 2026-08-29. Until then both old and new
-- names coexist.
-- ============================================================

-- ============================================================
-- Section 1: CAPTURE v1 -- re-declare the LIVE all_global_match_memories
-- definition verbatim (adds no columns, no behavior change). This is
-- the 9a0cbc4 out-of-band version: it already carries the
-- `min_created_at` param that README.md:73-79 and CLAUDE.md:78 never
-- documented.
-- ============================================================

create or replace function public.all_global_match_memories(
  query_embedding vector,
  filter_project text default null::text,
  filter_type text default null::text,
  match_count integer default 5,
  threshold double precision default 0.7,
  min_created_at timestamp with time zone default null::timestamp with time zone
)
returns table (
  id uuid,
  project_id text,
  memory_type text,
  title text,
  content text,
  tags text[],
  similarity double precision,
  session_id text,
  created_at timestamp with time zone
)
language plpgsql
as $function$
begin
  return query
  select
    m.id,
    m.project_id,
    m.memory_type,
    m.title,
    m.content,
    m.tags,
    (1 - (m.embedding <=> query_embedding))::float as similarity,
    m.session_id,
    m.created_at
  from all_global_project_memory m
  where
    (m.expires_at is null or m.expires_at > now())
    and (filter_project is null or m.project_id = filter_project)
    and (filter_type is null or m.memory_type = filter_type)
    and (min_created_at is null or m.created_at >= min_created_at)
    and (1 - (m.embedding <=> query_embedding)) >= threshold
  order by m.embedding <=> query_embedding
  limit match_count;
end;
$function$;

-- ============================================================
-- Section 2: all_global_match_memories_v2 -- v1 body plus `status`,
-- `provenance`, `trust_score` in RETURNS TABLE and the SELECT list.
--
-- NOTE on threshold default: v1's default is 0.7 (the same stale
-- value src/config.ts carried before this session's fix). v2's
-- default is 0.25, matching match_memories_with_links_rpc's default
-- and the app's new SIMILARITY_THRESHOLD code default -- coherence
-- across both live recall paths, not a behavior change for existing
-- callers (the app always passes threshold explicitly).
-- ============================================================

create or replace function public.all_global_match_memories_v2(
  query_embedding vector,
  filter_project text default null::text,
  filter_type text default null::text,
  match_count integer default 5,
  threshold double precision default 0.25,
  min_created_at timestamp with time zone default null::timestamp with time zone
)
returns table (
  id uuid,
  project_id text,
  memory_type text,
  title text,
  content text,
  tags text[],
  similarity double precision,
  session_id text,
  created_at timestamp with time zone,
  status text,
  provenance text,
  trust_score real
)
language plpgsql
as $function$
begin
  return query
  select
    m.id,
    m.project_id,
    m.memory_type,
    m.title,
    m.content,
    m.tags,
    (1 - (m.embedding <=> query_embedding))::float as similarity,
    m.session_id,
    m.created_at,
    m.status,
    m.provenance,
    m.trust_score
  from all_global_project_memory m
  where
    (m.expires_at is null or m.expires_at > now())
    and (filter_project is null or m.project_id = filter_project)
    and (filter_type is null or m.memory_type = filter_type)
    and (min_created_at is null or m.created_at >= min_created_at)
    and (1 - (m.embedding <=> query_embedding)) >= threshold
  order by m.embedding <=> query_embedding
  limit match_count;
end;
$function$;

-- ============================================================
-- Section 3: match_memories_with_links_v2 -- the LIVE
-- match_memories_with_links_rpc body (matches migration 003 verbatim)
-- plus `provenance`, `trust_score` in RETURNS TABLE and in BOTH
-- phases' SELECT lists (Phase 1 direct match, Phase 2 one-hop link
-- follow). The phase-2 `0::float as similarity` quirk is kept as-is
-- (linked rows have no computed similarity to the query).
-- ============================================================

create or replace function public.match_memories_with_links_v2(
  query_embedding vector,
  filter_project text default null::text,
  filter_type text default null::text,
  filter_status text default null::text,
  match_count integer default 5,
  threshold double precision default 0.25,
  min_created_at timestamp with time zone default null::timestamp with time zone,
  follow_links boolean default false
)
returns table (
  id uuid,
  project_id text,
  memory_type text,
  title text,
  content text,
  tags text[],
  similarity double precision,
  status text,
  linked_to uuid[],
  relation text,
  session_id text,
  created_at timestamp with time zone,
  link_depth integer,
  provenance text,
  trust_score real
)
language plpgsql
stable
as $function$
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
      0 as link_depth,
      m.provenance, m.trust_score
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

  -- Phase 2: follow links (one hop) -- only if requested
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
    1 as link_depth,
    linked.provenance, linked.trust_score
  from all_global_project_memory linked
  where linked.id = any (
    select unnest(m.linked_to)
    from all_global_project_memory m
    where m.id = any (matched_ids)
  )
  and (linked.expires_at is null or linked.expires_at > now())
  and linked.id <> all (coalesce(matched_ids, '{}'::uuid[]));
end $function$;

-- ============================================================
-- Section 4: all_global_match_memories_hybrid (migration 004) --
-- NOT touched by this migration. Documented deferred item: the
-- hybrid RPC still lacks the `status` column. RECALL_HYBRID stays
-- '0' (deliberately off, per its eval flip rule); if it is ever
-- flipped on unremembered, unfiltered hybrid recall would silently
-- regress the "unfiltered recall labels closed entries" fix that
-- this migration delivers for the other two paths.
-- ============================================================

-- ============================================================
-- ROLLBACK (commented; run manually if needed):
-- drop function if exists public.match_memories_with_links_v2(vector, text, text, text, integer, double precision, timestamp with time zone, boolean);
-- drop function if exists public.all_global_match_memories_v2(vector, text, text, integer, double precision, timestamp with time zone);
-- -- Section 1 cannot be "rolled back" by DROP without also dropping the
-- -- live v1 signature callers may still depend on; if v1 itself needs to
-- -- revert to a pre-005 state, CREATE OR REPLACE it again from this
-- -- file's Section 1 body (it is now versioned, unlike before 005).
-- ============================================================

-- ============================================================
-- Post-flight smoke checks (read-only; run after applying):
-- select proname from pg_proc where proname in
--   ('all_global_match_memories', 'all_global_match_memories_v2',
--    'match_memories_with_links_v2');  -- 3 rows
-- select count(*) from all_global_project_memory;  -- unchanged
-- select id, status, provenance, trust_score
--   from all_global_match_memories_v2(
--     (select embedding from all_global_project_memory limit 1),
--     null, null, 5, 0.0, null);  -- status/provenance/trust_score columns present
-- select id, status, provenance, trust_score, link_depth
--   from match_memories_with_links_v2(
--     (select embedding from all_global_project_memory limit 1),
--     null, null, null, 5, 0.0, null, false);  -- same, extended path
-- ============================================================
