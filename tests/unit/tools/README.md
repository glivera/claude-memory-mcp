# tests/unit/tools

Vitest tests for the tool handlers in `src/tools/`, one `*.test.ts` per handler. Each test mocks `src/db.js`, `src/embedding.js` and, where relevant, `src/config.js`, then asserts validation, branching, and output shape.

## Files

| File | Purpose |
|------|---------|
| recall.test.ts | Largest suite: RPC routing (plain v2 vs links vs hybrid), `since_days` cutoff, `status`/`follow_links`/`linked_type` filtering, limit defaults, token cap truncation, provenance and trust_score passthrough, `wrapRecallResult` envelope on/off. |
| remember.test.ts | Input validation (kebab-case, title length, enums), embedding of `title + content`, provenance and trust_score defaults, `expires_in_days`, links and status fields. |
| forget.test.ts | Forget by id only: project-only and bulk params rejected, ownership errors, already-expired no-op. |
| project-status.test.ts | Aggregation of stats rows into per-project counts and totals, latest context lookup. |
| update-memory-status.test.ts | Closing statuses require `resolution_note`, re-open path, not-found and wrong-project errors. |
| list-memories.test.ts | Filter passthrough, default and max limit, total count. |
| goal-progress.test.ts | `goal_progress_rpc` wrapper, optional goal id, validation. |
| link-memories.test.ts | `link_memories_rpc` wrapper, relation enum, uuid validation, missing source memory. |
| compliance-trend.test.ts | `since_days` default 30 and 365 cap, project_id validation. |
| pattern-store.test.ts | Dedup merge vs create, count and `proposed_skill` at 3, slug generation, DB and embedding error mapping. |
| pattern-search.test.ts | Embedding plus `match_skill_patterns` call, filters, limit bounds. |
| pattern-mature.test.ts | `get_mature_patterns` params, grouping by category. |
| pattern-mark.test.ts | Bulk `skill_created` update, uuid validation, DB errors. |

## Relationships

- **Depends on:** `vitest`, `src/tools/*`, `src/errors.js`; mocks for db, embedding, config (imported as `../../../src/...`).
- **Used by:** the Vitest runner (see `../README.md`). No source imports these.
- Coverage gaps: `patterns-index.ts` and `orchestration-index.ts` (tool registration and the duplicated `formatError`) have no tests.

## Entry Points

- `docker compose run --rm test --run tests/unit/tools` runs this folder only.

## Gotchas

- Pattern tests mock `getSupabaseClient` and chain `.rpc()` / `.from().update()` shapes; changing the query chain in a handler breaks mocks even when behavior is the same.
- recall tests set `RECALL_ENVELOPE: '0'` in the default mocked config so assertions see a bare array; envelope tests flip it explicitly.
- `vi.mock` calls must precede handler imports; keep that order when adding tests.
- These tests do not touch the real RPC bodies (008 iterative scan, 004 hybrid), only the call arguments passed to mocked db helpers.
- Embedding fixtures use 1536-length arrays; the dimension is not enforced by mocks, so a model change would not fail here.
- Per-file descriptions above are inferred from handler behavior and file headers; check the test itself before relying on a specific case.

## Related

- FEATURES.md: none.
- Memory: `recall("memory-mcp tool handler tests", project_id="memory-mcp")`
