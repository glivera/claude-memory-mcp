-- ============================================================
-- 007_hv512_hnsw_index.sql
-- Step 1 of the 2026-10-20 index tuning plan
-- (docs/PLAN-index-tuning-2026-10-20.md).
--
-- Adds a SMALL HNSW index on the first 512 dims of the existing
-- vector(1536) embedding, cast to halfvec. text-embedding-3-small is
-- Matryoshka-trained: truncation + cosine (which renormalises) is the
-- same thing the API `dimensions` param does. Measured on live data
-- 2026-10-20 (6 queries x 3.6k-row pool, exact scans): 512-dim halfvec
-- top-40 candidates re-ranked by the full 1536 distance reproduce the
-- full-vector top-10 at 60/60.
--
-- Size: the current idx_agpm_embedding stores one 6 KB element per
-- 8 KB page (111 MB for 13.8k rows), so every graph hop is a page
-- read on an IOPS-throttled instance. A 1 KB element packs ~6 per
-- page: expected ~15 to 25 MB, i.e. cache-resident.
--
-- Properties:
--   - ADDITIVE ONLY. No drop, no column change, no function change.
--     Nothing reads this index until step 2 (RPC rewrite) ships, so
--     recall plans are unchanged by this file alone.
--   - COST UNTIL STEP 3: every INSERT/UPDATE of embedding maintains
--     this index as well as idx_agpm_embedding (expected +10 to 20%
--     insert work until the 111 MB index is dropped in step 3).
--   - CONCURRENTLY cannot run inside a transaction block: send this
--     file as ONE statement, not wrapped in BEGIN/COMMIT, and not
--     batched with other statements in the same request.
--   - IF NOT EXISTS: a re-run is a no-op. If a CONCURRENTLY build is
--     interrupted it leaves an INVALID index with this name, and IF
--     NOT EXISTS will then skip it: check pg_index.indisvalid after
--     apply (verify query at the bottom) and, if false, drop it and
--     re-run (that drop needs its own approval).
--   - Build runs with maintenance_work_mem = 32 MB (instance default);
--     the graph may not fit and pgvector will log a NOTICE and finish
--     slower. Expected minutes, not hours, at 13.8k rows.
--   - Touches ONLY public.all_global_project_memory (memory-mcp's
--     own table on the shared personal instance nlvvhfwagdlfjjhouuae).
--
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS
--   public.idx_agpm_embedding_hv512;  (no reader depends on it yet)
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agpm_embedding_hv512
  ON public.all_global_project_memory
  USING hnsw ((subvector(embedding, 1, 512)::halfvec(512)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Verify after apply (read-only, run separately):
-- select c.relname, i.indisvalid, i.indisready,
--        pg_size_pretty(pg_relation_size(c.oid)) as size
-- from pg_index i join pg_class c on c.oid = i.indexrelid
-- where c.relname = 'idx_agpm_embedding_hv512';
