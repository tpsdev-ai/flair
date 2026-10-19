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

# flair#2056: is "$1", the command line `ps -o command=` reports (arguments
# joined by spaces), Harper-shaped? Its first word's basename is `node` or
# `bun`, and its second word is a Harper entry path:
# `…/node_modules/harper/dist/bin/harper.js`,
# `…/node_modules/@<scope>/harper/dist/bin/harper.js` or `dist/bin/harper.js`
# (what Harper's own restart forks). A second word starting with `-`, or a
# Harper path in a later word, does not match. Because ps joins arguments with
# spaces, this does not establish which argument is the script: an argument
# containing a space can produce a matching line. Nor does it show that the
# process serves anything. The CLI's check is isHarperProcessCommandLine in
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

# A newline, for matching whole lines of multi-line output with `case`.
NL='
'

# flair#2697: the pid Harper itself reads from hdb.pid, when the launcher can
# act on it. Harper's readPidFile is Number.parseInt(<file contents>, 10): it
# skips leading whitespace, takes one leading `+` or `-`, reads decimal digits
# up to the first non-digit, and yields NaN when there is none (`123junk` is
# 123, `junk123` is NaN, `-123` is -123). This prints the pid only when that
# parse is a positive integer of at most 10 digits (leading zeros dropped, so
# shell tests read it as decimal). It prints nothing, leaving the file to
# Harper's own check, for every other file: NaN, zero, a negative value (which
# Harper passes to process.kill, where it names a process group that can be
# alive), more digits than a pid has, a file containing a NUL byte (command
# substitution drops NUL bytes, so the shell would not see what Harper reads),
# and a file with any non-ASCII byte before the digits. The parse runs in a
# subshell with LC_ALL=C, so [:space:] is ASCII whitespace only whatever the
# caller's locale (bash under a UTF-8 locale would otherwise also strip a
# leading no-break space); a leading no-break space or byte-order mark, which
# parseInt skips, therefore yields no pid here.
harper_pid_file_pid() (
  LC_ALL=C
  export LC_ALL
  HP_BYTES="$(wc -c < "$1" 2>/dev/null | tr -cd '0-9')"
  HP_NONUL="$(tr -d '\000' < "$1" 2>/dev/null | wc -c | tr -cd '0-9')"
  if [ -z "$HP_BYTES" ] || [ "$HP_BYTES" != "$HP_NONUL" ]; then exit 0; fi
  HP_RAW="$(cat "$1" 2>/dev/null)" || exit 0
  HP_RAW="${HP_RAW#"${HP_RAW%%[![:space:]]*}"}"
  case "$HP_RAW" in +*) HP_RAW="${HP_RAW#+}" ;; esac
  HP_PID="${HP_RAW%%[!0-9]*}"
  HP_PID="${HP_PID#"${HP_PID%%[!0]*}"}"
  case "$HP_PID" in ""|???????????*) exit 0 ;; esac
  printf '%s\n' "$HP_PID"
)

# flair#2697: is pid "$1" alive the way Harper's isProcessRunning counts it?
# `kill -0` succeeds, or it fails only because the process belongs to another
# user (EPERM), which Harper also counts as running. The shell's `kill` exit
# status does not say which error it hit, so the second case is "ps lists the
# pid".
pid_exists() {
  kill -0 "$1" 2>/dev/null && return 0
  [ -n "$(ps -o pid= -p "$1" 2>/dev/null || true)" ]
}

# flair#2697: is there positive evidence that live pid "$1", whose command line
# as ps reports it is "$2", is NOT this instance? Every condition must hold:
#   - the command line is not empty;
#   - it does not contain `harper`, in any letter case;
#   - it does not contain this instance's ROOTPATH, as given or as its physical
#     path;
#   - one of:
#       - ps reports the process's uid and it is not this launcher's uid (the
#         Harper this launcher starts runs as this launcher's user; lsof
#         cannot list another user's files unless run as root);
#       - same uid, and lsof is not installed;
#       - same uid, and `lsof -p` exits 0 with a listing that includes the
#         process's working directory, and lists no open file (the working
#         directory included) at or under either form of ROOTPATH.
# Anything else, including a failed or empty lsof listing or any failed step
# here, returns 1: the process is treated as possibly this instance. The shape
# check alone is not enough: is_harper_command splits the ps line at spaces, so
# a Harper whose node executable path contains a space is not Harper-shaped,
# yet its command line names harper. On success, UP_WHY holds the clause the
# launcher's message uses for the last condition.
is_unrelated_process() {
  UP_PID="$1"
  UP_LINE="$2"
  UP_WHY=""
  case "$UP_LINE" in *[![:space:]]*) ;; *) return 1 ;; esac
  UP_LOWER="$(printf '%s' "$UP_LINE" | tr '[:upper:]' '[:lower:]')" || return 1
  [ -n "$UP_LOWER" ] || return 1
  case "$UP_LOWER" in *harper*) return 1 ;; esac
  UP_ROOT="${ROOTPATH%/}"
  [ -n "$UP_ROOT" ] || return 1
  UP_PHYS="$(cd -P -- "$ROOTPATH" >/dev/null 2>&1 && pwd -P)" || return 1
  UP_PHYS="${UP_PHYS%/}"
  [ -n "$UP_PHYS" ] || return 1
  case "$UP_LINE" in *"$UP_ROOT"*|*"$UP_PHYS"*) return 1 ;; esac
  UP_UID="$(ps -o uid= -p "$UP_PID" 2>/dev/null)" || return 1
  UP_UID="$(printf '%s' "$UP_UID" | tr -d '[:space:]')" || return 1
  UP_MY_UID="$(id -u 2>/dev/null)" || return 1
  case "$UP_UID" in ""|*[!0-9]*) return 1 ;; esac
  case "$UP_MY_UID" in ""|*[!0-9]*) return 1 ;; esac
  if [ "$UP_UID" != "$UP_MY_UID" ]; then
    UP_WHY="it runs as uid $UP_UID, not as this launcher's uid $UP_MY_UID"
    return 0
  fi
  if ! command -v lsof >/dev/null 2>&1; then
    UP_WHY="lsof is not available to list its open files"
    return 0
  fi
  # -Ffn names both output fields: lsof on Linux prints only the fields named
  # (-Fn alone gives no fd lines, so no `fcwd`), lsof on macOS adds fd lines
  # either way.
  UP_FILES="$(lsof -n -P -w -p "$UP_PID" -Ffn 2>/dev/null)" || return 1
  UP_FILES="$NL$UP_FILES$NL"
  case "$UP_FILES" in *"${NL}fcwd${NL}n/"*) ;; *) return 1 ;; esac
  case "$UP_FILES" in *"${NL}n$UP_ROOT$NL"*|*"${NL}n$UP_ROOT/"*|*"${NL}n$UP_PHYS$NL"*|*"${NL}n$UP_PHYS/"*) return 1 ;; esac
  UP_WHY="lsof lists none of its open files there"
  return 0
}

# flair#2040 / flair#2056: do not start a second Harper on a data directory
# whose hdb.pid names a live process with a Harper-shaped command line (see
# is_harper_command above for what that does and does not establish). That
# some process has the pid proves little: if a direct process dies and leaves
# hdb.pid behind, another process can later get that pid, and a refusal on
# liveness alone would make every KeepAlive retry exit 0 without ever starting
# Flair.
#
# So the launcher refuses only when the command line `ps -o command=` reports
# for the live pid is Harper-shaped. A flair#1454 sidecar
# (`flair-daemon.json`) is not required: an instance started by a pre-sidecar
# flair, or the instance this launcher execs (Harper writes no sidecar), has
# none. A sidecar disagrees when it names a different pid, or a startTimeMs more
# than 2000 ms from the start second `ps -o lstart=` reports (ps reports whole
# seconds, so a process started at 12.9 s is compared as 12 s). When the
# sidecar disagrees, the launcher does not refuse and continues its normal
# start.
#
# Exit 0 on the refusal: a deliberate no-op, not a crash. KeepAlive retries
# after its throttle interval; once that process has exited, a retry does not
# refuse.
#
# flair#2697: at startup Harper exits 4 ("Harper is already running") when the
# pid it reads from hdb.pid is non-zero, is not its own pid or a recognised
# PID-1 init process, and process.kill(pid, 0) succeeds or fails with EPERM.
# The launcher acts only on a positive pid read as Harper reads it
# (harper_pid_file_pid, which yields no pid for every other file) and counts it
# alive as Harper does (pid_exists). When the live pid is not Harper-shaped AND
# is_unrelated_process finds positive evidence that it is not this instance,
# the launcher marks hdb.pid to be moved aside; the move happens below, after
# the admin-pass checks pass and just before the exec. In every other case
# hdb.pid is left in place: a file that yields no pid, a pid that is not alive,
# a Harper-shaped pid (refused here when no sidecar disagrees; with a
# disagreeing sidecar Harper's own check decides, because Harper's own restart
# forks a new main process whose pid the sidecar does not name), and a live pid
# that is not Harper-shaped but may be this instance.
MOVE_PID_FILE=0
if [ -n "${ROOTPATH:-}" ] && [ -f "$ROOTPATH/hdb.pid" ]; then
  LIVE_PID="$(harper_pid_file_pid "$ROOTPATH/hdb.pid")"
  if [ -n "$LIVE_PID" ] && [ "$LIVE_PID" != "$$" ] && [ "$LIVE_PID" -gt 1 ] 2>/dev/null && pid_exists "$LIVE_PID"; then
    DISAGREE=0
    SIDE="$ROOTPATH/flair-daemon.json"
    if [ -f "$SIDE" ]; then
      SIDE_PID="$(grep -o '"pid"[[:space:]]*:[[:space:]]*[0-9][0-9]*' "$SIDE" 2>/dev/null | grep -o '[0-9][0-9]*$' || true)"
      SIDE_START="$(grep -o '"startTimeMs"[[:space:]]*:[[:space:]]*[0-9][0-9]*' "$SIDE" 2>/dev/null | grep -o '[0-9][0-9]*$' || true)"
      # Shell arithmetic reads a leading 0 as octal: drop leading zeros, and
      # leave the sidecar unused when nothing is left or more than 15 digits are.
      SIDE_START="${SIDE_START#"${SIDE_START%%[!0]*}"}"
      case "$SIDE_START" in ????????????????*) SIDE_START="" ;; esac
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
            # Milliseconds against the start second in milliseconds: a start
            # second of 12 s against a sidecar of 14.5 s is 2500 ms.
            DIFF_MS=$((SIDE_START - ACT_S * 1000))
            if [ "$DIFF_MS" -lt 0 ]; then DIFF_MS=$((0 - DIFF_MS)); fi
            if [ "$DIFF_MS" -gt 2000 ]; then DISAGREE=1; fi
          fi
        fi
      fi
    fi
    LIVE_CMD="$(ps -o command= -p "$LIVE_PID" 2>/dev/null || true)"
    if is_harper_command "$LIVE_CMD"; then
      if [ "$DISAGREE" = "0" ]; then
        echo "start-flair-with-admin-pass: $ROOTPATH/hdb.pid names pid $LIVE_PID, whose command line as ps reports it is node or bun followed by a Harper entry path; not starting a second instance. launchd retries after its throttle interval." >&2
        exit 0
      fi
    elif is_unrelated_process "$LIVE_PID" "$LIVE_CMD"; then
      MOVE_PID_FILE=1
      MOVE_WHY="its command line as ps reports it contains neither \"harper\" (in any case) nor this data directory, and $UP_WHY"
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

# flair#2697: move hdb.pid aside (marked above) so Harper's own check does not
# refuse on a live process that is not this instance. The copy is named
# hdb.pid.stale-<epoch seconds>, or .<n> after it when that name is taken when
# checked. The copy is made with `ln -n -P`, which never replaces an existing
# name: -P links hdb.pid itself if it is a symlink, and -n treats a symlink at
# the chosen name as an existing file rather than following it (macOS ln(1):
# "-n Same as -h", "-h If the target_file or target_dir is a symbolic link, do
# not follow it"; GNU coreutils ln: "-n, --no-dereference treat LINK_NAME as a
# normal file if it is a symbolic link to a directory"). So if a file or
# symlink appears at that name meanwhile, `ln` fails. If a real directory
# appears there, `ln` puts the link inside it, and the launcher removes that
# link, checks the removal, and treats the move as failed. The original is
# removed only after a link at the chosen name succeeded; if that removal
# fails, the launcher removes the link again (checked) and treats the move as
# failed. On a failed move the launcher does not remove hdb.pid; it prints one
# line, which also names any link it could not remove, and execs Harper, whose
# own check then decides from whatever hdb.pid is present when it starts.
if [ "$MOVE_PID_FILE" = "1" ]; then
  PID_FILE="$ROOTPATH/hdb.pid"
  STALE_EPOCH="$(date +%s 2>/dev/null || true)"
  STALE_BASE="$ROOTPATH/hdb.pid.stale-${STALE_EPOCH:-unknown}"
  STALE="$STALE_BASE"
  STALE_N=0
  while [ -e "$STALE" ] || [ -L "$STALE" ]; do
    STALE_N=$((STALE_N + 1))
    if [ "$STALE_N" -gt 100 ]; then STALE=""; break; fi
    STALE="$STALE_BASE.$STALE_N"
  done
  MOVED=0
  LEFT_LINK=""
  if [ -n "$STALE" ] && ln -n -P "$PID_FILE" "$STALE" 2>/dev/null; then
    if [ -d "$STALE" ]; then
      LINK="$STALE/hdb.pid"
    elif rm -f "$PID_FILE" 2>/dev/null; then
      MOVED=1
      LINK=""
    else
      LINK="$STALE"
    fi
    if [ -n "$LINK" ]; then
      rm -f "$LINK" 2>/dev/null || true
      if [ -e "$LINK" ] || [ -L "$LINK" ]; then LEFT_LINK="$LINK"; fi
    fi
  fi
  if [ "$MOVED" = "1" ]; then
    echo "start-flair-with-admin-pass: $PID_FILE names pid $LIVE_PID, a live process that is not this instance: $MOVE_WHY; moved hdb.pid to $STALE and starting Harper." >&2
  else
    LEFT_NOTE=""
    if [ -n "$LEFT_LINK" ]; then LEFT_NOTE=" (the link it made at $LEFT_LINK could not be removed)"; fi
    echo "start-flair-with-admin-pass: $PID_FILE names pid $LIVE_PID, a live process that is not this instance: $MOVE_WHY; could not move hdb.pid aside$LEFT_NOTE. Starting Harper, whose own check decides from the hdb.pid present when it starts; if it reports Harper already running, move $PID_FILE out of the way." >&2
  fi
fi

# exec (not spawn) so launchd tracks Harper itself — the job's PID is Harper's
# PID, and KeepAlive restarts the real service rather than a dead launcher.
exec "$NODE" "$HARPER_BIN" run .
