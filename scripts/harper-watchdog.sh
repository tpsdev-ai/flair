#!/bin/bash
# Harper watchdog — restarts on crash, logs crash context
# Usage: ./harper-watchdog.sh
# Run via launchd or screen for persistence

FLAIR_DIR="${HOME}/ops/flair"
HARPER_DATA="/tmp/harper-flair"
LOG_DIR="${HARPER_DATA}/logs"
CRASH_LOG="${HOME}/ops/shared/HARPER-CRASH-LOG.md"
PORT=9926

mkdir -p "$LOG_DIR"

crash_count=0

while true; do
  timestamp=$(date '+%Y-%m-%d_%H-%M-%S')
  log_file="${LOG_DIR}/harper-${timestamp}.log"
  
  echo "[watchdog] Starting Harper at $(date)" | tee -a "$log_file"
  
  cd "$FLAIR_DIR"
  HARPER_DATA="$HARPER_DATA" node node_modules/harperdb/bin/harper.js dev . >> "$log_file" 2>&1
  exit_code=$?
  
  crash_time=$(date '+%Y-%m-%d %H:%M:%S %Z')
  crash_count=$((crash_count + 1))
  
  echo "[watchdog] Harper exited with code $exit_code at $crash_time (crash #$crash_count)" | tee -a "$log_file"
  
  # Capture last 50 lines for crash context
  tail_log=$(tail -50 "$log_file")
  
  # Append to crash log
  cat >> "$CRASH_LOG" << ENTRY

---

## CRASH-AUTO-${crash_count}: Process exit (code ${exit_code})

**Date:** ${crash_time}
**Harper version:** v5 (pro alpha)
**Host:** $(hostname) ($(uname -s) $(uname -m))
**Flair port:** ${PORT}
**Log file:** ${log_file}

### Exit code
${exit_code}

### Last 50 lines of log
\`\`\`
${tail_log}
\`\`\`

### Status: AUTO-LOGGED (needs human review)
ENTRY

  echo "[watchdog] Crash logged. Restarting in 5 seconds..."
  sleep 5
done
