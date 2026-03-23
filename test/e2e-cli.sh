#!/usr/bin/env bash
# E2E CLI test — verifies CLI commands work against a running Flair instance.
set -euo pipefail

FLAIR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if command -v bun > /dev/null 2>&1; then
  FLAIR="bun ${FLAIR_DIR}/dist/cli.js"
else
  FLAIR="node ${FLAIR_DIR}/dist/cli.js"
fi

AGENT_ID="e2e-test-$$"
PORT="${FLAIR_PORT:-9926}"
ADMIN_PASS="${FLAIR_ADMIN_PASS:-admin123}"
export FLAIR_URL="http://localhost:${PORT}"

echo "=== E2E CLI Test ==="

# Wait for Harper
for i in $(seq 1 60); do
  if curl -sf "http://localhost:${PORT}/Health" > /dev/null 2>&1; then
    echo "Harper ready (${i}s)"
    break
  fi
  [ "$i" -eq 60 ] && { echo "FAIL: Harper not ready"; docker logs harper-flair 2>&1 | tail -10; exit 1; }
  sleep 1
done

echo "--- status ---"
$FLAIR status
echo "PASS: status"

echo "--- agent add ---"
$FLAIR agent add "$AGENT_ID" --name "E2E Bot" --admin-pass "$ADMIN_PASS" --port "$PORT"
echo "PASS: agent add"

echo "--- memory add ---"
$FLAIR memory add --agent "$AGENT_ID" --content "The quick brown fox jumps over the lazy dog"
echo "PASS: memory add"

sleep 2

echo "--- memory list ---"
LIST_OUTPUT=$($FLAIR memory list --agent "$AGENT_ID")
echo "$LIST_OUTPUT"
if echo "$LIST_OUTPUT" | grep -q "quick brown fox"; then
  echo "PASS: memory list (content found)"
else
  echo "FAIL: memory list — stored content not found"
  exit 1
fi

echo "--- memory search ---"
SEARCH_OUTPUT=$($FLAIR memory search --agent "$AGENT_ID" --q "animals jumping")
echo "$SEARCH_OUTPUT"
if echo "$SEARCH_OUTPUT" | grep -q '"results":\[\]'; then
  echo "FAIL: memory search — empty results (embeddings not generated on write)"
  exit 1
else
  echo "PASS: memory search (results returned)"
fi

echo "=== E2E CLI Test PASSED ==="
