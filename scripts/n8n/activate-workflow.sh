#!/usr/bin/env bash
# activate-workflow.sh — Activate or deactivate an n8n workflow via the v1 API.
#
# Usage:
#   scripts/n8n/activate-workflow.sh activate  <workflow-id>
#   scripts/n8n/activate-workflow.sh deactivate <workflow-id>
#   scripts/n8n/activate-workflow.sh status     <workflow-id>
#
# Auth: reads N8N_API_KEY from $N8N_API_KEY env var or ~/.n8n/api-key file.
# n8n host defaults to http://127.0.0.1:5678 (override with N8N_HOST).

set -euo pipefail

N8N_HOST="${N8N_HOST:-http://127.0.0.1:5678}"
N8N_API_KEY="${N8N_API_KEY:-}"

# Load API key from file if not in env
if [[ -z "$N8N_API_KEY" && -f "$HOME/.n8n/api-key" ]]; then
  N8N_API_KEY="$(cat "$HOME/.n8n/api-key")"
fi

if [[ -z "$N8N_API_KEY" ]]; then
  echo "Error: N8N_API_KEY not set. Set it via env var or write it to ~/.n8n/api-key" >&2
  echo "See docs/n8n-management.md for key generation." >&2
  exit 1
fi

ACTION="${1:-}"
WORKFLOW_ID="${2:-}"

if [[ -z "$ACTION" || -z "$WORKFLOW_ID" ]]; then
  echo "Usage: $0 {activate|deactivate|status} <workflow-id>" >&2
  exit 1
fi

case "$ACTION" in
  activate)
    ENDPOINT="${N8N_HOST}/api/v1/workflows/${WORKFLOW_ID}/activate"
    METHOD="POST"
    BODY='{}'
    ;;
  deactivate)
    ENDPOINT="${N8N_HOST}/api/v1/workflows/${WORKFLOW_ID}/deactivate"
    METHOD="POST"
    BODY=''
    ;;
  status)
    ENDPOINT="${N8N_HOST}/api/v1/workflows/${WORKFLOW_ID}"
    METHOD="GET"
    BODY=''
    ;;
  *)
    echo "Error: unknown action '$ACTION'. Use activate, deactivate, or status." >&2
    exit 1
    ;;
esac

if [[ -n "$BODY" ]]; then
  RESP=$(curl -s -w "\n%{http_code}" -X "$METHOD" "$ENDPOINT" \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY")
else
  RESP=$(curl -s -w "\n%{http_code}" -X "$METHOD" "$ENDPOINT" \
    -H "X-N8N-API-KEY: $N8N_API_KEY")
fi

HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$HTTP_CODE" != 200 && "$HTTP_CODE" != 204 ]]; then
  echo "Error (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi

if [[ "$ACTION" == "status" ]]; then
  echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('active:', d.get('active','?'), '|', d['name'], '| id:', d['id'])"
else
  echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('$ACTION done:', d['name'], '(id:', d['id'], ') → active:', d.get('active','?'))"
fi
