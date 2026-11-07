#!/usr/bin/env bash
# Smoke matrix for OpenLeaf AI collaborator (host localhost API).
# Usage: ./scripts/smoke-ai-collaborator.sh [projectId]
set -euo pipefail
API="${OPENLEAF_API:-http://127.0.0.1:8786}"
PROJ="${1:-example-article}"
PASS=0
FAIL=0
check() {
  local name="$1"; shift
  if "$@"; then echo "PASS  $name"; PASS=$((PASS+1)); else echo "FAIL  $name"; FAIL=$((FAIL+1)); fi
}

curl -sS -X DELETE "$API/api/projects/$PROJ/share?branchId=main" >/dev/null || true

MAIN_BEFORE=$(curl -sS "$API/api/projects/$PROJ/timeline" | python3 -c 'import json,sys; d=json.load(sys.stdin); b=next(x for x in d["branches"] if x["id"]=="main"); n=next(x for x in d["nodes"] if x["id"]==b["headNodeId"]); print(n["gitHash"])')

# AI links do not require a user share.
MINT=$(curl -sS -X POST "$API/api/projects/$PROJ/ai" -H 'Content-Type: application/json' \
  -d '{"branchId":"main","slug":"smoke"}')
TOKEN=$(echo "$MINT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ai"]["token"])')
AI_ID=$(echo "$MINT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ai"]["id"])')
AI_URL=$(echo "$MINT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["aiUrl"])')
AI_BRANCH=$(echo "$MINT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ai"]["branchName"])')
AUTH=(-H "Authorization: Bearer $TOKEN")

check "mint without share" python3 -c "import json,sys; d=json.load(sys.stdin); assert d['ai']['branchName'].startswith('ai/')" <<<"$MINT"

MINT2=$(curl -sS -X POST "$API/api/projects/$PROJ/ai" -H 'Content-Type: application/json' \
  -d '{"branchId":"main","slug":"smoke-b"}')
AI_ID2=$(echo "$MINT2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ai"]["id"])')
AI_BRANCH2=$(echo "$MINT2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ai"]["branchName"])')
check "second AI same leaf" python3 -c "import sys; a=sys.argv[1]; b=sys.argv[2]; assert a.startswith('ai/') and b.startswith('ai/') and a!=b" "$AI_BRANCH" "$AI_BRANCH2"

START=$(curl -sS -X POST "$API/api/projects/$PROJ/share" -H 'Content-Type: application/json' \
  -d '{"branchId":"main","allowMainShare":true,"ttlMinutes":30,"maxIps":3,"maxGuests":3}')
BRANCH=$(echo "$START" | python3 -c 'import json,sys; print(json.load(sys.stdin)["session"]["branchId"])')
check "user share alongside AI" python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('session',{}).get('branchId')=='main'" <<<"$START"

DUP=$(curl -sS -o /tmp/ol-dup-share.json -w '%{http_code}' -X POST "$API/api/projects/$PROJ/share" -H 'Content-Type: application/json' \
  -d '{"branchId":"main","allowMainShare":true,"ttlMinutes":30}')
check "one user link per leaf" test "$DUP" = "409"

check "no query token" python3 -c "import sys; import urllib.request; 
req=urllib.request.Request('$API/api/ai/v1/context?token=$TOKEN');
try:
  urllib.request.urlopen(req); sys.exit(1)
except Exception as e:
  sys.exit(0 if getattr(e,'code',None)==401 else 1)"

curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/apply_patch" \
  --data-binary '{"patches":[{"path":"SMOKE.md","content":"smoke sandbox\nunique-aaa\nunique-aaa\nkeep-me\n"}]}' \
  | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok")'
check "apply_patch" true

EDIT_OK=$(curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/edit" \
  --data-binary '{"path":"SMOKE.md","old":"keep-me","new":"kept"}')
check "edit unique" python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok")' <<<"$EDIT_OK"
curl -sS "${AUTH[@]}" "$API/api/ai/v1/files/SMOKE.md" | python3 -c 'import json,sys; assert "kept" in json.load(sys.stdin)["content"]'
check "edit applied" true

ALIAS=$(curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/edit" \
  --data-binary '{"path":"SMOKE.md","old_string":"kept","new_string":"kept-alias"}')
check "edit old_string alias" python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok")' <<<"$ALIAS"
curl -sS "${AUTH[@]}" "$API/api/ai/v1/files/SMOKE.md" | python3 -c 'import json,sys; assert "kept-alias" in json.load(sys.stdin)["content"]'
check "alias applied" true

# Restore unique token for the 409 check below
curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/edit" \
  --data-binary '{"path":"SMOKE.md","old":"kept-alias","new":"kept"}' >/dev/null

C409=$(curl -sS -o /tmp/ol-edit-nu.json -w '%{http_code}' "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/edit" \
  --data-binary '{"path":"SMOKE.md","old":"unique-aaa","new":"nope"}')
check "edit not unique" test "$C409" = "409"

curl -sS "${AUTH[@]}" "$API/api/ai/v1/files/SMOKE.md?from=1&to=1" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["truncated"] and d["from"]==1'
check "ranged read" true

curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/edit_range" \
  --data-binary '{"path":"SMOKE.md","startLine":"1","endLine":"1","content":"smoke sandbox\n"}' \
  | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok")'
check "edit_range string lines" true

DIFF=$'--- a/SMOKE.md\n+++ b/SMOKE.md\n@@ -1,1 +1,2 @@\n smoke sandbox\n+from-diff\n'
curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/apply_diff" \
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"diff": sys.stdin.read()}))' <<<"$DIFF")" \
  | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok")'
check "apply_diff" true

curl -sS "${AUTH[@]}" "$API/api/ai/v1/review" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["hunkCount"]>=1'
check "ai review pending" true

curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/apply_patch" \
  --data-binary '{"patches":[{"path":"REJECT.md","content":"reject-me\n"}]}' >/dev/null
HOST_REJ=$(curl -sS "$API/api/projects/$PROJ/ai/review")
REJ_ID=$(echo "$HOST_REJ" | python3 -c 'import json,sys
d=json.load(sys.stdin)
files=d["collaborators"][0]["files"]
f=next(x for x in files if x["path"]=="REJECT.md")
print(f["hunks"][0]["id"] if f["hunks"] else "")')
if [ -n "$REJ_ID" ]; then
  curl -sS -X POST "$API/api/projects/$PROJ/ai/$AI_ID/review/reject" -H 'Content-Type: application/json' \
    -d "{\"hunkId\":\"$REJ_ID\"}" >/dev/null
else
  curl -sS -X POST "$API/api/projects/$PROJ/ai/$AI_ID/review/reject" -H 'Content-Type: application/json' \
    -d '{"path":"REJECT.md"}' >/dev/null
fi
REJ_CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/api/ai/v1/files/REJECT.md")
check "host reject restores" test "$REJ_CODE" = "404"

HOST_REV=$(curl -sS "$API/api/projects/$PROJ/ai/review")
check "host review list" python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["hunkCount"]>=1' <<<"$HOST_REV"
HUNK_ID=$(echo "$HOST_REV" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["collaborators"][0]["files"][0]["hunks"][0]["id"])')
curl -sS -X POST "$API/api/projects/$PROJ/ai/$AI_ID/review/accept" -H 'Content-Type: application/json' \
  -d "{\"hunkId\":\"$HUNK_ID\"}" | python3 -c 'import json,sys; json.load(sys.stdin)'
check "host accept hunk" true
curl -sS "${AUTH[@]}" "$API/api/ai/v1/search?q=smoke" | python3 -c 'import json,sys; assert json.load(sys.stdin)["hits"]'
check "search" true
curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API/api/ai/v1/commit" -d '{"message":"smoke"}' \
  | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok")'
check "commit" true
C=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" -H 'Content-Type: application/json' -X PUT "$API/api/ai/v1/files/openleaf.json" -d '{"content":"{}"}')
check "forbid settings write" test "$C" = "403"
MAIN_AFTER=$(curl -sS "$API/api/projects/$PROJ/timeline" | python3 -c 'import json,sys; d=json.load(sys.stdin); b=next(x for x in d["branches"] if x["id"]=="main"); n=next(x for x in d["nodes"] if x["id"]==b["headNodeId"]); print(n["gitHash"])')
check "main untouched" test "$MAIN_BEFORE" = "$MAIN_AFTER"
curl -sS -X DELETE "$API/api/projects/$PROJ/share?branchId=$BRANCH" >/dev/null || true
CTX_AFTER_SHARE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/api/ai/v1/context")
check "AI survives ending user share" test "$CTX_AFTER_SHARE" = "200"
curl -sS -X DELETE "$API/api/projects/$PROJ/ai/$AI_ID" >/dev/null
curl -sS -X DELETE "$API/api/projects/$PROJ/ai/$AI_ID2" >/dev/null || true
R=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/api/ai/v1/context")
check "revoke" test "$R" = "401"
echo "RESULT pass=$PASS fail=$FAIL url_was=$AI_URL"
test "$FAIL" -eq 0
