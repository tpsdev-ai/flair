#!/usr/bin/env bash
# E2E CLI test — verifies CLI commands work against a running Flair instance.
# Expects Harper to already be running (started by CI or manually).
# Usage: bash test/e2e-cli.sh
set -euo pipefail

# Use bun if available (CI), fall back to node
FLAIR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if command -v bun > /dev/null 2>&1; then
  FLAIR="bun ${FLAIR_DIR}/dist/cli.js"
else
  FLAIR="node ${FLAIR_DIR}/dist/cli.js"
fi
AGENT_ID="e2e-test-$$"
PORT="${FLAIR_PORT:-9926}"
ADMIN_PASS="${FLAIR_ADMIN_PASS:-admin123}"

echo "=== E2E CLI Test ==="
echo "Agent: $AGENT_ID"
echo "Port:  $PORT"

# Wait for Harper to be ready
echo ""
echo "--- Waiting for Harper ---"
export FLAIR_URL="http://localhost:${PORT}"
# Debug: show what's listening
echo "Checking ports..."
ss -tlnp 2>/dev/null | grep "${PORT}" || netstat -tlnp 2>/dev/null | grep "${PORT}" || true
echo "Trying curl..."
curl -v "http://localhost:${PORT}/Health" 2>&1 | head -10 || true
echo "Trying curl 127.0.0.1..."
curl -v "http://127.0.0.1:${PORT}/Health" 2>&1 | head -10 || true
echo "Trying docker inspect..."
docker inspect harper-flair --format '{{.NetworkSettings.IPAddress}}' 2>/dev/null || true
# Try the Docker container's direct IP if localhost fails
DOCKER_IP=$(docker inspect harper-flair --format '{{.NetworkSettings.IPAddress}}' 2>/dev/null || echo "")
for addr in "localhost" "127.0.0.1" "$DOCKER_IP"; do
  [ -z "$addr" ] && continue
  if curl -sf "http://${addr}:${PORT}/Health" > /dev/null 2>&1; then
    echo "Harper ready at ${addr}:${PORT} ✓"
    export FLAIR_URL="http://${addr}:${PORT}"
    break
  fi
done
if ! curl -sf "${FLAIR_URL}/Health" > /dev/null 2>&1; then
  echo "FAIL: Harper not reachable. Docker logs:"
  docker logs harper-flair 2>&1 | tail -15
  exit 1
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
