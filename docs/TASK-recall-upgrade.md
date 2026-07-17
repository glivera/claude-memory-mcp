# TASK: Recall upgrade — hybrid retrieval (R6) + provenance (R2 step 1)

Prepared by Architect 2026-07-17 (scan memory `4076408c`, project_id=architect).
Execute in a memory-mcp session. **Structural change (DB schema + recall contract
every session depends on) → mandatory planning gate applies: plan mode →
logic-auditor + devil-advocate → founder approval → implement.**

## Why

- R6 (architect ROADMAP): recall is cosine-only today. Postgres-native hybrid
  (BM25-flavored `tsvector` + pgvector, RRF fusion) reports recall@10 gains of
  ~0.62 → 0.84+ in production RAG pipelines, with ZERO new infrastructure.
- R2 step 1: recalled memories re-enter agent context as trusted text — the MCP
  memory-poisoning surface. Cheapest first defense is provenance metadata at
  write time + untrusted-DATA framing at read time (MemGuard, arXiv 2605.28009).

## Scope A — R6 hybrid retrieval (feature-flagged)

1. Migration: add `content_tsv tsvector` (generated column over title + content,
   `english` config) + GIN index on `all_global_project_memory`. Backfill is
   automatic for a generated column; verify table rewrite time on prod row count
   first (~374+ rows for architect alone; check total).
2. Recall RPC: alongside the existing cosine top-K, run a `ts_rank_cd` top-K over
   `content_tsv`; fuse the two ranked lists via Reciprocal Rank Fusion
   (`score = Σ 1/(60 + rank_i)`) — RANK-based, never weighted score averaging
   (cosine and ts_rank scales are incompatible).
3. Feature flag (env or param, default OFF): `RECALL_HYBRID=1`. Existing behavior
   byte-identical when off.
4. **Falsify-first eval gate (MANDATORY before flipping default):** build a fixed
   eval set — 15-20 real recall queries with known-relevant memory IDs (mine from
   past session transcripts / obvious cases like "doppler cron auth", "n8n empty
   array"). Measure recall@10 cosine-only vs hybrid on the SAME set. Flip default
   only if hybrid ≥ cosine on the set and no query regresses catastrophically.
   Record both numbers in memory.
5. Entity leg (cosine+BM25+entity from original R6) is OUT of this task — revisit
   after the two-signal fusion is measured. R9 (bi-temporal valid_at/invalid_at)
   is a separate follow-up AFTER this eval; do not bundle.

## Scope B — R2 step 1: provenance columns + untrusted-DATA framing

1. Migration: `provenance text NOT NULL DEFAULT 'user_authored'`
   (CHECK: `user_authored | agent_inferred | recalled_external`) +
   `trust_score real NOT NULL DEFAULT 1.0` on `all_global_project_memory`.
   Backfill: existing rows keep the default (historically session-written ≈
   agent_inferred, but relabeling history guesses provenance — leave default and
   note the epoch date in a comment).
2. `remember.ts` (write guard insertion point ~lines 47-49 per architect ROADMAP
   R2): accept optional `provenance` param from callers; session-generated
   summaries/decisions SHOULD pass `agent_inferred`; anything derived from
   external/untrusted content (web, foreign docs, tool results) MUST pass
   `recalled_external` with `trust_score <= 0.5`.
3. `recall.ts`: wrap returned memories in an explicit untrusted-DATA envelope —
   the response text frames recalled content as data-not-instructions and
   surfaces `provenance` per item. NO write-time string scrubbing (brittle,
   rejected in R2 recon `7e6df61d`).
4. No filtering logic yet (that is R2 step 2) — schema + framing only.

## Verification

- Scope A: eval-set numbers recorded (before/after); `RECALL_HYBRID` off →
  responses byte-identical to pre-migration behavior; GIN index used
  (`EXPLAIN ANALYZE` on the tsv query).
- Scope B: new rows carry provenance; recall responses show the envelope;
  existing MCP clients (all sessions!) still parse responses — this is the
  contract-break risk, test with a real Claude Code session against staging
  before deploying the container.
- Deploy: memory-mcp is a LIVE shared service (port 3101, all sessions).
  Snapshot DB before migrations; deploy off-hours; keep the old container
  image tagged for instant rollback.

## Non-goals

Entity extraction leg; R9 bi-temporal columns; R3 hnsw.iterative_scan (bundle
opportunistically ONLY if already touching the recall RPC and it is genuinely
one line); any re-ranking model; any new service.

---

## OUTCOME (2026-07-18)

Executed with full planning gate (plan rev.2 absorbed 1 BLOCKER + 6 HIGH from
logic-auditor + devil-advocate; key design changes vs this spec: functional GIN
expression index instead of stored generated column (zero rewrite), 'simple'
config instead of 'english' (mixed RU/EN), nullable provenance columns instead
of backfilled defaults (NULL = honest pre-004 unknown), envelope behind its own
RECALL_ENVELOPE flag, float-literal RRF (integer division would zero all scores).

- Scope B (provenance + envelope): LIVE. RECALL_ENVELOPE=1 in prod.
- Scope A (hybrid): SHIPPED flag-gated; held-out eval (16 queries, 11 EN/5 RU,
  transcript-mined + paraphrases) FAILED the flip rule: cosine 0.75 vs hybrid
  0.73 aggregate, RU slice 0.73 vs 0.67, one regression (q08). RECALL_HYBRID
  stays '0'. Honest negative result -- the falsify-first gate worked as designed.
- Revisit: down-weight FTS leg in RRF or exact-identifier fallback; re-run
  bin/recall-eval.ts after tuning. See memory c0e160d5 (memory-mcp).
