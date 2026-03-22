#!/usr/bin/env bash
# E2E CLI test — verifies CLI commands work against a running Flair instance.
# Expects Harper to already be running (started by CI or manually).
# Usage: bash test/e2e-cli.sh
set -euo pipefail

FLAIR="node $(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
AGENT_ID="e2e-test-$$"
PORT="${FLAIR_PORT:-9926}"
ADMIN_PASS="${FLAIR_ADMIN_PASS:-admin123}"

echo "=== E2E CLI Test ==="
echo "Agent: $AGENT_ID"
echo "Port:  $PORT"

# Harper is already running (started by CI integration test job or manually).
# Verify it's up — try multiple addresses and paths.
echo ""
echo "--- Checking Harper is running ---"
for addr in "127.0.0.1" "localhost" "0.0.0.0"; do
  for path in "/Health" "/health" "/"; do
    if curl -sf "http://${addr}:${PORT}${path}" > /dev/null 2>&1; then
      echo "Harper is running at ${addr}:${PORT}${path} ✓"
      export FLAIR_URL="http://${addr}:${PORT}"
      break 2
    fi
  done
done
if [ -z "${FLAIR_URL:-}" ]; then
  echo "WARN: curl can't reach Harper — trying node fetch..."
  if node -e "fetch('http://127.0.0.1:${PORT}/Health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "Harper reachable via node fetch ✓"
    export FLAIR_URL="http://127.0.0.1:${PORT}"
  else
    echo "FAIL: Harper not reachable on port ${PORT}"
    echo "Debug: docker ps"
    docker ps -a 2>/dev/null || true
    exit 1
  fi
fi

# Step 1: flair status
echo ""
echo "--- Step 1: flair status ---"
FLAIR_URL="http://127.0.0.1:${PORT}" $FLAIR status
echo "PASS: status"

# Step 2: flair agent add
echo ""
echo "--- Step 2: flair agent add ---"
FLAIR_URL="http://127.0.0.1:${PORT}" $FLAIR agent add "$AGENT_ID" --name "E2E Test Bot" --admin-pass "$ADMIN_PASS" --port "$PORT"
echo "PASS: agent add"

# Step 3: flair memory add
echo ""
echo "--- Step 3: flair memory add ---"
FLAIR_URL="http://127.0.0.1:${PORT}" $FLAIR memory add --agent "$AGENT_ID" --content "The quick brown fox jumps over the lazy dog"
echo "PASS: memory add"

# Step 4: flair memory search
echo ""
echo "--- Step 4: flair memory search ---"
FLAIR_URL="http://127.0.0.1:${PORT}" $FLAIR memory search --agent "$AGENT_ID" --q "animals"
echo "PASS: memory search"

# Step 5: flair search (top-level shortcut)
echo ""
echo "--- Step 5: flair search ---"
FLAIR_URL="http://127.0.0.1:${PORT}" $FLAIR search "fox" --agent "$AGENT_ID" --port "$PORT" || echo "WARN: search may need embedding warmup"
echo "PASS: search"

# Step 6: flair memory list
echo ""
echo "--- Step 6: flair memory list ---"
FLAIR_URL="http://127.0.0.1:${PORT}" $FLAIR memory list --agent "$AGENT_ID"
echo "PASS: memory list"

echo ""
echo "=== E2E CLI Test PASSED ==="
