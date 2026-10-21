# Plan: forget bulk guard + MCP_PORT single source of truth (2026-10-20)

Status: AMENDED 2026-10-21 by founder decision ("да, убираем массовое удаление"; reason: memory is history, mass deletes make no sense, long-term cleanup is rare). Sections 2, 2a, 2b below (dry-run/confirm_count/cap design) are SUPERSEDED and kept only as the audit trail. Sections 1 and 3 stand.

## 0. Decision as built

- `forget` is BY-ID ONLY: `memory_id` (uuid) and `project_id` are both required, schema is strict. A call with only `project_id`, or carrying `older_than_days`, is rejected with a clear error. The bulk code path (`expireMemoriesByProject`) and its params are deleted.
- Ownership check and soft delete are kept. The by-id path only expires a LIVE row: an already-expired row is a no-op reported as `already_expired:true`, `expired_count:0`, nothing written (original `expires_at` survives).
- MCP behaviour note: the SDK strips unknown keys before the handler, so `{memory_id, project_id, older_than_days}` over MCP acts as a plain by-id call (harmless); `{project_id, older_than_days}` fails on the missing `memory_id`. Direct handler calls reject unknown keys explicitly.
- Long-term retention cleanup is NOT part of the MCP and is not built now. If ever needed it is a separate founder-run script with `--dry-run`, never an agent-callable tool.
- Port: code default and `EXPOSE` are 3101 (section 3).
- Deploy is founder-run: `deploy-forget.sh` in the repo root (`--dry-run` builds, tests and checks config, stops before recreate; the real run recreates only the `memory-mcp` service, never compose down).
- Residual risk: `mcp__memory__forget` stays in the global auto-allow list (founder config), but with by-id only the blast radius is one row per call.

## 1. Findings (read-only)

### A. forget
- `src/tools/forget.ts`: only `project_id` is required. With no `memory_id` the handler calls `expireMemoriesByProject(project_id, older_than_days?)`, which runs `UPDATE ... SET expires_at=now() WHERE project_id=$1 [AND created_at < cutoff]`. So `forget({project_id:"x"})` expires the whole project, no confirmation, no cap. The only mitigation today is a `warning` string in the response AFTER the fact.
- The tool description in `src/index.ts:69` advertises it: "omit it to forget all memories for the project".
- The update has no live-row guard (PostgREST 42703 quirk), so it also REFRESHES `expires_at` on rows that were already expired. After a bulk call the original expiry timestamps are lost, which destroys the only forensic trail (expires_at clusters) and makes recovery of earlier deliberate forgets ambiguous.
- There is no undo tool. "Data can be recovered" is only true via manual SQL.
- Exposure right now (live memories a no-filter call would expire, from `project_status`, 78 projects, 13,962 total): n8n-pilot 1852, stock-signal-scanner 1536, astro-forge 1411, freelance-hub 1218, gaming-terminal-console 695, writer-hub 692, advisor 608, architect 569, server-forge 459, kinga-nagy-hr-bot 374; memory-mcp 56.
- History (container log since 2026-08-15, running image is v0.4.0): 23 forget calls, 21 single-id, 2 bulk. Both bulk calls were against `writer-hub` on 2026-09-22 14:34 UTC, both died with "canceling statement due to statement timeout" at ~8.3 s. They did nothing only because the shared Supabase instance is IOPS-capped; a faster DB would have expired 692 rows. The log line does not record `older_than_days`, so we cannot tell whether those calls were filtered. Before 2026-08-15 there are no logs; clusters of `expires_at` per project could not be checked because direct SQL against production was denied in this session (permission classifier). Needs a founder-run read-only query, see section 5.

### B. MCP_PORT
- Running container `memory-mcp-memory-mcp-1`: `MCP_PORT=3101`, published 3101->3101, `/health` on 3101 answers 200, 3100 is closed. Client config `~/.claude.json` uses `http://localhost:3101/mcp`. Production is consistent.
- The mismatch is only in code defaults: `src/index.ts:16` defaults to `'3100'`, `Dockerfile:18` has `EXPOSE 3100`. Everything else (docker-compose both services, .env.example, README, CLAUDE.md, CHANGELOG) says 3101. `src/README.md:35` already documents the trap.
- Risk: anyone running `node dist/index.js` or the image without the env gets 3100 and clients silently fail to connect. Port 3100 belongs to worksection-mcp on hetzner, so the default also collides in naming.

## 2. Fix A: forget contract

New rules (soft-delete kept, nothing hard-deleted):
1. `memory_id` given: unchanged (single, ownership-checked).
2. No `memory_id` = bulk. Bulk REQUIRES `older_than_days`. Whole-project wipe via this tool is removed (ValidationError pointing to `older_than_days`). A real full wipe is a founder SQL script with `--dry-run`.
3. Bulk is dry-run by default: returns `{dry_run:true, would_expire:N, sample:[up to 5 ids+titles], project_id, older_than_days}` and mutates nothing.
4. To execute, caller passes `confirm_count: N` equal to the `would_expire` it was shown (stronger than a boolean: ties the confirmation to what was seen and fails closed on a stale dry-run). Mismatch -> error with the fresh count, no mutation.
5. Cap: `BULK_FORGET_CAP = 200` live rows per call. If N > cap the call is refused (dry-run and execute) with a message to narrow `older_than_days`.
6. Execute only touches LIVE rows (`expires_at IS NULL OR expires_at > now()`), so already-expired rows keep their original timestamp. Implementation avoids the PostgREST or()+UPDATE quirk with two steps: select live ids (or() guard, limit cap+1), then `UPDATE ... WHERE id IN (ids) AND project_id=$1`. This also keeps the statement small, so it should stay under the 8 s statement timeout.
7. Logging: `logToolCall` additionally records `older_than_days`, `dry_run`, and the count for forget, so a bulk call is visible in the log.

Files (all in this repo):
- `src/tools/forget.ts` (schema: add `confirm_count`; handler logic)
- `src/db.ts` (new `listLiveMemoryIdsByProject(projectId, olderThanDays, limit)`; `expireMemoriesByIds`; remove/replace `expireMemoriesByProject`)
- `src/index.ts` (tool description; pass new log fields)
- `src/log.ts` (extra fields)
- `tests/unit/tools/forget.test.ts`, `tests/unit/db*.test.ts` (new cases: no filter rejected; dry-run default does not call update; confirm mismatch; over cap; live-only update; single-id path unchanged)
- `README.md`, `src/tools/README.md`, `src/README.md`, `CHANGELOG.md`, `CLAUDE.md` (test count, contract)

Breaking change: any caller that relied on bare project-wide forget now gets an error. Observed usage in 8 weeks: 0 successful bulk calls, so impact is nil in practice. Version bump to v0.5.0.

### 2a. Changes after logic-auditor (0 critical, 3 high, 6 medium)

- HIGH `.in('id', 200 uuids)` is ~7.4 KB in the URL, at the gateway limit: update in chunks of 50 ids; result reports `expired_count` vs `would_expire` and a partial flag, re-run is safe (live-only select).
- HIGH select cost unproven on cold DB (the old bulk died at 8.3 s): BEFORE implementation run one founder-approved read-only timing probe of the select on writer-hub and n8n-pilot; if it exceeds ~3 s, switch to an RPC (DDL, separate ask). Also try the single-statement variant `update ... or(expires_at guard) .select('id,expires_at')` (the `updateStatus` path at src/db.ts:285 already works that way); if it works, drop the two-step design entirely, which removes the race and the URL-length issue.
- HIGH `older_than_days` was not a real guard (`0.001` passes, `setDate` truncates): require integer `>= 1`, compute cutoff as `Date.now() - days*86400000`.
- MEDIUM order the select `created_at asc` so repeated capped calls drain oldest-first; for N > cap report "more than 200".
- MEDIUM `confirm_count` rejected when combined with `memory_id`; `0` rows = no-op; mismatch error says "re-run dry-run". Dry-run response includes a literal `next:` hint.
- MEDIUM logging: log `older_than_days` and `confirm_count` from input; log dry_run/count from inside forget.ts as a separate line (no signature change for the other 12 tools).
- Test file note: forget.test.ts mocks `expireMemoriesByProject`, so removing it rewrites the file, not 3 cases.
- Honest limit: `mcp__memory__forget` is in the global auto-allow list (settings.json:26), so no permission prompt gates it. confirm_count stops accidents, not an agent that chains dry-run and execute in one turn. If a hard stop is wanted, remove forget from the auto-allow list (founder decision, a config change I will not make).
- stdio path: same handler, Fix A applies; Fix B is irrelevant there.

### 2b. Changes after devil-advocate (4 counters, 2 HIGH)

- HIGH deploy path above corrected (strongest counter: the original command could take memory down for all clients).
- HIGH tiny `older_than_days` defeats the guard: integer `>= 7` floor (decision: 7, adjustable), plus the cap. A test must prove `{older_than_days:0.00001}` is rejected. confirm_count is kept only as a stale-count guard, not sold as protection against an agent.
- MEDIUM dry-run must not look like success: response carries `executed:false`, `expired_count:0` and the text "NOTHING WAS EXPIRED"; tested. Unknown caller of the 2026-09-22 writer-hub bulk calls is unidentified (no hits in ~/.claude commands/agents/skills/hooks).
- MEDIUM apply the live-row guard to `expireMemoryById` too, or drop the forensic argument (decision for founder: recommend apply).
- MEDIUM measure before building: cold timing of a 200-id update and the section 5 burst query (if a same-minute burst over the cap exists in any project, the cap refuses cleanup of it).

## 3. Fix B: port

- `src/index.ts:16` default `'3100'` -> `'3101'`; `Dockerfile` `EXPOSE 3101`; remove the trap note in `src/README.md:35`.
- Source of truth = `docker-compose.yml` (3101 + MCP_PORT=3101), code default now agrees with it. No change to compose, clients, or `~/.claude.json`, so running clients are unaffected.
- Not done on purpose: templating compose port from a variable (more moving parts, no current need).

## 4. Rollout and risk

- Code changes are inert until the image is rebuilt. Rebuild + restart of `memory-mcp` (named service only) drops live MCP sessions of all Claude clients (Known Issue), so it needs a founder-chosen moment; this plan does NOT restart anything. Deploy (founder): merge to main first, then from /Users/glivera/containers/memory-mcp (never from a worktree: compose would name a second project and collide on 3101) run `bin/up` (Doppler injects SUPABASE_*/OPENAI_*; bare `docker compose up --build` starts with empty secrets, Zod fails at boot, restart:unless-stopped crash-loops and memory is down for every session). Deliver as a root script `deploy-forget.sh` with `--dry-run` that really runs `docker compose config` and the Doppler preflight, then curls /health on 3101 after restart.
- Running image is from 2026-08-15; rebuild also picks up everything committed to src since then (check `git log c562a5a..HEAD -- src` before deploy; only docs/migrations were seen in recent commits).
- Rollback: redeploy previous commit; no DB change in this plan (no DDL).
- Tests: `docker compose run --rm test --run` (currently 199).

## 5. Founder-run read-only check (optional, answers "did a bulk expire ever happen")

Run via Management API with `read_only:true` (the worker could not):
`select project_id, date_trunc('minute',expires_at) m, count(*) from all_global_project_memory where expires_at<=now() group by 1,2 having count(*)>=20 order by 3 desc;`

## 6. Effort

Implementation by sonnet agents ~1.5 h, tests ~0.5 h, review + audit fixes ~0.5 h. Deploy 5 min plus the session-loss window.
