#!/usr/bin/env bash
# Smoke matrix for OpenLeaf AI collaborator (host localhost API).
# Usage: ./scripts/smoke-ai-collaborator.sh [projectId]
set -euo pipefail
API="${OPENLEAF_API:-http://127.0.0.1:8787}"
PROJ="${1:-example-article}"
PASS=0
FAIL=0
check() {
  local name="$1"; shift
  if "$@"; then echo "PASS  $name"; PASS=$((PASS+1)); else echo "FAIL  $name"; FAIL=$((FAIL+1)); fi
}

curl -sS -X DELETE "$API/api/projects/$PROJ/share?branchId=main" >/dev/null || true

MAIN_BEFORE=$(curl -sS "$API/api/projects/$PROJ/timeline" | python3 -c 'import json,sys; d=json.load(sys.stdin); b=next(x for x in d["branches"] if x["id"]=="main"); n=next(x for x in d["nodes"] if x["id"]==b["headNodeId"]); print(n["gitHash"])')

START=$(curl -sS -X POST "$API/api/projects/$PROJ/share" -H 'Content-Type: application/json' \
  -d '{"branchId":"main","allowMainShare":true,"ttlMinutes":30,"maxIps":3,"maxGuests":3}')
BRANCH=$(echo "$START" | python3 -c 'import json,sys; print(json.load(sys.stdin)["session"]["branchId"])')
SHARE_URL=$(echo "$START" | python3 -c 'import json,sys; print(json.load(sys.stdin)["session"]["url"])')

MINT=$(curl -sS -X POST "$API/api/projects/$PROJ/share/ai" -H 'Content-Type: application/json' \
  -d "{\"branchId\":\"$BRANCH\",\"slug\":\"smoke\"}")
TOKEN=$(echo "$MINT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ai"]["token"])')
AI_ID=$(echo "$MINT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ai"]["id"])')
AI_URL=$(echo "$MINT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["aiUrl"])')
AUTH=(-H "Authorization: Bearer $TOKEN")

check "mint" python3 -c "import json,sys; d=json.load(sys.stdin); assert d['ai']['branchName'].startswith('ai/')" <<<"$MINT"
check "no query token" python3 -c "import sys; import urllib.request; 
req=urllib.request.Request('$API/api/ai/v1/context?token=$TOKEN');
try:
  urllib.request.urlopen(req); sys.exit(1)
except Exception as e:
  sys.exit(0 if getattr(e,'code',None)==401 else 1)"

curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/apply_patch" \
  --data-binary '{"patches":[{"path":"SMOKE.md","content":"smoke sandbox\n"}]}' \
  | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok")'
check "apply_patch" true
curl -sS "${AUTH[@]}" "$API/api/ai/v1/search?q=smoke" | python3 -c 'import json,sys; assert json.load(sys.stdin)["hits"]'
check "search" true
curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/commit" -d '{"message":"smoke"}' \
  | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok")'
check "commit" true
C=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" -H 'Content-Type: application/json' -X PUT "$API/api/ai/v1/files/openleaf.json" -d '{"content":"{}"}')
check "forbid settings write" test "$C" = "403"
MAIN_AFTER=$(curl -sS "$API/api/projects/$PROJ/timeline" | python3 -c 'import json,sys; d=json.load(sys.stdin); b=next(x for x in d["branches"] if x["id"]=="main"); n=next(x for x in d["nodes"] if x["id"]==b["headNodeId"]); print(n["gitHash"])')
check "main untouched" test "$MAIN_BEFORE" = "$MAIN_AFTER"
curl -sS -X DELETE "$API/api/projects/$PROJ/share/ai/$AI_ID?branchId=$BRANCH" >/dev/null
R=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/api/ai/v1/context")
check "revoke" test "$R" = "401"
curl -sS -X DELETE "$API/api/projects/$PROJ/share?branchId=$BRANCH" >/dev/null
echo "RESULT pass=$PASS fail=$FAIL url_was=$AI_URL"
test "$FAIL" -eq 0
