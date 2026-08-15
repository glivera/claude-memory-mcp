# Changelog

All notable changes to claude-memory-mcp are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

---

## [0.4.0] — 2026-08-15

### Added

- **`all_global_match_memories_v2`** and **`match_memories_with_links_v2`**
  RPCs (`migrations/005_recall_full_columns.sql`). Both `recall` paths now
  return `status`, `provenance`, and `trust_score` on every row, closing the
  gap where unfiltered recall could not label resolved/superseded/waived
  entries. Migration 005 also captures the live `all_global_match_memories`
  v1 definition (previously undocumented, changed out-of-band in commit
  9a0cbc4) so it is versioned in a file for the first time.
- Startup invariant: `SIMILARITY_THRESHOLD > 0.4` now logs a loud warning
  at server start, naming the documented empty-results boundary for
  `text-embedding-3-small`.
- Tool-layer request logging (`logToolCall` in `src/index.ts`). Every
  `remember`/`recall`/`forget`/`project_status` call logs one stderr line
  with tool name, project, memory_id, duration, and outcome. Destructive
  operations (`forget`) can now be reconstructed from `docker logs` alone.
  `docker-compose.yml` adds `json-file` log rotation (10m / 3 files) to
  the `memory-mcp` service.

### Changed

- **`SIMILARITY_THRESHOLD`** code default: `0.7` → `0.25`, matching the
  documented and production value (previously safe only via an untracked
  `.env`).
- **`RECALL_ENVELOPE`** code default: `'0'` → `'1'` (same untracked-.env
  class as above; the envelope must not depend on an untracked file).
- **`forget`** now requires `project_id` (kebab-case) on every call and
  enforces ownership: `expireMemoryById` filters by `project_id` in
  addition to `id`, distinguishing "belongs to a different project" from
  "not found or expired". Repeat-forget of an already-expired memory in
  the right project returns `expired_count: 1` (not 0); this is
  documented as intentional, not a regression.
- Docs realigned to the pattern-dedup reality: `DEDUP_THRESHOLD` is `0.75`
  (empirically calibrated in commit 0dc52e3, `0.9` produced zero merges
  with `text-embedding-3-small`), not `0.9` as several docs previously
  claimed.
- Version bumped to 0.4.0 (`package.json`, `McpServer` version strings).

---

## [0.3.0] — 2026-08-15

### Added

- **`update_memory_status(memory_id, project_id, status, resolution_note?)`**
  tool — updates the status of an existing memory. Requires `project_id`
  ownership match. `resolution_note` is required for closing statuses
  (`resolved`, `waived`, `superseded`); it is appended to `content` as a
  date-stamped `[CLOSURE ...]` line and the content is re-embedded. No
  transition guard — re-opening a closed memory is allowed.
- **`list_memories(project_id, memory_type?, status?, since_days?, limit?)`**
  tool — plain exact-filter enumeration (no embedding, no RPC). Returns
  compact rows (`id`, `title`, `memory_type`, `status`, `created_at`) plus
  an exact total count. Fills the gap `recall` cannot: enumeration and
  counts, where `recall`'s embedding-ranked top-N is structurally wrong.
- 24 new unit tests covering both tools (196 total).

### Changed

- **`updateStatus` db helper** now requires `project_id` and enforces
  ownership: the update filters on `project_id` in addition to `id`, and
  on a 0-row result does a secondary read to distinguish "belongs to a
  different project" from "not found or expired".

---

## [0.2.0] — 2026-04-19

### Orchestration & Hardening layer

Additive upgrade enabling multi-agent orchestration (plan enforcement,
devil's-advocate review, compliance tracking) on top of the v0.1 memory
model. **Fully backward-compatible** — existing callers keep working
unchanged, no re-embedding required, no data touched on upgrade.

Upgrade guide: [`docs/MIGRATION-orchestration.md`](docs/MIGRATION-orchestration.md)

### Added

- **4 new `memory_type` values:** `goal`, `deviation`, `counter_argument`,
  `compliance_check`
- **3 new columns on `all_global_project_memory`:**
  - `linked_to uuid[]` (default `{}`)
  - `relation text` (enum: `counters` | `fulfills` | `deviates_from` |
    `blocks` | `resolves` | `supersedes`)
  - `status text` (enum: `open` | `resolved` | `waived` | `superseded`,
    default `open`)
- **3 new MCP tools:**
  - `goal_progress(project_id, goal_id?)` — plan completion stats
    (total, completed, in-progress, deviations open, completion %)
  - `link_memories(from_id, to_ids[], relation)` — atomic relation
    link, single `UPDATE ... RETURNING` (no fetch-merge race)
  - `compliance_trend(project_id, since_days?)` — compliance_check
    entries over the last N days, most recent first
- **4 new Supabase RPCs:** `goal_progress_rpc`, `compliance_trend_rpc`,
  `link_memories_rpc`, `match_memories_with_links_rpc`
- **Extended tool signatures:**
  - `remember` accepts optional `linked_to`, `relation`, `status`
  - `recall` accepts optional `status`, `follow_links`, `linked_type`
- **Partial index** `memory_status_open_idx` for fast recall of
  `status=open` entries
- Full v0.2 test coverage: 30 new unit tests (155 total, 15 files)

### Migration

Run [`migrations/003_orchestration_hardening.sql`](migrations/003_orchestration_hardening.sql)
in your Supabase SQL editor. Safe to apply on a populated database;
zero downtime, zero data touched. Existing v0.1 users can skip and
continue operating on the 8-tool surface indefinitely.

### Design choices

- **Unified recall model preserved.** No new tables — all relationships
  live in columns on `all_global_project_memory`.
- **Zod defaults at tool layer**, not DB defaults — keeps schema lean
  and puts validation at the boundary closest to the caller.
- **Partial index on `status='open'` only** — STABLE function predicates
  in alternative indexes didn't match query planners; explicit partial
  index with constant beats function-based indexing here.

---

## [0.1.0] — 2026-03

### Initial release

- **4 memory tools:** `remember`, `recall`, `forget`, `project_status`
- **4 skill pattern tools:** `pattern_store`, `pattern_search`,
  `pattern_mature`, `pattern_mark_as_skill`
- OpenAI `text-embedding-3-small` (1536 dims) via Supabase pgvector
- Streamable HTTP transport on port 3101 + stdio transport
- Docker + docker-compose deploy
- Soft-delete via `expires_at` (never hard-delete)
- Auto-deduplication on `pattern_store` (cosine sim > 0.9 → merge +
  count+1; else create) (later recalibrated to 0.75)
- Skill maturation heuristic (`pattern_mature`): pattern seen 3+
  times flagged as SKILL.md candidate
