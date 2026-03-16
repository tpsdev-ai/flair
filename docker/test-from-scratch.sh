#!/usr/bin/env bash
# test-from-scratch.sh — validates the full flair experience from zero
#
# Dumps Harper log on failure for debugging.
trap '
  echo ""
  echo "=== Harper stdout/stderr log ==="
  cat "$HOME/.flair/data/harper.log" 2>/dev/null || echo "(no flair log found)"
  echo "=== HDB log ==="
  find "$HOME" /tmp -name "hdb.log" 2>/dev/null | head -3 | while read f; do echo "--- $f ---"; tail -100 "$f"; done
  echo "=== RUN_HDB_APP check ==="
  echo "config.yaml exists at /app: $(ls -la /app/config.yaml 2>&1)"
  echo "schemas dir: $(ls /app/schemas/ 2>&1)"
  echo "dist/resources: $(ls /app/dist/resources/ 2>&1)"
  echo "=== end ==="
' ERR
#
# Steps:
#   1. flair init --agent-id testbot --admin-pass test123
#   2. flair agent add reviewer --name Reviewer --admin-pass test123
#   3. flair status
#   4. flair backup --admin-pass test123
#   5. Verify backup file exists
#
# Exit 0 on success, 1 on any failure.

set -euo pipefail

FLAIR="node /app/dist/cli.js"
ADMIN_PASS="test123"
PORT="9926"

# Use temp home to keep keys/data isolated
export HOME="$(mktemp -d)"
export FLAIR_KEY_DIR="$HOME/.flair/keys"

echo "=== Flair from-scratch validation ==="
echo "HOME: $HOME"
echo ""

# ── Step 1: flair init ────────────────────────────────────────────────────────
echo "[1/5] flair init --agent-id testbot --admin-pass $ADMIN_PASS --port $PORT"
$FLAIR init \
  --agent-id testbot \
  --admin-pass "$ADMIN_PASS" \
  --port "$PORT" \
  --data-dir "$HOME/.flair/data" \
  --keys-dir "$HOME/.flair/keys"

echo ""
echo "[1/5] ✓ init succeeded"

# ── Step 2: flair agent add ───────────────────────────────────────────────────
echo ""
echo "[2/5] flair agent add reviewer --name Reviewer --admin-pass $ADMIN_PASS"
$FLAIR agent add reviewer \
  --name "Reviewer" \
  --admin-pass "$ADMIN_PASS" \
  --port "$PORT" \
  --keys-dir "$HOME/.flair/keys"

echo ""
echo "[2/5] ✓ agent add succeeded"

# ── Step 3: flair status ──────────────────────────────────────────────────────
echo ""
echo "[3/5] flair status --port $PORT"
STATUS_OUTPUT=$($FLAIR status --port "$PORT")
echo "$STATUS_OUTPUT"

if ! echo "$STATUS_OUTPUT" | grep -q "running"; then
  echo "ERROR: flair status did not report 'running'"
  exit 1
fi
echo ""
echo "[3/5] ✓ status: running"

# ── Step 4: flair backup ──────────────────────────────────────────────────────
echo ""
echo "[4/5] flair backup --admin-pass $ADMIN_PASS --port $PORT"
BACKUP_OUTPUT=$($FLAIR backup \
  --admin-pass "$ADMIN_PASS" \
  --port "$PORT" \
  --output "$HOME/flair-test-backup.json")
echo "$BACKUP_OUTPUT"

# ── Step 5: verify backup file exists ────────────────────────────────────────
echo ""
echo "[5/5] Verifying backup file exists..."
BACKUP_FILE="$HOME/flair-test-backup.json"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: backup file not found at $BACKUP_FILE"
  exit 1
fi

# Validate it's valid JSON with version=1
VERSION=$(node -e "const b=require('$BACKUP_FILE'); process.exit(b.version===1?0:1)" 2>&1 || echo "invalid")
if [ "$VERSION" = "invalid" ]; then
  echo "ERROR: backup file is not valid JSON or version != 1"
  exit 1
fi

AGENT_COUNT=$(node -e "const b=require('$BACKUP_FILE'); console.log(b.agents.length)")
echo "Backup agents: $AGENT_COUNT"

if [ "$AGENT_COUNT" -lt 1 ]; then
  echo "ERROR: backup contains no agents"
  exit 1
fi

echo ""
echo "[5/5] ✓ backup file valid: $BACKUP_FILE"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=============================="
echo "✅ All 5 steps passed"
echo "   Agents in backup: $AGENT_COUNT"
echo "=============================="
