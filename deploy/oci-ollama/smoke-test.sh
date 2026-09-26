#!/usr/bin/env bash
# Operator-only test. It never prints OBSERVATORY_AI_AUTH_TOKEN.
set -euo pipefail

: "${OBSERVATORY_AI_BASE_URL:?Set the protected HTTPS inference URL}"
: "${OBSERVATORY_AI_AUTH_TOKEN:?Set the inference bearer token}"
: "${OBSERVATORY_AI_MODEL:?Set the configured Ollama model}"

base_url="${OBSERVATORY_AI_BASE_URL%/}"
auth_header="Authorization: Bearer ${OBSERVATORY_AI_AUTH_TOKEN}"

echo "1/6 Verifying HTTPS endpoint rejects an unauthenticated health request"
unauthenticated_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 5 "${base_url}/api/version")"
test "${unauthenticated_status}" = "401"

echo "2/6 Verifying authenticated provider health"
curl --fail --silent --show-error --connect-timeout 5 -H "${auth_header}" "${base_url}/api/version" | grep -q '"version"'

echo "3/6 Verifying configured model can answer through the protected proxy"
chat_response="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 125 -H "${auth_header}" -H 'content-type: application/json' --data "{\"model\":\"${OBSERVATORY_AI_MODEL}\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK.\"}]}" "${base_url}/api/chat")"
printf '%s' "${chat_response}" | grep -q '"message"'

if [[ -n "${OBSERVATORY_URL:-}" ]]; then
  : "${OBSERVATORY_PROJECT:=homegift}"
  echo "4/6 Verifying Observatory provider health"
  curl --fail --silent --show-error "${OBSERVATORY_URL%/}/api/assistant/health" | grep -q '"status":"reachable"'
  echo "5/6 Verifying a grounded Observatory assistant response"
  curl --fail --silent --show-error -H 'content-type: application/json' --data '{"question":"How much is the platform fee?"}' "${OBSERVATORY_URL%/}/api/projects/${OBSERVATORY_PROJECT}/assistant" | grep -q '"evidence"'
else
  echo "4-5/6 Set OBSERVATORY_URL (and optionally OBSERVATORY_PROJECT) to test Vercel integration."
fi

echo "6/6 Complete. Review the assistant response in the browser for current evidence, sufficiency, and revision."
