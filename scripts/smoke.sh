#!/bin/sh
# Smoke-test a deployed gateway without invoking Workers AI.
#
# Usage: npm run smoke -- https://<worker>.<subdomain>.workers.dev
#
# GATEWAY_TOKEN is read from .dev.vars and passed to curl on stdin, so it never
# appears in command-line arguments or output. When INFERENCE_ENABLED is "true"
# on the deployment, /v1/responses is skipped because it would run paid inference.

set -u

url=${1:-}
if [ -z "$url" ]; then
  echo "usage: npm run smoke -- <worker-url>" >&2
  exit 2
fi
url=${url%/}

if [ ! -f .dev.vars ]; then
  echo "missing .dev.vars (copy .dev.vars.example first)" >&2
  exit 2
fi
token=$(sed -n 's/^GATEWAY_TOKEN=//p' .dev.vars | tail -n 1)
if [ -z "$token" ]; then
  echo "GATEWAY_TOKEN is not set in .dev.vars" >&2
  exit 2
fi

failures=0

# check <expected-status> <label> <auth: none|bad|good> <curl args...>
check() {
  want=$1
  label=$2
  auth=$3
  shift 3
  case $auth in
    none) header='X-Smoke-Test: 1' ;;
    bad) header='Authorization: Bearer invalid-smoke-test-token-0000000000' ;;
    good) header="Authorization: Bearer $token" ;;
  esac
  result=$(printf '%s\n' "$header" | curl -sS --max-time 30 -H @- -w '\n%{http_code}' "$@")
  status=$(printf '%s\n' "$result" | tail -n 1)
  detail=$(printf '%s\n' "$result" | sed '$d' |
    grep -o '"code":"[a-z_]*"\|"data":\[[^]]*\]\|"models":\[[^]]*\]\|"status":"ok"' | head -n 1)
  if [ "$status" = "$want" ]; then
    mark=OK
  else
    mark=NG
    failures=$((failures + 1))
  fi
  printf '%-3s %-32s expected %s got %s  %s\n' "$mark" "$label" "$want" "$status" "$detail"
}

check 200 'GET /health' none "$url/health"
check 401 'GET /v1/models (no token)' none "$url/v1/models"
check 401 'GET /v1/models (wrong token)' bad "$url/v1/models"
check 200 'GET /v1/models' good "$url/v1/models"
check 200 'GET /v1/models (Codex format)' good "$url/v1/models?client_version=0.0.0"
check 405 'GET /v1/responses (no upgrade)' good "$url/v1/responses"
check 404 'GET /unknown' none "$url/unknown"

models=$(printf 'Authorization: Bearer %s\n' "$token" |
  curl -sS --max-time 30 -H @- "$url/v1/models")
case $models in
  *'"data":[]'*)
    check 503 'POST /v1/responses (disabled)' good -X POST \
      -H 'content-type: application/json' \
      -d '{"model":"glm-5.3","input":"smoke test"}' "$url/v1/responses"
    ;;
  *'"data":['*)
    echo "--  POST /v1/responses               skipped: inference is enabled (would incur charges)"
    ;;
  *)
    echo "--  POST /v1/responses               skipped: could not read /v1/models"
    ;;
esac

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
