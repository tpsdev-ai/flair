#!/usr/bin/env bash
# E2E CLI test — verifies CLI commands work against a running Flair instance.
# Expects Harper to already be running (started by CI or manually).
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

# Status
echo "--- status ---"
$FLAIR status
echo "PASS: status"

# Agent add
echo "--- agent add ---"
$FLAIR agent add "$AGENT_ID" --name "E2E Bot" --admin-pass "$ADMIN_PASS" --port "$PORT"
echo "PASS: agent add"

# Memory add
echo "--- memory add ---"
$FLAIR memory add --agent "$AGENT_ID" --content "The quick brown fox jumps over the lazy dog"
echo "PASS: memory add"

# Memory search
echo "--- memory search ---"
$FLAIR memory search --agent "$AGENT_ID" --q "animals"
echo "PASS: memory search"

# Memory list
echo "--- memory list ---"
$FLAIR memory list --agent "$AGENT_ID"
echo "PASS: memory list"

echo "=== E2E CLI Test PASSED ==="
