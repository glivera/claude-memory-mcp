#!/usr/bin/env bash
# Usage: bin/apply-007-hv512.sh [--dry-run]
set -euo pipefail

case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") DRY=0 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SQL_FILE="$ROOT/migrations/007_hv512_hnsw_index.sql"
REF=nlvvhfwagdlfjjhouuae
IDX=idx_agpm_embedding_hv512
RUN_ID="apply007-$(date -u +%Y%m%dT%H%M%SZ)"
LOG="/tmp/$RUN_ID.log"
START_EPOCH=$(date +%s)
START_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MODE=$([ "$DRY" = 1 ] && echo dry-run || echo real)

exec > >(tee -a "$LOG") 2>&1

PGV="n/a"; ROWS="n/a"; ROWS_EMB="n/a"; ROLE="n/a"; STMT_TO="n/a"; OUTCOME="aborted: unknown"; NEW_SIZE="n/a"

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
  echo "rows in table:     $ROWS"
  echo "rows w/ embedding: $ROWS_EMB (to be indexed)"
  echo "role:              $ROLE"
  echo "statement_timeout: $STMT_TO"
  echo "outcome:           $OUTCOME"
  echo "new index size:    $NEW_SIZE"
  echo "exit code:         $rc"
  echo "log:               $LOG"
}
trap summary EXIT

SQL_STMT=$(awk '/^CREATE INDEX CONCURRENTLY/{f=1} f{print} f && /;[[:space:]]*$/{exit}' "$SQL_FILE")
if [ -z "$SQL_STMT" ] || ! printf '%s' "$SQL_STMT" | grep -q ';[[:space:]]*$'; then
  OUTCOME="aborted: CREATE INDEX statement not found in $SQL_FILE"
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
    OUTCOME="aborted: HTTP $code from Management API"
    exit 1
  fi
  if printf '%s' "$json" | jq -e 'type=="object" and has("message")' >/dev/null 2>&1; then
    echo "API error: $(printf '%s' "$json" | jq -r .message)" >&2
    OUTCOME="aborted: API error"
    exit 1
  fi
  printf '%s' "$json"
}

to_ms() {
  local v=$1 n u
  n=$(printf '%s' "$v" | sed -E 's/^([0-9.]+).*/\1/')
  u=$(printf '%s' "$v" | sed -E 's/^[0-9.]+ *//')
  case "$u" in
    ""|ms) awk -v n="$n" 'BEGIN{printf "%d", n}' ;;
    s) awk -v n="$n" 'BEGIN{printf "%d", n*1000}' ;;
    min) awk -v n="$n" 'BEGIN{printf "%d", n*60000}' ;;
    h) awk -v n="$n" 'BEGIN{printf "%d", n*3600000}' ;;
    d) awk -v n="$n" 'BEGIN{printf "%d", n*86400000}' ;;
    *) echo "unparseable timeout: $v" >&2; return 1 ;;
  esac
}

echo "== $RUN_ID mode=$MODE =="

echo "-- preflight 1: pgvector version"
R=$(q "select extversion from pg_extension where extname='vector'" true)
echo "$R"
PGV=$(printf '%s' "$R" | jq -r '.[0].extversion // empty')
if [ -z "$PGV" ]; then OUTCOME="aborted: pgvector not installed"; echo "$OUTCOME"; exit 1; fi
if [ "$(printf '%s\n0.7.0\n' "$PGV" | sort -V | head -1)" != "0.7.0" ]; then
  OUTCOME="aborted: pgvector $PGV < 0.7.0"; echo "$OUTCOME"; exit 1
fi

echo "-- preflight 2: existing index"
R=$(q "select i.indisvalid, i.indisready from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname='$IDX'" true)
echo "$R"
if [ "$(printf '%s' "$R" | jq 'length')" -gt 0 ]; then
  VALID=$(printf '%s' "$R" | jq -r '.[0].indisvalid')
  if [ "$VALID" = "true" ]; then
    OUTCOME="already present"
    echo "already present and valid, nothing to do"
    exit 0
  fi
  OUTCOME="invalid index exists, needs drop (separate approval)"
  echo "index $IDX exists but is INVALID; it must be dropped first (separate approval)"
  exit 2
fi

echo "-- preflight 3: expression probe"
R=$(q "select count(*) n, count(embedding) with_emb, min(pg_column_size(subvector(embedding,1,512)::halfvec(512))) min_b, max(pg_column_size(subvector(embedding,1,512)::halfvec(512))) max_b from public.all_global_project_memory" true)
echo "$R"
ROWS=$(printf '%s' "$R" | jq -r '.[0].n')
ROWS_EMB=$(printf '%s' "$R" | jq -r '.[0].with_emb')

echo "-- preflight 4: write-role session settings"
R=$(q "select current_user u, current_setting('statement_timeout') st, current_setting('maintenance_work_mem') mwm" false)
echo "$R"
ROLE=$(printf '%s' "$R" | jq -r '.[0].u')
STMT_TO=$(printf '%s' "$R" | jq -r '.[0].st')
MWM=$(printf '%s' "$R" | jq -r '.[0].mwm')
echo "role=$ROLE statement_timeout=$STMT_TO maintenance_work_mem=$MWM"
if [ "$STMT_TO" != "0" ]; then
  TO_MS=$(to_ms "$STMT_TO")
  if [ "$TO_MS" -ne 0 ] && [ "$TO_MS" -lt 600000 ]; then
    OUTCOME="aborted: statement_timeout $STMT_TO < 10min"
    echo "statement_timeout $STMT_TO is below 10min: a CONCURRENTLY build could be killed mid-way and leave an INVALID index"
    exit 3
  fi
fi

echo "-- preflight 5: current index sizes"
R=$(q "select indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) size from pg_stat_user_indexes where relname='all_global_project_memory' order by pg_relation_size(indexrelid) desc" true)
printf '%s' "$R" | jq -c '.[]'

echo "-- preflight 6: concurrent index builds"
R=$(q "select count(*) n from pg_stat_activity where query ilike '%create index%' and pid <> pg_backend_pid() and state='active'" true)
echo "$R"
if [ "$(printf '%s' "$R" | jq -r '.[0].n')" -gt 0 ]; then
  OUTCOME="aborted: another CREATE INDEX is active"
  echo "$OUTCOME"
  exit 1
fi

if [ "$DRY" = 1 ]; then
  OUTCOME="dry-run ok"
  echo "DRY-RUN: preflight steps 1 to 6 EXECUTED against live DB; WOULD run (not executed): $SQL_STMT"
  exit 0
fi

echo "-- applying"
q "$SQL_STMT" false >/dev/null
echo "statement sent"

echo "-- verify"
R=$(q "select i.indisvalid, i.indisready, pg_size_pretty(pg_relation_size(c.oid)) size from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname='$IDX'" true)
echo "$R"
if [ "$(printf '%s' "$R" | jq -r '.[0].indisvalid // false')" != "true" ] || [ "$(printf '%s' "$R" | jq -r '.[0].indisready // false')" != "true" ]; then
  OUTCOME="invalid"
  echo "index missing or not valid/ready"
  exit 4
fi
NEW_SIZE=$(printf '%s' "$R" | jq -r '.[0].size')
OUTCOME="created valid"
