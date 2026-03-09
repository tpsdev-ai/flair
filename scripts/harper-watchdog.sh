#!/bin/bash
# Harper watchdog — detects zombie Harper process (PID alive, HTTP port dead)
# and force-restarts via launchd.
#
# Usage: run via cron or launchd every 60s
#   * * * * * /Users/squeued/ops/flair/scripts/harper-watchdog.sh
#
# Or as a launchd StartInterval job (see ai.tpsdev.flair-watchdog.plist)

HARPER_PORT="${HARPER_PORT:-9926}"
LAUNCHD_LABEL="${LAUNCHD_LABEL:-ai.tpsdev.flair}"
LOG="${HOME}/.tps/logs/harper-watchdog.log"
PLIST="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

# Check if Harper process exists
HARPER_PID=$(pgrep -f "harper.js" 2>/dev/null | head -1)

if [ -z "$HARPER_PID" ]; then
  log "Harper not running — launchd will restart"
  exit 0
fi

# Check if HTTP port is responding
if curl -sf --max-time 3 "http://localhost:${HARPER_PORT}/" -o /dev/null 2>/dev/null; then
  # Healthy — exit quietly
  exit 0
fi

# Port dead but PID alive — zombie state
log "ZOMBIE: Harper PID ${HARPER_PID} alive but port ${HARPER_PORT} dead — force killing"
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
