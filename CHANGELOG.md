# Changelog

All notable changes to claude-memory-mcp are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

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
  count+1; else create)
- Skill maturation heuristic (`pattern_mature`): pattern seen 3+
  times flagged as SKILL.md candidate
