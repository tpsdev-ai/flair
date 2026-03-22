#!/bin/bash
# Harper watchdog — detects unhealthy Harper process (PID alive, /Health failing)
# and force-restarts via launchd.
#
# Usage: run via cron or launchd every 60s
#   * * * * * /Users/squeued/ops/flair/scripts/harper-watchdog.sh
#
# Or as a launchd StartInterval job (see ai.tpsdev.flair-watchdog.plist)

HARPER_PORT="${HARPER_PORT:-9926}"
LAUNCHD_LABEL="${LAUNCHD_LABEL:-ai.tpsdev.flair}"
LOG="${HOME}/.tps/logs/harper-watchdog.log"
HEALTH_URL="http://localhost:${HARPER_PORT}/Health"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

# Check if Harper process exists
HARPER_PID=$(pgrep -f "harper.js" 2>/dev/null | head -1)

if [ -z "$HARPER_PID" ]; then
  log "Harper not running — launchd will restart"
  exit 0
fi

# Check the Harper health endpoint directly (embedding deadlock can leave PID alive)
if curl -sf --max-time 5 "$HEALTH_URL" -o /dev/null 2>/dev/null; then
  # Healthy — exit quietly
  exit 0
fi

# Health dead but PID alive — unhealthy/zombie state
log "UNHEALTHY: Harper PID ${HARPER_PID} alive but /Health failed at ${HEALTH_URL} — force killing"
kill -9 "$HARPER_PID" 2>/dev/null

# Let launchd restart it (KeepAlive.Crashed=true)
sleep 2

# Verify launchd restarted it
if pgrep -f "harper.js" > /dev/null 2>&1; then
  log "Restarted by launchd"
else
  # Manually kick launchd if needed
  log "Manually triggering launchd restart"
  launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || \
    launchctl start "${LAUNCHD_LABEL}" 2>/dev/null
fi

log "Watchdog cycle complete"

# --- Stale build detection ---
# Check if dist/ is behind source (origin/main has newer commits)
cd "$HOME/ops/flair" 2>/dev/null || exit 0
git fetch origin main --quiet 2>/dev/null || exit 0
LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse origin/main 2>/dev/null)
if [ "$LOCAL" != "$REMOTE" ]; then
  log "STALE BUILD: local=$LOCAL remote=$REMOTE — running deploy.sh"
  "$HOME/ops/flair/scripts/deploy.sh" 2>&1 || log "Deploy failed — check logs"
fi
