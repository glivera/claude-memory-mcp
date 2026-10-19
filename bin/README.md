# bin

Operator scripts for running the memory-mcp container, evaluating recall quality and testing or applying database changes.

## Files

| File | Purpose |
|------|---------|
| up | Starts services with secrets injected by `doppler run` (project memory-mcp, config dev). File-less: no .env is written. Preflight checks a WHITELIST of 7 variable names against Doppler and fails listing missing ones. `--dry-run` runs the check and prints names only. Defaults to the memory-mcp service; pass dev or test to start those. |
| down | Runs `docker compose down` with passed args and removes any legacy .env. Note it is a bare project-wide down: pass nothing unusual and do not use it on shared stands. |
| recall-eval.ts | Computes recall@10 for plain cosine vs hybrid RPC over a query set (tests/eval/queries.local.json, gitignored; falls back to queries.example.json, a format demo only). Embeds each query via OpenAI and prints per-query and average scores plus delta. |
| smoke-filtered-recall.sh | Read-only regression test for project-filtered recall. Calls the recall RPCs through PostgREST, 6 cases, expects 6/6 since migration 008. Reads a fixed memory's embedding as the query vector; tokens go through a 0600 header file, never argv. |
| apply-007-hv512.sh | One-off apply for deferred migration 007. `--dry-run` executes every preflight (role, statement_timeout, pgvector, row counts) and stops before the build. Aborts while statement_timeout is below 10 min (currently 2min on the API role). Delete after 007 is applied. |

## Relationships

- **Depends on:** Doppler (memory-mcp project), docker compose, jq, curl, python3; src/embedding.ts and src/db.ts (recall-eval.ts); migrations/007 (apply script); migrations/008 (smoke test).
- **Used by:** the operator by hand; bin/up is the documented way to start the stack (see root CLAUDE.md).

## Entry Points

All files are invoked manually from the repo root. recall-eval.ts runs with tsx.

## Gotchas

- up's WHITELIST must match what src/config.ts reads and the docker-compose.yml environment entries; widening it is a deliberate edit.
- smoke-filtered-recall.sh depends on the hard-coded memory id existing; it fails if that row is removed.
- apply-007-hv512.sh is expected to be deleted once 007 is live; it logs to /tmp/apply007-*.log.

## Related

- Migrations: migrations/README.md; plan: docs/PLAN-index-tuning-2026-10-20.md
- Memory: `recall("bin/up doppler whitelist", project_id="memory-mcp")`
