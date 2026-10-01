#!/bin/sh
# start-flair-with-admin-pass.sh — product-owned launchd launcher (flair#1573).
#
# Reads the Flair admin password from a 0600 file and execs Harper
# NON-INTERACTIVELY. The secret never appears in the launchd plist: it enters
# the process environment here, from the file, at start time. This is the
# product shape of the no-inline-secret pattern — the plist's ProgramArguments
# point at this launcher instead of embedding HDB_ADMIN_PASSWORD.
#
# Usage: start-flair-with-admin-pass.sh <admin-pass-file> <node> <harper-bin>
#
#   admin-pass-file  path to the 0600 file holding the admin password
#   node             the node binary to exec
#   harper-bin       Harper's entrypoint (harper.js)
#
# HDB_ADMIN_USERNAME is already in the launchd environment (it is not a
# secret); only the password is read from the file here. HOME, PATH and the
# Harper config (HARPER_SET_CONFIG / ROOTPATH / FLAIR_MODELS_DIR) are also
# supplied by the plist's EnvironmentVariables, so Harper boots without ever
# hitting its interactive readline prompt under launchd's minimal env.

set -eu

ADMIN_PASS_FILE="$1"
NODE="$2"
HARPER_BIN="$3"

# flair#2056: is "$1", a `ps -o command=` line (argv joined by spaces), a Harper
# process? argv[0]'s basename is `node` or `bun`, and argv[1], the script it
# runs, is `…/node_modules/harper/dist/bin/harper.js`,
# `…/node_modules/@<scope>/harper/dist/bin/harper.js` or `dist/bin/harper.js`
# (what Harper's own restart forks). An option before the script, or a Harper
# path in any other position, does not match; nor does a path containing a
# space. The CLI's check is isHarperProcessCommandLine in
# src/lib/daemon-liveness.ts.
is_harper_command() {
  HC_LINE="$1"
  HC_LINE="${HC_LINE#"${HC_LINE%%[! ]*}"}"
  case "$HC_LINE" in *" "*) ;; *) return 1 ;; esac
  HC_EXE="${HC_LINE%% *}"
  HC_REST="${HC_LINE#* }"
  HC_REST="${HC_REST#"${HC_REST%%[! ]*}"}"
  HC_SCRIPT="${HC_REST%% *}"
  case "${HC_EXE##*/}" in node|bun) ;; *) return 1 ;; esac
  case "$HC_SCRIPT" in
    -*) return 1 ;;
    dist/bin/harper.js) return 0 ;;
    */harper/dist/bin/harper.js) ;;
    *) return 1 ;;
  esac
  HC_DIR="${HC_SCRIPT%/harper/dist/bin/harper.js}"
  case "$HC_DIR" in node_modules|*/node_modules) return 0 ;; esac
  HC_SCOPE="${HC_DIR##*/}"
  HC_DIR="${HC_DIR%/*}"
  case "$HC_SCOPE" in @?*) ;; *) return 1 ;; esac
  case "$HC_DIR" in node_modules|*/node_modules) return 0 ;; esac
  return 1
}

# flair#2040 / flair#2056: never start a SECOND instance on a data directory
# that a live Harper process already serves. `kill -0` alone proves only that
# SOME process has the pid: if a direct process dies and leaves hdb.pid behind,
# another process can later get that pid, and a refusal on `kill -0` alone
# would make every KeepAlive retry exit 0 without ever starting Flair.
#
# So the live pid is refused only when `ps -o command=` shows a Harper process
# (is_harper_command above). A flair#1454 sidecar (`flair-daemon.json`) is not
# required: an instance started by a pre-sidecar flair, or the instance this
# launcher execs (Harper writes no sidecar), has none. A sidecar that names a
# different pid, or the same pid with a start time more than 2 s from
# `ps -o lstart=`, means the identity evidence disagrees: the pid is not
# refused, and Harper is exec'd (its own hdb.pid check still applies).
#
# Exit 0 on the refusal: a deliberate no-op, not a crash. KeepAlive retries
# after its throttle interval, and the next attempt starts Harper once the
# direct process has exited.
if [ -n "${ROOTPATH:-}" ] && [ -f "$ROOTPATH/hdb.pid" ]; then
  LIVE_PID="$(tr -cd '0-9' < "$ROOTPATH/hdb.pid" 2>/dev/null || true)"
  if [ -n "$LIVE_PID" ] && [ "$LIVE_PID" != "$$" ] && [ "$LIVE_PID" -gt 1 ] 2>/dev/null && kill -0 "$LIVE_PID" 2>/dev/null; then
    DISAGREE=0
    SIDE="$ROOTPATH/flair-daemon.json"
    if [ -f "$SIDE" ]; then
      SIDE_PID="$(grep -o '"pid"[[:space:]]*:[[:space:]]*[0-9][0-9]*' "$SIDE" 2>/dev/null | grep -o '[0-9][0-9]*$' || true)"
      SIDE_START="$(grep -o '"startTimeMs"[[:space:]]*:[[:space:]]*[0-9][0-9]*' "$SIDE" 2>/dev/null | grep -o '[0-9][0-9]*$' || true)"
      if [ -n "$SIDE_PID" ] && [ -n "$SIDE_START" ]; then
        if [ "$SIDE_PID" != "$LIVE_PID" ]; then
          DISAGREE=1
        else
          LSTART="$(ps -o lstart= -p "$LIVE_PID" 2>/dev/null || true)"
          ACT_S=""
          case "$(uname -s)" in
            Darwin) if [ -n "$LSTART" ]; then ACT_S="$(date -j -f "%a %b %e %T %Y" "$LSTART" +%s 2>/dev/null || true)"; fi ;;
            *)      if [ -n "$LSTART" ]; then ACT_S="$(date -d "$LSTART" +%s 2>/dev/null || true)"; fi ;;
          esac
          if [ -n "$ACT_S" ]; then
            START_S=$((SIDE_START / 1000))
            DIFF=$((ACT_S - START_S))
            if [ "$DIFF" -lt 0 ]; then DIFF=$((0 - DIFF)); fi
            if [ "$DIFF" -gt 2 ]; then DISAGREE=1; fi
          fi
        fi
      fi
    fi
    if [ "$DISAGREE" = "0" ] && is_harper_command "$(ps -o command= -p "$LIVE_PID" 2>/dev/null || true)"; then
      echo "start-flair-with-admin-pass: $ROOTPATH is already served by pid $LIVE_PID (not started by this launchd job); not starting a second instance. launchd retries after its throttle interval and starts Flair once that process has exited." >&2
      exit 0
    fi
  fi
fi

if [ ! -f "$ADMIN_PASS_FILE" ]; then
  echo "start-flair-with-admin-pass: admin-pass file not found: $ADMIN_PASS_FILE" >&2
  exit 1
fi

if [ ! -r "$ADMIN_PASS_FILE" ]; then
  echo "start-flair-with-admin-pass: admin-pass file not readable: $ADMIN_PASS_FILE" >&2
  exit 1
fi

# Re-verify owner-only (0600) at READ time, not just at `flair init` write
# time. A file that drifted to 0644 after init (umask change, backup tool,
# tar restore) would leak the secret to any reader on the host. Mirrors
# readSecretFileSecure (src/lib/auth-resolve.ts), which refuses any group/other
# permission bit. `stat -f %Lp` is macOS (the launchd host); `stat -c %a` is
# Linux (the unit-test host). The two syntaxes are mutually exclusive, so
# branch on the OS rather than chaining with `||` — on Linux `stat -f %Lp`
# prints filesystem info to stdout *and* exits non-zero, which would pollute
# the captured mode. Fail CLOSED: an unreadable mode (empty) refuses rather
# than proceeding on a guess.
case "$(uname -s)" in
  Darwin) MODE="$(stat -f %Lp "$ADMIN_PASS_FILE" 2>/dev/null)" ;;
  *)      MODE="$(stat -c %a "$ADMIN_PASS_FILE" 2>/dev/null)" ;;
esac
case "$MODE" in
  *00) : ;;
  *)
    echo "start-flair-with-admin-pass: admin-pass file permissions '${MODE:-unknown}' are too open (expected 600): $ADMIN_PASS_FILE" >&2
    exit 1
    ;;
esac

# Read the secret. Command substitution strips a trailing newline, which is
# what `flair init` writes (base64url + "\n"); the value itself is preserved
# verbatim by the double quotes.
ADMIN_PASS="$(cat "$ADMIN_PASS_FILE")"
if [ -z "$ADMIN_PASS" ]; then
  echo "start-flair-with-admin-pass: admin-pass file is empty: $ADMIN_PASS_FILE" >&2
  exit 1
fi

export HDB_ADMIN_PASSWORD="$ADMIN_PASS"

# exec (not spawn) so launchd tracks Harper itself — the job's PID is Harper's
# PID, and KeepAlive restarts the real service rather than a dead launcher.
exec "$NODE" "$HARPER_BIN" run .
