# Ollama Embeddings Branch

This branch (`ollama-embeddings`) replaces the OpenAI embedding backend used on `main` with a local [Ollama](https://ollama.com) server. All memory and pattern-search functionality works identically — only the embedding layer changes.

**Base:** `main` @ `v0.2.0` (orchestration & hardening release).
**Maintained for:** users who want local, zero-cost, offline embeddings instead of paying OpenAI per request.

---

## What changes vs `main`

| Area | `main` | `ollama-embeddings` |
| --- | --- | --- |
| Embedding provider | OpenAI API | Local Ollama HTTP (`/api/embeddings`) |
| Default model | `text-embedding-3-small` | `qwen3-embedding-0.6b` |
| Vector dimensions | **1536** | **1024** |
| Required env var | `OPENAI_API_KEY` | `OLLAMA_URL` (default `http://127.0.0.1:11434`) |
| npm dep | `openai` | — (uses native `fetch`) |
| Default `SIMILARITY_THRESHOLD` | `0.7` | `0.25` (lower signal with local models) |

Everything else — MCP tools, DB schema shape, Supabase RPCs, token cap, session logic — is untouched.

---

## Files changed (vs `main`)

- `src/config.ts` — `OPENAI_API_KEY` → `OLLAMA_URL`; default model + threshold updated.
- `src/embedding.ts` — OpenAI SDK removed; `fetch(OLLAMA_URL + '/api/embeddings')` with 1-retry backoff on 429/5xx.
- `package.json` — `openai` dependency removed.
- `.env.example`, `.env.test.example` — Ollama vars.
- `migrations/002_skill_patterns.sql` — `vector(1536)` → `vector(1024)`.
- `tests/unit/config.test.ts`, `tests/unit/embedding.test.ts`, `tests/unit/tools/recall.test.ts` — updated to mock `fetch` instead of OpenAI SDK.

## Files added (local migrations, not in `main`)

- `setup.sql` — one-shot bootstrap that drops old OpenAI-shaped schema and recreates the `all_global_project_memory` table at `vector(1024)`.
- `migrations/003_recall_since_days.sql` — adds `min_created_at` parameter to `all_global_match_memories` RPC for `since_days` filtering.
- `migrations/004_fix_function_ambiguity.sql` — drops the 5-param overload of `all_global_match_memories` that conflicts with the 6-param version from `003`.

## Files renamed

- `migrations/003_orchestration_hardening.sql` (from upstream `main`) → `migrations/005_orchestration_hardening.sql`, with `vector(1536)` → `vector(1024)` in `match_memories_with_links_rpc`. Renumbered so chronological migration order stays stable when the local `003`/`004` above are already applied.

---

## Quick start

```bash
# 1. Run Ollama locally (any OS)
ollama serve &
ollama pull qwen3-embedding-0.6b

# 2. Prepare Supabase
#    Execute setup.sql against an empty database (creates 1024-dim memory table).
#    Then run migrations 002 → 003 → 004 → 005 in order.

# 3. Configure .env (copy from .env.example)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...your-service-role-key
OLLAMA_URL=http://127.0.0.1:11434
EMBEDDING_MODEL=qwen3-embedding-0.6b

# 4. Build and run
docker compose up -d memory-mcp
```

---

## Keeping in sync with `main`

When upstream `main` releases v0.3+:

```bash
git fetch origin
git checkout ollama-embeddings
git merge origin/main          # resolve conflicts as needed
```

Expected recurring conflict points:

- **New migrations from upstream that declare `vector(1536)`** — after merge, `grep -n "vector(1536)" migrations/*.sql` and replace with `vector(1024)`. Renumber only if the upstream filename collides with a local migration (e.g. another `003_*.sql`).
- **Tests that mock the OpenAI SDK for new tools** — replace `vi.mock('openai', ...)` with `global.fetch = vi.fn()` patterns; see `tests/unit/embedding.test.ts` for the canonical form.
- **New config fields referencing `OPENAI_API_KEY`** — map to `OLLAMA_URL` or add a sibling field as needed.

The embedding interface (`generateEmbedding(text: string): Promise<number[]>`) is stable; new MCP tools that call it will work without modification as long as the vector dimension matches.

---

## Why not ship this on `main`?

Swapping the embedding provider is a breaking change for anyone running the server: the stored vectors are 1536-dim on `main` and 1024-dim here, which means the two databases are not interchangeable and you cannot switch backends without re-embedding every row. Keeping the Ollama adaptation on a separate long-lived branch lets upstream stay OpenAI-first while giving self-hosters a clean drop-in alternative.

---

## Branch policy

- Only pushed to by this branch's maintainer.
- Never merged into `main`.
- Tracks `main` forward-only (merge upstream → here, not the other way round).
