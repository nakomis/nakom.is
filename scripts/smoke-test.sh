#!/usr/bin/env bash
set -uo pipefail

# Post-deploy smoke test for nakom.is.
#
# Checks the things that have actually broken in the past rather than everything:
#   - the urlShortener redirects (DynamoDB-backed and not)
#   - the CV site rendering rather than serving an S3 error document
#   - the chat lambda reaching Anthropic and returning a response
#
# Usage:
#   ./scripts/smoke-test.sh                 # prod (default)
#   ./scripts/smoke-test.sh --sandbox
#   NPM_ENVIRONMENT=sandbox ./scripts/smoke-test.sh
#   ./scripts/smoke-test.sh --prod --profile some-other-profile
#
# The AWS profile is chosen by environment (nakom.is-admin for prod,
# nakom.is-sandbox for sandbox) and deliberately ignores any AWS_PROFILE
# already set in your shell, since a shell defaulting to sandbox would
# otherwise test prod endpoints with the wrong credentials. Override with
# --profile if you really mean to.
#
# Exits non-zero if any check fails, so it is safe to chain after a deploy.

DEPLOY_ENV="${NPM_ENVIRONMENT:-prod}"
PROFILE_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sandbox) DEPLOY_ENV="sandbox" ;;
    --prod)    DEPLOY_ENV="prod" ;;
    --profile) PROFILE_OVERRIDE="${2:-}"; shift ;;
    -h|--help) sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
  shift
done

case "$DEPLOY_ENV" in
  prod)
    HOST="nakom.is";         CV_HOST="cv.nakomis.com"
    CHAT_FN="nakomis-chat";  DEFAULT_PROFILE="nakom.is-admin" ;;
  sandbox)
    HOST="sandbox.nakom.is"; CV_HOST="cv.sandbox.nakomis.com"
    CHAT_FN="nakomis-chat-sandbox"; DEFAULT_PROFILE="nakom.is-sandbox" ;;
  *)
    echo "ERROR: unknown environment '$DEPLOY_ENV' (expected 'prod' or 'sandbox')" >&2; exit 1 ;;
esac

# The profile is derived from the environment, NOT inherited from the shell.
# A shell defaulting to the sandbox profile would otherwise silently test the
# production endpoints with sandbox credentials, and the chat check would fail
# for a reason that has nothing to do with the deployment. Use --profile to
# override deliberately.
export AWS_PROFILE="${PROFILE_OVERRIDE:-$DEFAULT_PROFILE}"
export AWS_REGION="${AWS_REGION:-eu-west-2}"

PASS=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "Smoke test: $DEPLOY_ENV  (host $HOST, profile $AWS_PROFILE)"
echo

# --- Redirects -------------------------------------------------------------
# /abc goes through DynamoDB and falls back to a Google search when the short
# path is unknown. /catNNN and / never touch DynamoDB, so testing all three
# distinguishes "the table lookup is broken" from "everything is broken".
echo "Redirects"

check_redirect() {
  local path="$1" expect="$2" label="$3"
  local out code loc
  out=$(curl -s -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' "https://${HOST}/${path}" 2>/dev/null)
  code="${out%% *}"; loc="${out#* }"
  if [[ "$code" == "301" && "$loc" == *"$expect"* ]]; then
    ok "/${path:-(root)} -> $loc"
  else
    bad "/${path:-(root)} expected 301 containing '$expect', got $code $loc"
  fi
}

check_redirect "abc"    "google.co.uk/search?q=abc" "google fallback"
check_redirect "cat404" "http.cat/status/404"       "cat easter egg"
check_redirect ""       "$CV_HOST"                  "root"

# --- CV site ---------------------------------------------------------------
echo
echo "CV site"
CV_BODY=$(mktemp)
CV_CODE=$(curl -sL -m 20 "https://${CV_HOST}/" -o "$CV_BODY" -w '%{http_code}' 2>/dev/null)
if [[ "$CV_CODE" != "200" ]]; then
  bad "https://${CV_HOST}/ returned HTTP $CV_CODE"
elif grep -q 'NoSuchKey\|AccessDenied\|<Error>' "$CV_BODY"; then
  bad "https://${CV_HOST}/ served an S3 error document (is social.html deployed?)"
else
  TITLE=$(grep -oiE '<title>[^<]*</title>' "$CV_BODY" | head -1)
  ok "https://${CV_HOST}/ renders ${TITLE:-(no title)}"
fi
rm -f "$CV_BODY"

# --- Chat ------------------------------------------------------------------
echo
echo "Chat"
CHAT_OUT=$(mktemp)
if aws lambda invoke --function-name "$CHAT_FN" \
     --cli-binary-format raw-in-base64-out \
     --payload '{"httpMethod":"POST","body":"{\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word OK\"}]}"}' \
     "$CHAT_OUT" >/dev/null 2>&1; then
  STATUS=$(python3 -c "import json;print(json.load(open('$CHAT_OUT')).get('statusCode'))" 2>/dev/null)
  if [[ "$STATUS" == "200" ]]; then
    LEN=$(python3 -c "import json;print(len(json.load(open('$CHAT_OUT')).get('body') or ''))" 2>/dev/null)
    ok "$CHAT_FN returned 200 (${LEN} byte body)"
  else
    bad "$CHAT_FN returned statusCode $STATUS (placeholder API key, or wrong SSM path?)"
  fi
else
  bad "could not invoke $CHAT_FN (check AWS_PROFILE=$AWS_PROFILE)"
fi
rm -f "$CHAT_OUT"

# --- Result ----------------------------------------------------------------
echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS checks passed."
  exit 0
fi
echo "$FAIL of $((PASS+FAIL)) checks FAILED."
exit 1
