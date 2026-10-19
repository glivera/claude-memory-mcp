# src

Runtime of the memory-mcp server: an Express (HTTP) or stdio MCP server that exposes 13 memory and skill-pattern tools, backed by Supabase pgvector and OpenAI embeddings. This directory holds the server bootstrap and the shared infrastructure (config, DB access, embeddings, errors, logging); the tool handlers live in `tools/`.

## Files

| File | Purpose |
|------|---------|
| index.ts | Process entry point. Picks transport from `MCP_TRANSPORT` (`stdio` or default HTTP). In HTTP mode it serves `POST /mcp` (a fresh McpServer plus stateless StreamableHTTPServerTransport per request, no session ids), `GET /health`, and 405s on `GET`/`DELETE /mcp`. Registers `remember`, `recall`, `forget`, `project_status` inline, then delegates to `registerPatternTools` and `registerOrchestrationTools`. Warns at startup if `SIMILARITY_THRESHOLD` is above 0.4. |
| config.ts | Zod-validated env config, cached after first read via `getConfig()`; `resetConfigCache()` exists for tests. Beyond the documented vars it has two feature flags: `RECALL_HYBRID` ('0'/'1', default '0') and `RECALL_ENVELOPE` ('0'/'1', default '1'). |
| db.ts | The only module that talks to Supabase for memory data: lazy singleton client (service key), row/result interfaces, and typed helpers (insert, vector match RPCs, goal/compliance/link RPCs, status update, list, soft-delete, stats view, latest context). Also exports `getSupabaseClient()` which the pattern tools use directly. |
| embedding.ts | OpenAI embeddings wrapper (`generateEmbedding`). Lazy client singleton; two attempts total, retry only for 429/500/502/503; no backoff delay. Wraps failures in `EmbeddingError`. |
| errors.ts | `ValidationError`, `EmbeddingError`, `DbError` (plain Error subclasses with `cause` support). |
| log.ts | `logToolCall`: one stderr line per tool call (tool, project_id, memory_id, ms, ok or error). |
| token-counter.ts | Approximate token counting (chars / 4) and `truncateToTokenLimit` used by recall to cap output size. |

## Relationships

- **Depends on:** npm packages `@modelcontextprotocol/sdk`, `express`, `@supabase/supabase-js`, `openai`, `zod`; Supabase tables, views and RPCs defined in `../migrations/`; the OpenAI embeddings API.
- **Used by:** `tools/` (imports db, embedding, config, errors, log, token-counter); `../tests/unit/` mocks these modules; the Docker image runs `index.ts` (tsx in dev, compiled in prod).
- **RPCs called from db.ts and where their bodies come from:**
  - `all_global_match_memories_v2` (plain recall) and `match_memories_with_links_v2` (recall with `status` or `follow_links`): bodies are now defined by `../migrations/008_filtered_recall_iterative_scan.sql` (iterative HNSW scan for project-filtered recall). The signatures are unchanged, so no TypeScript changed.
  - `all_global_match_memories_hybrid` (FTS plus vector with RRF fusion, used when `RECALL_HYBRID=1`): defined in `../migrations/004_hybrid_recall_provenance.sql`; untouched by 008.
  - `goal_progress_rpc`, `compliance_trend_rpc`, `link_memories_rpc`: `../migrations/003_orchestration_hardening.sql`.
  - `match_skill_patterns`, `get_mature_patterns` (called from `tools/`, not db.ts): `../migrations/002_skill_patterns.sql`.
  - View `all_global_memory_stats` backs `getMemoryStats`.

## Entry Points

- `index.ts` is the only file executed directly (Docker CMD / `tsx src/index.ts`). Claude Code reaches it over HTTP `POST /mcp` on `MCP_PORT`, or via stdio when launched with `MCP_TRANSPORT=stdio`.
- Everything else is imported: `tools/*` call db.ts helpers, `generateEmbedding`, `getConfig`, `logToolCall`.

## Gotchas

- `MCP_PORT` default in index.ts is 3100, while CLAUDE.md and docker-compose use 3101. The container must set `MCP_PORT=3101`; do not rely on the code default. index.ts reads `process.env` directly for transport and port, not through config.ts.
- MCP server version string `0.4.0` is hardcoded twice in index.ts (stdio and HTTP branches).
- `formatError` is duplicated: index.ts prefixes `[ValidationError]`/`[EmbeddingError]`/`[DbError]`, while `tools/patterns-index.ts` and `tools/orchestration-index.ts` emit a generic `[Error]`.
- Stateless HTTP: each request builds a new McpServer and registers all tools again. There are no session ids despite older docs.
- Threshold above 0.4 silently returns empty recall results (startup warning only, no failure).
- Expiry filtering: RPCs and queries must exclude expired rows (`expires_at IS NULL OR > now()`). `expireMemoryById` and `expireMemoriesByProject` intentionally omit that guard (PostgREST 42703 and wrong-count quirk, explained in code comments), so re-forgetting refreshes `expires_at`.
- `updateStatus` with a `resolution_note` does read, append a `[CLOSURE ...]` line, re-embed, then update (not atomic; last write wins). Without a note it only changes status.
- `listMemories` and `getLatestContext` filter by `project_id` only; they never use embeddings.
- `token-counter.ts` counts chars / 4, an estimate; `truncateToTokenLimit` only truncates the first entry that overflows (and only if more than 20 tokens remain).
- `log.ts` types `args` as `any` (against the strict-TS rule) and logs only `project_id` and `memory_id`, never content.
- Never DELETE memory rows; only soft-delete via `expires_at`.

## Related

- FEATURES.md: none.
- Memory: `recall("memory-mcp recall RPC iterative scan 008", project_id="memory-mcp")`
