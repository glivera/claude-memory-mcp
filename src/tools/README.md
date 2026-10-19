# src/tools

One module per MCP tool: each exports a Zod input schema and an async `handleX` function that validates input, calls embedding or db helpers, and returns plain JSON. Two barrel files register tool groups on the McpServer.

## Files

| File | Purpose |
|------|---------|
| remember.ts | `remember`: embeds `title + content`, inserts via `insertMemory`. Also the source of shared constants `MEMORY_TYPES` (12), `RELATIONS` (6), `STATUSES` (4). Defaults: status `open`, provenance `user_authored`, trust_score 1.0 (0.5 if provenance is `recalled_external`). `expires_in_days` becomes `expires_at`. |
| recall.ts | `recall`: embeds the query, picks one of three RPC paths (see Gotchas), applies `linked_type` filter, slices to limit, truncates to `RECALL_TOKEN_CAP` tokens. Exports `wrapRecallResult` (wraps output in `{notice, memories}` when `RECALL_ENVELOPE=1`) and the `RECALL_NOTICE` anti-prompt-injection text. |
| forget.ts | `forget`: soft-delete by `memory_id` or whole project (optionally `older_than_days`). Requires `project_id` ownership match. |
| project-status.ts | `project_status`: per-project counts from the stats view plus the latest `context` memory; one extra query per project. |
| update-memory-status.ts | `update_memory_status`: changes status; closing statuses (`resolved`, `waived`, `superseded`) require `resolution_note`, which is appended and re-embedded in db.ts. |
| list-memories.ts | `list_memories`: exact-filter listing (type, status, since_days, limit up to 100, default 50) with an exact total count; no embedding. |
| goal-progress.ts | `goal_progress`: wraps `goal_progress_rpc` (optional single goal id). |
| link-memories.ts | `link_memories`: wraps `link_memories_rpc`, atomic link update with a relation from `RELATIONS`. |
| compliance-trend.ts | `compliance_trend`: wraps `compliance_trend_rpc`; `since_days` default 30, max 365. |
| pattern-store.ts | `pattern_store`: embeds description, dedups via `match_skill_patterns` at similarity 0.75 within the same category and project; merge increments count, appends example, sets `proposed_skill` at count 3; otherwise inserts with a slug `pattern_id` (max 60 chars). |
| pattern-search.ts | `pattern_search`: semantic search over `skill_patterns` via `match_skill_patterns`, optional category/project filters, limit up to 50. |
| pattern-mature.ts | `pattern_mature`: calls `get_mature_patterns` and groups results by category. |
| pattern-mark.ts | `pattern_mark_as_skill`: sets `skill_created = true` for a list of pattern UUIDs. |
| patterns-index.ts | Barrel: `registerPatternTools(server)` registers the 4 pattern tools with tool descriptions and logging. |
| orchestration-index.ts | Barrel: `registerOrchestrationTools(server)` registers `goal_progress`, `link_memories`, `compliance_trend`, `update_memory_status`, `list_memories`; re-exports their handlers and schemas. |

## Relationships

- **Depends on:** `../db.ts` (memory data access), `../embedding.ts`, `../config.ts`, `../errors.ts`, `../log.ts`, `../token-counter.ts`, `zod`, MCP SDK types.
- **Used by:** `../index.ts` registers remember, recall, forget, project_status inline and calls the two barrels; `../../tests/unit/tools/` tests every handler.
- **Database functions reached (through db.ts):** recall uses `all_global_match_memories_v2` (plain), `match_memories_with_links_v2` (status or follow_links), and `all_global_match_memories_hybrid` (RECALL_HYBRID=1). The two v2 bodies are defined by `../../migrations/008_filtered_recall_iterative_scan.sql`; hybrid by `../../migrations/004_hybrid_recall_provenance.sql`.

## Entry Points

- `../index.ts` imports `rememberInputSchema/handleRemember`, `recallInputSchema/handleRecall/wrapRecallResult`, `forgetInputSchemaBase/handleForget`, `projectStatusInputSchema/handleProjectStatus` directly, and `registerPatternTools` / `registerOrchestrationTools` from the barrels.
- Handlers are also called directly by unit tests.

## Gotchas

- recall routing: `follow_links` or `status` forces the links RPC and ignores `RECALL_HYBRID`; else hybrid if enabled; else plain v2. Hybrid mode therefore does not apply to status-filtered recall.
- `linked_type` is only applied on the links path; on the plain or hybrid path it is silently ignored.
- recall passes `project_id` as null for cross-project search; project-filtered vector search is the case migration 008 fixes with an iterative HNSW scan, so unexpectedly few results under a project filter point to the DB function, not this code.
- `provenance` and `trust_score` are included in recall output only when non-null; null provenance means pre-2026-07 rows.
- recall output cap is token-approximate (chars / 4) and may cut the last entry's content with ` [truncated]`.
- pattern-store, pattern-search, pattern-mature and pattern-mark call `getSupabaseClient()` directly instead of db.ts helpers (inconsistent layering, harder to mock).
- pattern-store wraps embedding errors in `EmbeddingError` again (double wrap of what `generateEmbedding` already throws). Dedup is per category and project, so the same idea in two projects is stored twice.
- `forget` with no `memory_id` and no `older_than_days` expires every memory in the project.
- `formatError` is duplicated in both barrels (generic `[Error]` prefix) and differs from index.ts.
- Every handler re-parses input with `safeParse` even though the SDK already validated the shape; deliberate so direct calls (tests) are validated too.
- project_id must be kebab-case in write tools; recall's `project_id` is unvalidated.

## Related

- FEATURES.md: none.
- Memory: `recall("recall hybrid follow_links status RPC", project_id="memory-mcp")`
