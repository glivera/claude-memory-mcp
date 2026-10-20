# migrations

SQL applied by hand to the shared personal Supabase instance nlvvhfwagdlfjjhouuae. Only memory-mcp's own tables and functions live here (all_global_project_memory, skill_patterns and their RPCs). Some files are documentation copies of changes first run through the Supabase MCP.

## Files

| File | Purpose | Apply status |
|------|---------|--------------|
| 002_skill_patterns.sql | Creates skill_patterns table, ivfflat embedding index and the pattern RPCs (match_skill_patterns, get_mature_patterns). | Applied |
| 003_orchestration_hardening.sql | Adds linked_to/relation/status columns, new memory types, and the orchestration RPCs (goal_progress_rpc, compliance_trend_rpc, link_memories_rpc, match_memories_with_links_rpc). Idempotent consolidated copy. | Applied (2026-04-19) |
| 004_hybrid_recall_provenance.sql | Adds nullable provenance/trust_score columns, a functional FTS index ('simple' config, mixed RU/EN) and the new hybrid RPC (RRF fusion). Has a commented rollback block. | Applied |
| 005_recall_full_columns.sql | Versions the previously out-of-band live all_global_match_memories body and adds the _v2 recall RPCs (all_global_match_memories_v2, match_memories_with_links_v2) returning status/provenance/trust_score. | Applied. Its header planned a v1 drop as "006" by 2026-08-29; that 006 was never written, so v1 all_global_match_memories and match_memories_with_links_rpc still exist live. |
| 007_hv512_hnsw_index.sql | Small HNSW index on the first 512 dims as halfvec (Matryoshka truncation) to make graph hops cache-resident. | NOT APPLIED, SHELVED 2026-10-20 (warm recall 2.5 to 7 ms after the ss_wl_events cleanup, latency is network; dead without the step 2 RPC rewrite), see docs/PLAN-index-tuning-2026-10-20.md for how to resume. Apply only via bin/apply-007-hv512.sh, which aborts while the API role statement_timeout is 2min. |
| 008_filtered_recall_iterative_scan.sql | Replaces the bodies of both v2 recall RPCs so project-filtered recall uses hnsw.iterative_scan = relaxed_order and returns the full match_count instead of silently under-returning. | Applied 2026-10-20 (run apply008-20261019T214618Z, smoke 6/6). Backup of old function bodies: /tmp/apply008-20261019T214618Z-pre-functions.sql. Rollback: re-run 005 sections 2 and 3. |

## Relationships

- **Depends on:** Supabase Postgres with pgvector 0.8 (iterative scan); tables and columns created by earlier files (008 needs 003 and 004 columns and the 005 functions).
- **Used by:** src/db.ts (RPC calls), src/tools/* (recall, pattern tools), bin/smoke-filtered-recall.sh (regression test for 008), bin/apply-007-hv512.sh (applies 007).

## Entry Points

None are run automatically. Files are sent by hand (Management API or SQL editor). Nothing here is read by the app at runtime.

## Gotchas

- Numbering gap at 006 is intentional; do not renumber.
- Migrations are applied via the Management API and are NOT recorded in supabase_migrations history, so that table cannot tell you what is live. Check pg_proc.
- Storing a pgvector GUC in a function SET clause needs superuser on Supabase (error 42501). 008 therefore calls set_config(..., true) per call and restores the previous value before returning; removing the restore leaks the GUC into the caller's transaction.
- CREATE INDEX CONCURRENTLY (007) cannot run in a transaction or be batched with other statements; send it as a single statement. An interrupted build leaves an INVALID index of the same name.
- Rollback for 008 is re-running 005 sections 2 and 3.
- Stale text: 005 header and README.md setup SQL predate the live schema.

## Related

- docs/PLAN-index-tuning-2026-10-20.md, docs/MIGRATION-orchestration.md, docs/TASK-recall-upgrade.md
- Memory: `recall("migration 008 iterative scan hnsw", project_id="memory-mcp")`
