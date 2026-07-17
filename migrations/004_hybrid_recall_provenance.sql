-- ============================================================
-- 004_hybrid_recall_provenance.sql
-- R6 hybrid retrieval (BM25-flavored FTS + pgvector, RRF fusion)
-- + R2 step 1 provenance columns.
-- Prepared per docs/TASK-recall-upgrade.md (architect plan rev.2, 2026-07-18).
--
-- Properties:
--   - ADDITIVE ONLY. No existing RPC signature is touched (avoids the
--     CREATE OR REPLACE overload trap -- see memory 62ae5f51).
--   - All statements idempotent (IF NOT EXISTS / CREATE OR REPLACE on a
--     NEW function name).
--   - No table rewrite: provenance/trust_score are NULLABLE with no DB
--     default (catalog-only add; NULL = pre-migration/unknown, honestly
--     distinguishable from asserted values). FTS is a functional
--     expression index, NOT a stored generated column.
--   - 'simple' text-search config, not 'english': the corpus is mixed
--     RU/EN; the English stemmer degenerates on Cyrillic.
--   - Rollback block at bottom (commented). NEW convention as of 004;
--     003 and earlier have no rollback blocks.
-- ============================================================

-- 1. Provenance columns (nullable, no default -- app code always writes
--    concrete values for new rows; NULL means "written before 004").
alter table all_global_project_memory
  add column if not exists provenance text
    check (provenance in ('user_authored', 'agent_inferred', 'recalled_external'));

alter table all_global_project_memory
  add column if not exists trust_score real
    check (trust_score >= 0 and trust_score <= 1);

comment on column all_global_project_memory.provenance is
  'Origin of the memory content. NULL = written before migration 004 (unknown). Never backfilled -- guessing history would mislabel it.';
comment on column all_global_project_memory.trust_score is
  '0..1. App-computed: 0.5 default for recalled_external, 1.0 otherwise. NULL = pre-004.';

-- 2. FTS functional index ('simple' config; expression MUST match the
--    RPC below verbatim for the index to be used).
create index if not exists idx_agpm_fts_simple
  on all_global_project_memory
  using gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '')));

-- 3. Hybrid RRF function. NEW name -- existing all_global_match_memories
--    and match_memories_with_links_rpc are untouched.
--    RRF uses FLOAT literals (1.0/(60+rank)); integer 1/(60+rank)
--    truncates to 0 for every row and silently kills ranking.
create or replace function all_global_match_memories_hybrid(
  query_embedding vector(1536),
  query_text text,
  filter_project text default null,
  filter_type text default null,
  match_count int default 5,
  threshold float default 0.25,
  min_created_at timestamptz default null
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
  created_at timestamptz,
  provenance text,
  trust_score real,
  rrf_score float
)
language plpgsql
as $$
declare
  q tsquery;
begin
  q := websearch_to_tsquery('simple', coalesce(query_text, ''));
  return query
  with base as (
    select m.id, m.embedding, m.title, m.content
    from all_global_project_memory m
    where (m.expires_at is null or m.expires_at > now())
      and (filter_project is null or m.project_id = filter_project)
      and (filter_type is null or m.memory_type = filter_type)
      and (min_created_at is null or m.created_at >= min_created_at)
  ),
  vec as (
    select b.id,
           (1 - (b.embedding <=> query_embedding))::float as sim,
           row_number() over (order by b.embedding <=> query_embedding) as vrank
    from base b
    where (1 - (b.embedding <=> query_embedding)) >= threshold
    order by b.embedding <=> query_embedding
    limit 40
  ),
  fts as (
    select b.id,
           row_number() over (
             order by ts_rank_cd(
               to_tsvector('simple', coalesce(b.title, '') || ' ' || coalesce(b.content, '')), q
             ) desc
           ) as frank
    from base b
    where numnode(q) > 0
      and to_tsvector('simple', coalesce(b.title, '') || ' ' || coalesce(b.content, '')) @@ q
    limit 40
  ),
  fused as (
    select coalesce(v.id, f.id) as fid,
           coalesce(1.0 / (60 + v.vrank), 0) + coalesce(1.0 / (60 + f.frank), 0) as rrf,
           v.sim as vsim
    from vec v
    full outer join fts f on v.id = f.id
  )
  select m.id, m.project_id, m.memory_type, m.title, m.content, m.tags,
         coalesce(fu.vsim, 0)::float as similarity,
         m.session_id, m.created_at, m.provenance, m.trust_score,
         fu.rrf::float as rrf_score
  from fused fu
  join all_global_project_memory m on m.id = fu.fid
  order by fu.rrf desc
  limit match_count;
end;
$$;

-- ============================================================
-- Post-flight smoke checks (read-only; run after applying):
-- select count(*) from all_global_project_memory;  -- unchanged (7027 at prep time)
-- select indexname from pg_indexes where indexname = 'idx_agpm_fts_simple';  -- 1 row
-- select proname from pg_proc where proname = 'all_global_match_memories_hybrid';  -- 1 row
-- RRF non-zero smoke (BLOCKER guard -- scores must be distinct and > 0):
-- select title, rrf_score from all_global_match_memories_hybrid(
--   (select embedding from all_global_project_memory limit 1),
--   'doppler cron keyring', null, null, 5, 0.0, null);
-- ============================================================

-- ============================================================
-- ROLLBACK (commented; additive migration -- run manually if needed):
-- drop function if exists all_global_match_memories_hybrid(vector(1536), text, text, text, int, float, timestamptz);
-- drop index if exists idx_agpm_fts_simple;
-- alter table all_global_project_memory drop column if exists trust_score;
-- alter table all_global_project_memory drop column if exists provenance;
-- ============================================================
