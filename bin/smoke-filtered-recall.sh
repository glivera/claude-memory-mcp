#!/usr/bin/env bash
# Usage: bin/smoke-filtered-recall.sh
# Read-only regression test for project-filtered recall (migration 008).
# Calls the recall RPCs through PostgREST only; writes nothing to the DB.
set -euo pipefail

FIXED_ID=a5049b83-802e-4699-b407-36d553e87252
MATCH_COUNT=5
THRESHOLD=0.25
RUN_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

SUPABASE_URL=$(doppler secrets get SUPABASE_URL --project memory-mcp --config dev --plain)
SUPABASE_SERVICE_KEY=$(doppler secrets get SUPABASE_SERVICE_KEY --project memory-mcp --config dev --plain)

# Key goes into a 0600 header file read by curl (-H @file), never into argv.
HDR=$(mktemp)
TMPDIR_=$(mktemp -d)
chmod 600 "$HDR"
trap 'rm -rf "$HDR" "$TMPDIR_"' EXIT
printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SUPABASE_SERVICE_KEY" "$SUPABASE_SERVICE_KEY" > "$HDR"

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

RESP=$(curl -sS -H @"$HDR" "$SUPABASE_URL/rest/v1/all_global_project_memory?id=eq.$FIXED_ID&select=embedding")
EMB=$(printf '%s' "$RESP" | jq -c '.[0].embedding | if type=="string" then fromjson else . end' 2>/dev/null || true)
if [ -z "$EMB" ] || [ "$EMB" = "null" ]; then
  echo "FAIL: embedding for memory $FIXED_ID not found: $(printf '%s' "$RESP" | head -c 300)" >&2
  exit 1
fi
printf '%s' "$EMB" > "$TMPDIR_/emb.json"

TOTAL=0; PASSED=0; FAILED=0

run_case() {
  local n=$1 fn=$2 project=$3 extra=$4
  local pjson body t0 t1 first_ms repeat_ms code reason="" rows result
  if [ "$project" = "null" ]; then pjson=null; else pjson=$(jq -n --arg p "$project" '$p'); fi
  body=$(jq -n --slurpfile e "$TMPDIR_/emb.json" --argjson p "$pjson" --argjson mc "$MATCH_COUNT" --argjson th "$THRESHOLD" --argjson extra "$extra" \
    '{query_embedding:$e[0], filter_project:$p, match_count:$mc, threshold:$th} + $extra')
  printf '%s' "$body" > "$TMPDIR_/body.json"

  t0=$(now_ms)
  curl -sS -o "$TMPDIR_/r1.json" -X POST "$SUPABASE_URL/rest/v1/rpc/$fn" -H @"$HDR" -H "Content-Type: application/json" --data @"$TMPDIR_/body.json"
  t1=$(now_ms); first_ms=$((t1 - t0))

  t0=$(now_ms)
  code=$(curl -sS -o "$TMPDIR_/r2.json" -w '%{http_code}' -X POST "$SUPABASE_URL/rest/v1/rpc/$fn" -H @"$HDR" -H "Content-Type: application/json" --data @"$TMPDIR_/body.json")
  t1=$(now_ms); repeat_ms=$((t1 - t0))

  TOTAL=$((TOTAL + 1))
  rows="?"
  if [ "${code:0:1}" != "2" ]; then
    reason="HTTP $code: $(head -c 200 "$TMPDIR_/r2.json")"
  else
    rows=$(jq 'length' "$TMPDIR_/r2.json")
    # links_v2 (cases 5, 6) uses strict > threshold, the others >=
    local strict=false; [ "$fn" = "match_memories_with_links_v2" ] && strict=true
    if [ "$n" = 6 ]; then
      reason=$(jq -r --arg p "$project" --argjson mc "$MATCH_COUNT" --argjson th "$THRESHOLD" '
        . as $r
        | [$r[] | select(.link_depth == 0)] as $d0
        | [
            (if ($d0|length) < $mc then "depth-0 rows \($d0|length) < \($mc)" else empty end),
            (if ([$d0[] | select(.project_id != $p)] | length) > 0 then "depth-0 row with wrong project_id" else empty end),
            (if ([$d0[] | select(.similarity <= $th)] | length) > 0 then "depth-0 similarity not above threshold" else empty end),
            (if [range(1; $d0|length)] | any(. as $i | $d0[$i].similarity > $d0[$i-1].similarity + 1e-9) then "depth-0 similarities not non-increasing" else empty end)
          ] | join("; ")' "$TMPDIR_/r2.json")
    else
    reason=$(jq -r --arg p "$project" --argjson mc "$MATCH_COUNT" --argjson th "$THRESHOLD" --argjson strict "$strict" '
      . as $r
      | [
          (if ($r|length) != $mc then "row count \($r|length) != \($mc)" else empty end),
          (if $p != "null" and ([$r[] | select(.project_id != $p)] | length) > 0 then "row with wrong project_id" else empty end),
          (if ([$r[] | select(if $strict then .similarity <= $th else .similarity < $th end)] | length) > 0 then "similarity below threshold" else empty end),
          (if [range(1; $r|length)] | any(. as $i | $r[$i].similarity > $r[$i-1].similarity + 1e-9) then "similarities not non-increasing" else empty end)
        ] | join("; ")' "$TMPDIR_/r2.json")
    fi
  fi

  if [ -z "$reason" ]; then
    PASSED=$((PASSED + 1)); result=PASS
    echo "PASS case=$n fn=$fn project=$project rows=$rows first_ms=$first_ms repeat_ms=$repeat_ms"
  else
    FAILED=$((FAILED + 1)); result=FAIL
    echo "FAIL case=$n fn=$fn project=$project rows=$rows first_ms=$first_ms repeat_ms=$repeat_ms reason=$reason"
  fi
}

# Baseline 2026-10-20 (exact count, no HNSW), rows with similarity >= 0.25 vs the fixed embedding:
# n8n-pilot=1273, stock-signal-scanner=1067, memory-mcp=45. All exceed MATCH_COUNT=5, so rows==5 holds.
run_case 1 all_global_match_memories_v2 n8n-pilot '{}'
run_case 2 all_global_match_memories_v2 stock-signal-scanner '{}'
run_case 3 all_global_match_memories_v2 null '{}'
run_case 4 all_global_match_memories_v2 memory-mcp '{}'
run_case 5 match_memories_with_links_v2 n8n-pilot '{"follow_links":false}'
run_case 6 match_memories_with_links_v2 n8n-pilot '{"follow_links":true}'

echo "---"
echo "smoke summary: total=$TOTAL passed=$PASSED failed=$FAILED run=$RUN_TS"
[ "$FAILED" -eq 0 ]
