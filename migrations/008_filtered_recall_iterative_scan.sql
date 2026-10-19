-- ============================================================
-- 008_filtered_recall_iterative_scan.sql
-- Fixes silent under-return in project-filtered recall. With the HNSW
-- index, Postgres takes ef_search=40 candidates from the graph and
-- only then post-filters project_id. EXPLAIN ANALYZE 2026-10-20,
-- filter_project='n8n-pilot', match_count 5, returned 1 row
-- (Rows Removed by Filter 39): the other 4 matching rows existed but
-- were never reached.
--
-- Fix, applied to both v2 recall RPCs:
--   - Function-level `SET hnsw.iterative_scan = relaxed_order`
--     (pgvector 0.8): the index scan keeps walking the graph until
--     LIMIT rows have passed the WHERE filters.
--   - Candidates live in a MATERIALIZED CTE with an outer re-sort by
--     distance (the pgvector docs pattern for relaxed_order, which
--     does not guarantee exact order inside the scan).
--   - The similarity threshold is moved OUT of the index scan into the
--     outer query. Inside the scan, a query with fewer than
--     match_count rows above threshold would make the iterative scan
--     walk the whole graph (hnsw.max_scan_tuples default 20000 is
--     larger than the table). Result equivalence: the threshold is
--     monotone in distance, so "top-k then threshold" equals
--     "threshold then top-k".
--   - `SET plan_cache_mode = force_custom_plan`: plpgsql may switch to
--     a generic plan after 5 calls. A generic plan cannot see
--     filter_project, so it would push even tiny projects through the
--     HNSW iterative scan (full graph walk). Custom plans let the
--     planner keep using the project_id btree for small projects, as
--     it does today.
--
-- Properties:
--   - Signatures, argument defaults, return shapes, volatility and
--     threshold operators are UNCHANGED (v2 keeps `>=`, links_v2 keeps
--     `>`), so no client change is needed.
--   - CREATE OR REPLACE only. No drop, no index change, no table
--     change. Idempotent.
--   - `all_global_match_memories` (v1), `all_global_match_memories_hybrid`
--     and `match_memories_with_links_rpc` are untouched.
--   - PREREQUISITE: pgvector >= 0.8.0 (iterative scan) and migration
--     005 applied (the v2 functions exist with these signatures).
--
-- Trade-off accepted by the founder 2026-10-20 ("correct results over
-- speed"): mid-size project filters cost ~3 s cold on the current
-- 111 MB index (measured 2,986 ms).
--
-- Rollback: re-run sections 2 and 3 of
-- migrations/005_recall_full_columns.sql (the two v2 function
-- bodies). apply-008.sh also writes the pre-apply pg_get_functiondef
-- of both functions to a backup file under /tmp.
-- ============================================================

-- ============================================================
-- Section 1: all_global_match_memories_v2 -- same signature and
-- return shape as 005 section 2; adds the iterative scan settings and
-- the materialized-candidates body.
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
set hnsw.iterative_scan = 'relaxed_order'
set plan_cache_mode = 'force_custom_plan'
as $function$
begin
  return query
  with candidates as materialized (
    select
      m.id, m.project_id, m.memory_type, m.title, m.content, m.tags,
      (m.embedding <=> query_embedding) as distance,
      m.session_id, m.created_at, m.status, m.provenance, m.trust_score
    from all_global_project_memory m
    where
      (m.expires_at is null or m.expires_at > now())
      and (filter_project is null or m.project_id = filter_project)
      and (filter_type is null or m.memory_type = filter_type)
      and (min_created_at is null or m.created_at >= min_created_at)
    order by m.embedding <=> query_embedding
    limit match_count
  )
  select
    c.id, c.project_id, c.memory_type, c.title, c.content, c.tags,
    (1 - c.distance)::float as similarity,
    c.session_id, c.created_at, c.status, c.provenance, c.trust_score
  from candidates c
  where (1 - c.distance) >= threshold
  order by c.distance;
end;
$function$;

-- ============================================================
-- Section 2: match_memories_with_links_v2 -- same signature, return
-- shape and STABLE as 005 section 3; adds the iterative scan settings
-- and replaces BOTH candidate queries (phase 1 and the phase 2
-- matched_ids subquery) with the materialized-candidates pattern.
-- The phase 2 linked-rows query is unchanged.
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
set hnsw.iterative_scan = 'relaxed_order'
set plan_cache_mode = 'force_custom_plan'
as $function$
declare
  matched_ids uuid[];
begin
  -- Phase 1: regular vector match
  return query
  with candidates as materialized (
    select
      m.id, m.project_id, m.memory_type, m.title, m.content, m.tags,
      (m.embedding <=> query_embedding) as distance,
      m.status, m.linked_to, m.relation, m.session_id, m.created_at,
      m.provenance, m.trust_score
    from all_global_project_memory m
    where (m.expires_at is null or m.expires_at > now())
      and (filter_project is null or m.project_id = filter_project)
      and (filter_type is null or m.memory_type = filter_type)
      and (filter_status is null or m.status = filter_status)
      and (min_created_at is null or m.created_at >= min_created_at)
    order by m.embedding <=> query_embedding
    limit match_count
  )
  select
    c.id, c.project_id, c.memory_type, c.title, c.content, c.tags,
    1 - c.distance as similarity,
    c.status, c.linked_to, c.relation, c.session_id, c.created_at,
    0 as link_depth,
    c.provenance, c.trust_score
  from candidates c
  where 1 - c.distance > threshold
  order by c.distance;

  if not follow_links then
    return;
  end if;

  -- Phase 2: follow links (one hop) -- only if requested
  select array_agg(x.id) into matched_ids from (
    with candidates as materialized (
      select
        m.id,
        (m.embedding <=> query_embedding) as distance
      from all_global_project_memory m
      where (m.expires_at is null or m.expires_at > now())
        and (filter_project is null or m.project_id = filter_project)
        and (filter_type is null or m.memory_type = filter_type)
        and (filter_status is null or m.status = filter_status)
        and (min_created_at is null or m.created_at >= min_created_at)
      order by m.embedding <=> query_embedding
      limit match_count
    )
    select c.id
    from candidates c
    where 1 - c.distance > threshold
    order by c.distance
  ) x;

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

notify pgrst, 'reload schema';
