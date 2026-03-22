#!/bin/bash
# deploy.sh — Pull latest flair, rebuild, verify exports, restart Harper
# Usage: ./scripts/deploy.sh
# Safe to run from cron, watchdog, or manually after merges
set -euo pipefail

FLAIR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${HOME}/.tps/logs/flair-deploy.log"
HARPER_PORT="${HARPER_PORT:-9926}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

cd "$FLAIR_DIR"

# 1. Pull latest
log "Pulling latest from origin/main..."
git fetch origin main 2>&1 | tee -a "$LOG"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  log "Already up to date ($LOCAL). Skipping deploy."
  exit 0
fi

git pull origin main 2>&1 | tee -a "$LOG"
NEW_HEAD=$(git rev-parse --short HEAD)
log "Updated to $NEW_HEAD"

# 2. Install deps
log "Installing dependencies..."
bun install 2>&1 | tee -a "$LOG"

# 3. Build
log "Building dist/..."
npx tsc -p tsconfig.json 2>&1 | tee -a "$LOG"

# 4. Verify critical exports exist in compiled output
log "Verifying exports..."
EXPORTS_OK=true

if ! grep -q "export.*function getEmbedding" dist/resources/embeddings-provider.js 2>/dev/null; then
  log "FATAL: getEmbedding export missing from dist/resources/embeddings-provider.js"
  EXPORTS_OK=false
fi

if ! grep -q "export.*function initEmbeddings" dist/resources/embeddings-provider.js 2>/dev/null; then
  log "FATAL: initEmbeddings export missing from dist/resources/embeddings-provider.js"
  EXPORTS_OK=false
fi

if ! grep -q "export.*function getMode" dist/resources/embeddings-provider.js 2>/dev/null; then
  log "FATAL: getMode export missing from dist/resources/embeddings-provider.js"
  EXPORTS_OK=false
fi

if [ "$EXPORTS_OK" = false ]; then
  log "DEPLOY ABORTED: Critical exports missing. dist/ is broken. Rolling back."
  git checkout "$LOCAL" 2>&1 | tee -a "$LOG"
  npx tsc -p tsconfig.json 2>&1 | tee -a "$LOG"
  exit 1
fi

log "All critical exports verified ✅"

# 5. Restart Harper
log "Restarting Harper..."
HARPER_PID=$(pgrep -f "harper.js" 2>/dev/null | head -1 || true)
if [ -n "$HARPER_PID" ]; then
  kill "$HARPER_PID" 2>/dev/null || true
  sleep 3
fi

# Let launchd restart it, or kick manually
launchctl kickstart -k "gui/$(id -u)/ai.tpsdev.flair" 2>/dev/null || \
  launchctl start "ai.tpsdev.flair" 2>/dev/null || true

# 6. Wait for health
log "Waiting for Harper to become healthy..."
for i in $(seq 1 30); do
  if curl -sf --max-time 5 "http://localhost:${HARPER_PORT}/Health" -o /dev/null 2>/dev/null; then
    log "Harper healthy after ${i}s ✅"
    log "Deploy complete: $NEW_HEAD"
    exit 0
  fi
  # Accept 401 as "running but needs auth" — that's fine
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:${HARPER_PORT}/Health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "401" ]; then
    log "Harper responding (401 auth required) after ${i}s ✅"
    log "Deploy complete: $NEW_HEAD"
    exit 0
  fi
  sleep 1
done

log "WARNING: Harper did not become healthy within 30s. Check manually."
exit 1
