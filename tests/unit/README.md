# tests/unit

Vitest unit tests for `src/`. All Supabase and OpenAI access is mocked, so tests need no network, DB, or secrets. Tool handler tests live in the `tools/` subdirectory (own README).

## Files

| File | Purpose |
|------|---------|
| config.test.ts | `getConfig` defaults, coercion, required vars, `RECALL_HYBRID`/`RECALL_ENVELOPE` enums, cache and `resetConfigCache`. |
| db-expire.test.ts | `expireMemoryById`: not found, ownership mismatch, already-expired no-op, live row expires. |
| embedding.test.ts | `generateEmbedding` with a mocked `openai` module: success, single retry on 429/5xx, no retry on other errors, `EmbeddingError` wrapping. |
| errors.test.ts | Error classes: names, messages, `cause` propagation, `instanceof` checks. |
| token-counter.test.ts | `countTokens` (chars / 4) and `truncateToTokenLimit` boundary behavior (the 20-token remainder rule, ` [truncated]` suffix). |
| tools/ | One test file per handler in `src/tools/`; see `tools/README.md`. |

Related non-test asset: `../eval/queries.example.json` is a format example for a recall eval set (recall@10), not used by Vitest.

## Relationships

- **Depends on:** `vitest`, `../../src/*` modules under test; mocks for `openai`, `../../src/db.js`, `../../src/embedding.js`, `../../src/config.js`.
- **Used by:** `docker compose run --rm test --run` and pre-push checks (`/cross-verify`, `@qa-verifier`).
- Nothing in `src/` imports from here. `src/db.ts`, `src/index.ts` and `src/log.ts` have no dedicated test file; db RPC wiring is covered only indirectly through mocked handlers.

## Entry Points

- Run all: `docker compose run --rm test --run` (bare `vitest` hangs in watch mode).
- Single file: pass the path after `--run`.

## Gotchas

- Mirrors `src/` layout: a new source file under `src/tools/` needs a matching test in `tools/`.
- Because db.ts is mocked, SQL or RPC behavior (including migration 008's iterative scan and the hybrid RPC from 004) is NOT verified here; use a live recall check or the eval set for that.
- The test count in CLAUDE.md (206) can drift; recount with the runner.
- config tests mutate `process.env`; keep `resetConfigCache()` in `beforeEach` to avoid leakage.
- Mocked `getConfig` objects in tool tests must list every field the handler reads (e.g. `RECALL_HYBRID`, `RECALL_ENVELOPE`), or the handler sees `undefined` and takes the wrong branch.

## Related

- FEATURES.md: none.
- Memory: `recall("memory-mcp vitest unit tests mocks", project_id="memory-mcp")`
