# Index tuning plan: all_global_project_memory (2026-10-20)

## Trigger

Hub Supabase load audit 2026-10-19 (personal instance nlvvhfwagdlfjjhouuae): INSERT 6,891 calls at 646 ms mean; all_global_match_memories 11,233 calls at 268 ms; all_global_match_memories_v2 7,273 calls at 384 ms. Diagnosis was read-only (pg_stat_statements, pg_statio, EXPLAIN ANALYZE via Management API read_only).

## Findings

1. Instance is IOPS-starved, not index-starved. Compute is the smallest tier (shared_buffers 280 MB, effective_cache_size 480 MB), DB is 7 GB, of which ss_wl_events (another project) is 5.8 GB and dominates top queries (COPY 26,185 s total; a 2 s PostgREST select x 8,957). Cold block reads in our EXPLAINs cost 1 to 2 ms each, about 500 to 600 reads/s, which matches a baseline IOPS cap. Our working set (111 MB HNSW + ~85 MB TOASTed embeddings) is evicted between calls.
2. Embedding is vector(1536) = 6,148 bytes, attstorage external, so it is TOASTed (heap 15 MB, table+toast 137 MB). Each candidate row read = heap page + ~4 toast chunks + toast index.
3. HNSW idx_agpm_embedding (m=16, ef_construction=64 defaults, 111 MB) holds ~1 element per page. Lifetime idx_blks_read 1.33 M. Insert touches ~2,300 buffers and writes ~131 KB WAL per row (neighbour-page full-page writes). No triggers on the table. No dedupe lookup on remember (pattern_store dedupe is on skill_patterns, separate).
4. CORRECTNESS BUG (silent under-return): project-scoped recall where the project is a mid-size share of the table uses the HNSW index, takes ef_search=40 candidates, then post-filters by project_id. EXPLAIN ANALYZE, filter_project='n8n-pilot', limit 5: rows=1, Rows Removed by Filter 39. With SET hnsw.iterative_scan = relaxed_order the same query returns 5 rows, but costs 2,986 ms cold (1,812 block reads) on the 111 MB index. Small projects (memory-mcp, 53 rows) take the btree project_id path and are correct; unfiltered recall is correct.
5. Unused indexes paying write cost: idx_agpm_fts_simple (19 MB GIN, 2 lifetime scans; hybrid recall gated off by RECALL_HYBRID=0) and memory_linked_to_gin_idx (0 scans).
6. v1 all_global_match_memories accounts for 11,233 calls but current src/db.ts only calls _v2; the count is probably pre-v0.4.0 history (pg_stat_statements is not time-windowed). Not verified.
7. Supabase daily logical backups (COPY ... TO stdout of this table, 68 calls, 6 to 14 s each) re-read the whole table+toast: unavoidable, but they shrink with the table footprint.

## Recommendation

- Indexes are not the root cause. Recall plus insert on this table is about 3 h of DB time over the stats window; the instance is IOPS-capped and ss_wl_events (another project, 5.8 of 7 GB) evicts everyone's working set. The first lever is that neighbour (its 2 s select x 8,957 and the COPYs) and/or a compute tier upgrade, owned by that project's session. Re-measure memory-mcp after that.
- Do NOT apply 007 alone. Bundle 007 with step 2 into one approval once step 2 SQL is written and measured; applying the index without a reader only raises insert cost.
- The under-return bug is a correctness issue and can ship on its own: function-level SET hnsw.iterative_scan = relaxed_order on the two v2 RPCs, with an outer re-sort. Cost on today's 111 MB index: about 3 s cold for mid-size project filters (measured 2,986 ms), so it trades latency for correctness until the small index exists.

## EXPLAIN before (live, 2026-10-20, v2 body inlined, real 1536 query vector)

| case | plan | rows returned | buffers hit/read | time |
|------|------|---------------|------------------|------|
| unfiltered | HNSW idx_agpm_embedding | 5/5 | 148/505 | 567 ms |
| project n8n-pilot (1,845 rows) | HNSW + post-filter | 1/5 (BUG) | 607/36 warm, 104/539 cold | 90 to 525 ms |
| project n8n-pilot + iterative_scan relaxed_order | HNSW iterative | 5/5 | 872/1,812 | 2,986 ms |
| project memory-mcp (53 rows) | btree project_id + sort | 5/5 | 426/70 | 157 ms |
| INSERT (pg_stat_statements) | heap + 8 indexes | n/a | ~2,229 hit + ~82 read per call | 646 ms mean, 13 ms min, 7.1 s max |

## EXPLAIN after (ESTIMATE, cannot be measured before the index exists)

- Unfiltered recall: today's 505 cold reads split roughly into ~300 HNSW graph pages + ~200 heap/TOAST reads for the ~40 candidates the filter rechecks. The hv512 index shrinks only the graph part (~300 -> ~50). The re-rank still detoasts the candidates, so cold total is ~250 reads, i.e. roughly 2x faster cold (about 250 to 400 ms instead of 567 ms), not 5 to 10x. Re-ranking 20 candidates (match_count*4) instead of 40 would cut the TOAST part to ~100 reads; quality must then be re-checked.
- Project-filtered with iterative scan: correct 5/5 rows; reads ~1,812 -> roughly 400 to 600.
- INSERT after step 3: HNSW buffer touches ~2,300 -> ~400, WAL per insert ~131 KB -> 25 to 40 KB. Between step 1 and step 3 INSERT is slightly WORSE.
- Warm numbers improve more than cold, but nothing guarantees the working set stays cached next to ss_wl_events.
- All of this is estimate; the step 2 gate is a measured cold EXPLAIN (BUFFERS) with reads split between index scan and re-rank.

## Plan (each step needs its own founder yes)

- Step 1 (this change, migration 007): CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agpm_embedding_hv512. Additive, no reader yet.
- Step 2 (separate migration, function DDL, not written yet): CREATE OR REPLACE all_global_match_memories_v2 and match_memories_with_links_v2 to (a) pick candidates via ORDER BY subvector(embedding,1,512)::halfvec(512) <=> subvector(q,1,512)::halfvec(512) LIMIT greatest(match_count*8, 40), with function-level SET hnsw.iterative_scan = relaxed_order and SET hnsw.ef_search = 100; (b) re-rank those candidates by the full 1536 cosine distance; (c) apply threshold and LIMIT match_count. Same signature and return shape, so no client change. Then NOTIFY pgrst, 'reload schema'. Gate: recall-eval harness shows no regression, and the EXPLAIN set above is re-run.
- Step 3 (drops, separate approval): DROP INDEX CONCURRENTLY idx_agpm_embedding (111 MB), idx_agpm_fts_simple, memory_linked_to_gin_idx. Only after step 2 has run a week with no recall complaints.
- Not proposed: re-embedding at 512 dims or changing the column type (bigger change, same benefit as the expression index); lowering ef_construction on the old index (requires rebuild+drop and keeps the 6 KB element problem).

## Audit findings (logic-auditor + devil-advocate, 2026-10-20)

- logic-auditor: no BLOCKER; 007 syntax valid; step 1 alone cannot change any existing plan (current RPCs ORDER BY embedding <=> q, not the expression). Updates that do not change embedding stay HOT-eligible.
- HIGH (step 2): keep each RPC's threshold operator (v2 uses >=, links_v2 uses >), apply it to the full 1536 distance after re-rank; links_v2 runs the candidate query twice, both copies must change or share one CTE.
- HIGH (step 2): relaxed_order returns candidates unordered; the re-rank needs an outer ORDER BY full_dist LIMIT match_count.
- MEDIUM (step 2): set hnsw.max_scan_tuples explicitly (default 20000 exceeds the table, so rare filters walk the whole graph); decide behaviour when the cap truncates.
- MEDIUM (step 2): plpgsql may switch to a generic plan after 5 calls; run the EXPLAIN set with plan_cache_mode = force_generic_plan too; consider function-level SET plan_cache_mode = force_custom_plan.
- MEDIUM (step 3): dropping idx_agpm_embedding would turn v1 all_global_match_memories, match_memories_with_links_rpc and all_global_match_memories_hybrid into full TOAST scans; dropping idx_agpm_fts_simple kills the hybrid FTS arm (env-flippable via RECALL_HYBRID). Step 3 requires first: a 48 to 72 h zero call delta for v1 and links_rpc in pg_stat_statements, shipping the overdue v1 drop, and an explicit decision on the hybrid RPC.
- MEDIUM (apply): the Management API role has a statement_timeout (read-only role: 2 min); a timeout mid-build leaves an INVALID index. The apply script checks the write role's timeout and indisvalid.
- LOW: src/db.ts insert does .select() which returns the 6 KB embedding on every insert; selecting only id/needed columns is a cheap code fix.
- Devil-advocate counters saved as memories: 62abb29e (cold estimate ignored re-rank TOAST reads, accepted, estimates revised), 3867d3ce (root cause is the neighbour table and compute tier), ec2bdea4 (step 3 breaks v1/links_rpc/hybrid, accepted as step 3 precondition), 8aa40d6c (quality evidence thin: need at least 30 queries through the real RPC with before/after, project-filtered and RU cases), b51750f8 (step 1 alone is pure cost; the under-return fix can ship independently).
- Evidence quality: the 60/60 overlap is 6 queries, exact scans, 3.6k-row pool. Step 2 gate is the recall-eval harness extended with a before/after mode, project-filtered and RU queries, at least 30 queries.

## Apply step for step 1

Run `bash bin/apply-007-hv512.sh --dry-run` first, then `bash bin/apply-007-hv512.sh`. Only after explicit founder approval relayed by the hub. Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.idx_agpm_embedding_hv512.

## What could break

- An interrupted CONCURRENTLY build leaves an INVALID index; IF NOT EXISTS then skips it on re-run (verify indisvalid).
- Build IO on an already IOPS-starved instance may slow other projects for the build duration.
- Insert cost rises slightly until step 3.
- subvector/halfvec require pgvector >= 0.7; live is 0.8.0.
