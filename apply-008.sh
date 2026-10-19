#!/usr/bin/env bash
# Usage: bash apply-008.sh [--dry-run] [--skip-compile]
set -euo pipefail

DRY=0
SKIP_COMPILE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --skip-compile) SKIP_COMPILE=1 ;;
    *) echo "usage: $0 [--dry-run] [--skip-compile]" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR"
MIGRATION="$ROOT/migrations/008_filtered_recall_iterative_scan.sql"
SMOKE="$ROOT/bin/smoke-filtered-recall.sh"
REF=nlvvhfwagdlfjjhouuae
FIXED_ID=a5049b83-802e-4699-b407-36d553e87252
RUN_ID="apply008-$(date -u +%Y%m%dT%H%M%SZ)"
LOG="/tmp/$RUN_ID.log"
BACKUP="/tmp/$RUN_ID-pre-functions.sql"
START_EPOCH=$(date +%s)
START_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MODE=$([ "$DRY" = 1 ] && echo dry-run || echo real)
[ "$SKIP_COMPILE" = 1 ] && MODE="$MODE (skip-compile)"

exec > >(tee -a "$LOG") 2>&1

PGV="n/a"; HASH_BEFORE="n/a"; HASH_AFTER="n/a"; SMOKE_BEFORE="n/a"; SMOKE_AFTER="n/a"
COMPILE="not run"; OUTCOME="aborted: unknown"; BACKUP_OUT="n/a"

summary() {
  local rc=${1:-$?}
  local end_epoch; end_epoch=$(date +%s)
  echo
  echo "===== SUMMARY ====="
  echo "run id:            $RUN_ID"
  echo "mode:              $MODE"
  echo "start UTC:         $START_UTC"
  echo "end UTC:           $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "duration seconds:  $((end_epoch - START_EPOCH))"
  echo "pgvector version:  $PGV"
  echo "function hashes before: $HASH_BEFORE"
  echo "function hashes after:  $HASH_AFTER"
  echo "smoke before:      $SMOKE_BEFORE"
  echo "smoke after:       $SMOKE_AFTER"
  echo "compile check:     $COMPILE"
  echo "backup:            $BACKUP_OUT"
  echo "outcome:           $OUTCOME"
  echo "exit code:         $rc"
  echo "log:               $LOG"
}
trap 'summary "$?"' EXIT

if [ ! -f "$MIGRATION" ] || [ ! -x "$SMOKE" ]; then
  OUTCOME="aborted: migration file or smoke script missing"
  echo "$OUTCOME"
  exit 1
fi

# Token goes into a 0600 header file read by curl (-H @file), never into argv.
HDR=$(mktemp)
chmod 600 "$HDR"
trap 'rc=$?; rm -f "$HDR"; summary "$rc"; exit "$rc"' EXIT
printf 'Authorization: Bearer %s\n' "$(doppler secrets get SUPABASE_ACCESS_TOKEN --project n8n-pilot --config dev --plain)" > "$HDR"

q() {
  local sql=$1 ro=$2 body resp code json
  body=$(jq -n --arg q "$sql" --argjson ro "$ro" '{query:$q, read_only:$ro}')
  resp=$(curl -sS -w '\n%{http_code}' -X POST \
    "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H @"$HDR" \
    -H "Content-Type: application/json" \
    --data "$body")
  code=${resp##*$'\n'}
  json=${resp%$'\n'*}
  if [ "${code:0:1}" != "2" ]; then
    echo "HTTP $code: $json" >&2
    return 1
  fi
  if printf '%s' "$json" | jq -e 'type=="object" and has("message")' >/dev/null 2>&1; then
    echo "API error: $(printf '%s' "$json" | jq -r .message)" >&2
    return 1
  fi
  printf '%s' "$json"
}

FN_SQL="select p.proname, pg_get_function_identity_arguments(p.oid) args, md5(pg_get_functiondef(p.oid)) h, p.proconfig, position('set_config(''hnsw.iterative_scan'', ''relaxed_order'', true)' in pg_get_functiondef(p.oid)) > 0 as has_iter from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('all_global_match_memories_v2','match_memories_with_links_v2') order by p.proname"

hashes() { printf '%s' "$1" | jq -r '[.[] | "\(.proname)=\(.h)"] | join(" ")'; }

smoke_counts() {
  local out
  out=$("$SMOKE" 2>&1) || true
  printf '%s\n' "$out" >&2
  printf '%s' "$out" | sed -nE 's/^smoke summary: total=([0-9]+) passed=([0-9]+) failed=([0-9]+).*/\2\/\1 passed, \3 failed/p' | tail -1
}

echo "== $RUN_ID mode=$MODE =="

echo "-- step 1: pgvector version (read-only)"
R=$(q "select extversion from pg_extension where extname='vector'" true) || { OUTCOME="aborted: step 1 pgvector query failed"; exit 1; }
echo "$R"
PGV=$(printf '%s' "$R" | jq -r '.[0].extversion // empty')
if [ -z "$PGV" ]; then OUTCOME="aborted: pgvector not installed"; echo "$OUTCOME"; exit 1; fi
if [ "$(printf '%s\n0.8.0\n' "$PGV" | sort -V | head -1)" != "0.8.0" ]; then
  OUTCOME="aborted: pgvector $PGV < 0.8.0 (iterative scan needs 0.8)"; echo "$OUTCOME"; exit 1
fi

echo "-- step 2: current function state (read-only)"
R=$(q "$FN_SQL" true) || { OUTCOME="aborted: step 2 function state query failed"; exit 1; }
printf '%s' "$R" | jq -c '.[]'
if [ "$(printf '%s' "$R" | jq 'length')" -ne 2 ]; then
  OUTCOME="aborted: expected exactly 2 functions, found $(printf '%s' "$R" | jq 'length')"; echo "$OUTCOME"; exit 1
fi
HASH_BEFORE=$(hashes "$R")
if [ "$(printf '%s' "$R" | jq '[.[] | select(((.proconfig // []) | any(. == "plan_cache_mode=force_custom_plan")) and .has_iter == true)] | length')" -eq 2 ]; then
  OUTCOME="already applied"
  echo "already applied: both functions carry plan_cache_mode=force_custom_plan and the in-body hnsw.iterative_scan set_config"
  exit 0
fi

echo "-- step 3: backup of current function definitions (read-only)"
R=$(q "select p.proname, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('all_global_match_memories_v2','match_memories_with_links_v2') order by p.proname" true) || { OUTCOME="aborted: step 3 backup query failed"; exit 1; }
printf '%s' "$R" | jq -r '.[] | .def + ";\n"' > "$BACKUP"
chmod 600 "$BACKUP"
BACKUP_OUT="$BACKUP"
echo "backup written: $BACKUP ($(wc -c < "$BACKUP" | tr -d ' ') bytes)"

echo "-- step 4: smoke BEFORE apply (failure expected pre-apply: reproduces the bug)"
SMOKE_BEFORE=$(smoke_counts)
[ -n "$SMOKE_BEFORE" ] || SMOKE_BEFORE="no summary line (smoke script died)"
echo "smoke before: $SMOKE_BEFORE"

COMPILE_N="skipped"; COMPILE_NL="skipped"
if [ "$SKIP_COMPILE" = 1 ]; then
  COMPILE="skipped (--skip-compile)"
  echo "-- step 5: compile check SKIPPED (--skip-compile)"
else
  echo "-- step 5: compile check (write-mode request, rolled back)"
  MIG_BODY=$(grep -v '^notify pgrst' "$MIGRATION")
  COMPILE_SQL="begin;
$MIG_BODY
create temp table _apply008_r on commit drop as select (select count(*) from public.all_global_match_memories_v2((select embedding from public.all_global_project_memory where id='$FIXED_ID'), 'n8n-pilot', null, 5, 0.25, null)) as n, (select count(*) from public.match_memories_with_links_v2((select embedding from public.all_global_project_memory where id='$FIXED_ID'), 'n8n-pilot', null, null, 5, 0.25, null, true)) as n_links;
select n, n_links, coalesce(current_setting('hnsw.iterative_scan', true), '') as iter_after from _apply008_r;
rollback;"
  R=$(q "$COMPILE_SQL" false) || { OUTCOME="aborted: step 5 compile check request failed"; exit 1; }
  echo "$R"
  COMPILE_N=$(printf '%s' "$R" | jq -r '[.. | objects | select(has("n")) | .n][0] // empty')
  COMPILE_NL=$(printf '%s' "$R" | jq -r '[.. | objects | select(has("n_links")) | .n_links][0] // empty')
  COMPILE_IT=$(printf '%s' "$R" | jq -r '[.. | objects | select(has("iter_after")) | .iter_after][0] // "unparsed"')
  echo "compile check: v2 n=${COMPILE_N:-unparsed} (expect 5), links_v2 n_links=${COMPILE_NL:-unparsed} (expect >= 5), iter_after='${COMPILE_IT}' (expect '' or off)"
  case "$COMPILE_N:$COMPILE_NL" in *[!0-9:]*|:*|*:) COMPILE_BAD=1 ;; *) COMPILE_BAD=0 ;; esac
  if [ "$COMPILE_BAD" = 0 ] && [ "$COMPILE_N" = "5" ] && [ "$COMPILE_NL" -ge 5 ] && [ -n "$COMPILE_IT" ] && [ "$COMPILE_IT" != "off" ]; then
    COMPILE="FAILED (GUC leaked: iter_after=$COMPILE_IT; rolled back)"
    OUTCOME="aborted: GUC leaked: hnsw.iterative_scan=$COMPILE_IT after call"; echo "$OUTCOME"; exit 1
  fi
  if [ "$COMPILE_BAD" = 1 ] || [ "$COMPILE_N" != "5" ] || [ "$COMPILE_NL" -lt 5 ]; then
    COMPILE="FAILED (n=${COMPILE_N:-unparsed}, n_links=${COMPILE_NL:-unparsed}, iter_after='${COMPILE_IT}'; rolled back)"
    OUTCOME="aborted: compile check failed (need n==5 and n_links>=5)"; echo "$OUTCOME"; exit 1
  fi
  COMPILE="ok (rolled back) n=$COMPILE_N n_links=$COMPILE_NL iter_after='$COMPILE_IT'"
  echo "compile check: $COMPILE"
fi

if [ "$DRY" = 1 ]; then
  OUTCOME="dry-run ok"
  if [ "$SKIP_COMPILE" = 1 ]; then S5="skipped"; else S5="executed (rolled back) n=$COMPILE_N n_links=$COMPILE_NL"; fi
  echo "DRY-RUN: steps 1 to 4 executed read-only; step 5 $S5; WOULD apply: $MIGRATION"
  exit 0
fi

echo "-- applying (write)"
q "$(cat "$MIGRATION")" false >/dev/null || { OUTCOME="aborted: migration apply request failed"; exit 1; }
echo "migration sent"

echo "-- verify function state"
R=$(q "$FN_SQL" true) || { OUTCOME="applied but verify query failed; rollback: apply $BACKUP"; exit 1; }
printf '%s' "$R" | jq -c '.[]'
HASH_AFTER=$(hashes "$R")
OKCNT=$(printf '%s' "$R" | jq '[.[] | select(((.proconfig // []) | any(. == "plan_cache_mode=force_custom_plan")) and .has_iter == true)] | length')
if [ "$OKCNT" -ne 2 ]; then
  OUTCOME="applied but proconfig verification failed; rollback: apply $BACKUP"
  echo "$OUTCOME"
  exit 4
fi

echo "-- smoke AFTER apply"
set +e
SMOKE_OUT=$("$SMOKE" 2>&1)
SMOKE_RC=$?
set -e
printf '%s\n' "$SMOKE_OUT"
SMOKE_AFTER=$(printf '%s' "$SMOKE_OUT" | sed -nE 's/^smoke summary: total=([0-9]+) passed=([0-9]+) failed=([0-9]+).*/\2\/\1 passed, \3 failed/p' | tail -1)
if [ "$SMOKE_RC" -ne 0 ]; then
  OUTCOME="applied but smoke FAILED; rollback: apply $BACKUP"
  echo "$OUTCOME"
  exit 5
fi
OUTCOME="applied and verified"
