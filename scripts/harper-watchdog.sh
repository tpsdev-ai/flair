#!/bin/bash
# Harper watchdog — keeps prod Flair (:9926) up, recovering BOTH failure modes:
#   (a) PID alive but /Health failing (embedding deadlock / zombie) → kill + kickstart
#   (b) launchd job UNLOADED / no Harper PID (the 2026-06-27 incident)  → bootstrap/load
# and ALERTS on every state transition (down→recovered, or failure-to-recover) so a
# Flair-down is KNOWN rather than found by accident.
#
# INCIDENT (2026-06-27 ~04:20, ops-6nv7): prod Flair was DOWN — the ai.tpsdev.flair
# launchd job was not loaded (no Harper PID). The old watchdog only handled (a):
# `launchctl kickstart -k` / `start` are NO-OPS on an unloaded job, so (b) silently
# went unrecovered, AND there was no alert — the outage was found only when a memory
# write failed. Recovery was a manual `launchctl load ~/Library/LaunchAgents/
# ai.tpsdev.flair.plist`. This script automates both + makes the event loud.
#
# Usage: run via launchd every 60s (see ai.tpsdev.flair-watchdog.plist).
#
# Three cases, by design:
#   1. /Health OK                          → exit silently (clear any prior down-state,
#                                             emitting a RECOVERED alert if we were down)
#   2. /Health dead, job LOADED (PID up)   → kill -9 + kickstart -k → alert on transition
#   3. /Health dead, job UNLOADED (no PID) → launchctl bootstrap (load fallback) → alert

set -u

HARPER_PORT="${HARPER_PORT:-9926}"
LAUNCHD_LABEL="${LAUNCHD_LABEL:-ai.tpsdev.flair}"
LOG="${HOME}/.tps/logs/harper-watchdog.log"
HEALTH_URL="http://localhost:${HARPER_PORT}/Health"

# Alerting: Discord webhook (preferred) → tps mail send flint (fallback) → log+stderr.
# Reuses the house pattern from mail-deliver-health.sh / mail-loop-canary.sh.
WEBHOOK_FILE="${WEBHOOK_FILE:-${HOME}/.tps/secrets/discord-webhook-tps-activity}"
STATE_FILE="${STATE_FILE:-${HOME}/.tps/state/harper-watchdog.state}"  # holds "up" or "down"
TPS_DIR="${TPS_DIR:-${HOME}/ops/tps}"
BUN="${BUN:-${HOME}/.bun/bin/bun}"
TPS_BIN="${TPS_BIN:-${TPS_DIR}/packages/cli/dist/bin/tps.js}"

mkdir -p "$(dirname "$LOG")" "$(dirname "$STATE_FILE")" 2>/dev/null

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

# read/write the up/down state (defaults to "up" on first run).
read_state() { cat "$STATE_FILE" 2>/dev/null || echo "up"; }
write_state() { printf '%s' "$1" > "$STATE_FILE"; }

# alert <message> — fire to webhook → mail → log+stderr. Callers gate on state
# transitions so this is NOT called every 60s tick.
alert() {
  msg="$1"
  log "ALERT: $msg"
  echo "[harper-watchdog ALERT] $msg" >&2
  posted=""
  if [ -f "$WEBHOOK_FILE" ]; then
    WEBHOOK=$(cat "$WEBHOOK_FILE")
    # JSON-escape: the message is controlled here (no quotes/backslashes/newlines).
    if curl -fsS -X POST -H "Content-Type: application/json" \
         -d "{\"content\": \"$msg\"}" "$WEBHOOK" >/dev/null 2>&1; then
      log "alert posted to Discord (#tps-activity webhook)"
      posted="discord"
    else
      log "WARNING: Discord webhook post failed — falling back to tps mail"
    fi
  fi
  if [ -z "$posted" ] && [ -x "$BUN" ] && [ -f "$TPS_BIN" ]; then
    if (cd "$TPS_DIR" && TPS_AGENT_ID=flint "$BUN" run "$TPS_BIN" mail send flint "$msg") >/dev/null 2>&1; then
      log "alert sent via tps mail to flint"
      posted="mail"
    else
      log "WARNING: tps mail send failed"
    fi
  fi
  [ -z "$posted" ] && log "WARNING: no alert channel succeeded — alert is log+stderr only"
}

# is_loaded — true (exit 0) if the launchd job is currently loaded.
is_loaded() {
  launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1 && return 0
  # Fallback for older launchctl: list returns the label if loaded.
  launchctl list 2>/dev/null | grep -qw "${LAUNCHD_LABEL}" && return 0
  return 1
}

# reload_job — bring an UNLOADED job back via bootstrap (load fallback).
# kickstart/start are no-ops on an unloaded job; bootstrap/load is what reloads it.
reload_job() {
  PLIST="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
  if [ ! -f "$PLIST" ]; then
    log "ERROR: plist not found at ${PLIST} — cannot reload"
    return 1
  fi
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>>"$LOG"; then
    log "reloaded job via launchctl bootstrap"
    return 0
  fi
  log "bootstrap failed — trying legacy launchctl load"
  if launchctl load "$PLIST" 2>>"$LOG"; then
    log "reloaded job via launchctl load (fallback)"
    return 0
  fi
  log "ERROR: both bootstrap and load failed to reload ${LAUNCHD_LABEL}"
  return 1
}

PREV_STATE=$(read_state)

# ── CASE 1: healthy ──────────────────────────────────────────────────────────
# /Health responds → Flair is up. If we were previously down, emit a RECOVERED
# alert (down→up transition); otherwise exit silently. No per-tick noise.
if curl -sf --max-time 5 "$HEALTH_URL" -o /dev/null 2>/dev/null; then
  if [ "$PREV_STATE" = "down" ]; then
    write_state "up"
    alert "✅ **Flair (:${HARPER_PORT}) RECOVERED** — /Health responding again. (ops-6nv7 watchdog)"
  fi
  exit 0
fi

# ── Unhealthy: determine which failure mode and recover ──────────────────────
HARPER_PID=$(pgrep -f "harper.js" 2>/dev/null | head -1)
RECOVERY_DESC=""
RECOVERED=1   # 0 = recovery action succeeded, 1 = failed

if [ -n "$HARPER_PID" ]; then
  # ── CASE 2: PID alive but /Health dead — zombie / embedding deadlock ────────
  log "UNHEALTHY: Harper PID ${HARPER_PID} alive but /Health failed at ${HEALTH_URL} — force killing"
  kill -9 "$HARPER_PID" 2>/dev/null
  sleep 2
  if pgrep -f "harper.js" > /dev/null 2>&1; then
    log "Restarted by launchd (KeepAlive.Crashed)"
    RECOVERED=0
  else
    log "Manually triggering launchd restart (kickstart -k)"
    if launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" 2>>"$LOG" || \
       launchctl start "${LAUNCHD_LABEL}" 2>>"$LOG"; then
      RECOVERED=0
    fi
  fi
  RECOVERY_DESC="zombie (PID ${HARPER_PID} alive, /Health dead) → kill -9 + kickstart"
else
  # ── CASE 3: no Harper PID — job is likely UNLOADED (the 2026-06-27 incident) ─
  if is_loaded; then
    # Loaded but no PID: launchd should auto-restart; nudge it.
    log "UNHEALTHY: no Harper PID but job is LOADED — kickstart -k to nudge launchd"
    if launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" 2>>"$LOG"; then
      RECOVERED=0
    fi
    RECOVERY_DESC="no PID, job loaded → kickstart"
  else
    # The incident: job UNLOADED — kickstart/start are no-ops; must bootstrap/load.
    log "UNHEALTHY: no Harper PID and job is UNLOADED — reloading via bootstrap/load"
    if reload_job; then
      RECOVERED=0
    fi
    RECOVERY_DESC="job UNLOADED (the 2026-06-27 down) → launchctl bootstrap/load"
  fi
fi

# Confirm the daemon came back (give it a moment to bind).
sleep 3
if curl -sf --max-time 5 "$HEALTH_URL" -o /dev/null 2>/dev/null; then
  HEALTH_BACK=0
else
  HEALTH_BACK=1
fi

# ── State-transition alerting (non-spammy) ──────────────────────────────────
# Alert when: we transition up→down (first failure-to-recover we acted on),
# OR recovery succeeded. We DO NOT alert on a sustained down state we've already
# announced — only on transitions (use the up/down state file).
if [ "$RECOVERED" -eq 0 ] && [ "$HEALTH_BACK" -eq 0 ]; then
  # Recovery action ran and /Health is back. Mark up so CASE 1 stays quiet.
  if [ "$PREV_STATE" != "up" ]; then
    write_state "up"
    alert "✅ **Flair (:${HARPER_PORT}) RECOVERED by watchdog** — was down: ${RECOVERY_DESC}. /Health responding again. (ops-6nv7)"
  else
    # We were "up", briefly dipped, and self-healed within this tick. Announce the
    # blip once so it's not invisible, then stay up.
    write_state "up"
    alert "⚠️ **Flair (:${HARPER_PORT}) self-healed** — transient outage recovered within one watchdog tick: ${RECOVERY_DESC}. (ops-6nv7)"
  fi
else
  # Either the recovery action failed, OR /Health is still dead after acting.
  # Alert ONLY on the up→down transition (first failure); suppress repeats while down.
  if [ "$PREV_STATE" != "down" ]; then
    write_state "down"
    alert "🚨 **Flair (:${HARPER_PORT}) DOWN** — recovery attempted (${RECOVERY_DESC}) but /Health still failing. Manual intervention may be needed: launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist. Check ${LOG}. (ops-6nv7)"
  else
    log "still DOWN (${RECOVERY_DESC}) — already alerted on transition, suppressing repeat"
  fi
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
