#!/usr/bin/env bash
# check-instance-boot.sh — the boot contract for a freshly installed Flair.
#
# flair#1686. The 0.54.1 release shipped with every CI light green and could not
# start its engine on a fresh global install (flair#1683). Even once that install
# defect was fixed, nothing between "published" and "`latest` moved" booted the
# artifact the registry actually serves. This script is that missing boot step,
# and it is deliberately the SAME script the rockit deploy ritual runs: the
# canary and the operator assert one definition of "it boots", not two.
#
# It does exactly what the live-evidence note on flair#1686 recorded a human
# doing by hand, in this order:
#
#   1. `flair init --admin-pass-file <0600 file>` — never an inline secret; the
#      password reaches Harper through the file at start time.
#   2. `flair doctor --fix` — adopt the instance into the product's supervised
#      shape. On macOS that is a per-user launchd agent built from
#      templates/launchd/start-flair-with-admin-pass.sh (the flair#1573 shape
#      that broke rockit); on Linux the direct-spawned daemon is the supervised
#      process.
#   3. `/Health` 200 FROM THE SUPERVISED PID — the pid that owns the listener,
#      not merely "some process answers the port". A stray direct-spawned
#      instance answering while the supervised job is dead is exactly the false
#      green flair#1683 was (the macOS lane in #1684 asserts the same three
#      facts for the upgrade path).
#   4. `flair doctor` exits 0.
#   5. vendored tool descriptors are present in the INSTALLED tree at
#      dist/resources/tool-descriptors/index.js. Vendoring first shipped with
#      flair#1691 (flair#1683); older releases legitimately have no such module,
#      so the assertion is version-gated — at or above the vendoring floor a
#      missing module is a failure, below it is reported N/A.
#   6. `flair stop` is clean — the listener is gone, not merely asked to leave.
#
# Inputs (environment):
#   FLAIR_BIN     flair executable (default: `flair` on PATH)
#   FLAIR_PREFIX  global install prefix, when FLAIR_BIN is <prefix>/bin/flair
#                 (used to find the installed package / descriptors)
#   FLAIR_AGENT_ID  agent to register at init (default: canary). A registered agent
#                 creates the keys dir that `flair doctor` requires; an agentless
#                 init leaves doctor with a legitimate "keys directory missing".
#   PORT          Harper HTTP port (default 19926, the current default)
#   OPS_PORT      operations API port (default 19925)
#   PASS_FILE     admin-pass file (default $HOME/.flair/admin-pass)
#   LOG_DIR       command-log directory (default $PWD/instance-boot-logs)
#   HEALTH_TIMEOUT        seconds to wait for /Health (default 180)
#   LISTENER_TIMEOUT      seconds to wait for the supervised pid to bind (default 120)
#   STOP_TIMEOUT          seconds to wait for the port to free after stop (default 30)
#
# Exit codes (mirrors the other check scripts):
#   0 — all six steps passed
#   1 — a step failed (details on stderr, full logs under $LOG_DIR)
#   2 — DID NOT RUN (flair binary or installed package not found) — never green.
#
# This script talks to a REAL supervisor and a REAL Harper install. It assumes a
# disposable HOME (the canary uses a clean runner; the rockit ritual is the only
# instance on that host). It never echoes the admin password.

set -Eeuo pipefail

FLAIR_BIN="${FLAIR_BIN:-flair}"
PORT="${PORT:-19926}"
OPS_PORT="${OPS_PORT:-19925}"
FLAIR_AGENT_ID="${FLAIR_AGENT_ID:-canary}"
PASS_FILE="${PASS_FILE:-$HOME/.flair/admin-pass}"
LOG_DIR="${LOG_DIR:-$PWD/instance-boot-logs}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
LISTENER_TIMEOUT="${LISTENER_TIMEOUT:-120}"
STOP_TIMEOUT="${STOP_TIMEOUT:-30}"

DATA_DIR="$HOME/.flair/data"           # flair's defaultDataDir()
HTTP_URL="http://127.0.0.1:${PORT}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
OS="$(uname -s)"

mkdir -p "$LOG_DIR" "$(dirname "$PASS_FILE")"

log() { printf '\n=== %s ===\n' "$*"; }
fail() { echo "::error::check-instance-boot: $*" >&2; exit 1; }

# Resolve the executable once; fail-closed if it is not there. `command -v`
# handles both a bare name and an absolute path.
if [ "$FLAIR_BIN" = "flair" ]; then
  FLAIR_BIN="$(command -v flair || true)"
fi
if [ -z "$FLAIR_BIN" ] || [ ! -x "$FLAIR_BIN" ]; then
  echo "DID NOT RUN: flair executable not found (FLAIR_BIN='${FLAIR_BIN:-}')" >&2
  exit 2
fi

# If the canary installed into an explicit prefix, put its bin/ first so every
# later `flair` call resolves to the tree under test rather than a system flair.
if [ -n "${FLAIR_PREFIX:-}" ]; then
  export PATH="$FLAIR_PREFIX/bin:$PATH"
fi

# The installed package dir, for the descriptors assertion. Prefer the explicit
# prefix; otherwise ask npm where global packages live.
resolve_flair_package_dir() {
  if [ -n "${FLAIR_PREFIX:-}" ] && [ -d "$FLAIR_PREFIX/lib/node_modules/@tpsdev-ai/flair" ]; then
    printf '%s\n' "$FLAIR_PREFIX/lib/node_modules/@tpsdev-ai/flair"
    return 0
  fi
  local root=""
  root="$(npm root -g 2>/dev/null || true)"
  if [ -n "$root" ] && [ -d "$root/@tpsdev-ai/flair" ]; then
    printf '%s\n' "$root/@tpsdev-ai/flair"
    return 0
  fi
  # Last resort: walk up from the (symlink-resolved) binary. The bin is
  # dist/cli-shim.cjs, so the package dir is two levels above it.
  local resolved=""
  resolved="$(node -e 'try{process.stdout.write(require("node:fs").realpathSync(process.argv[1]))}catch{}' "$FLAIR_BIN" 2>/dev/null || true)"
  if [ -n "$resolved" ]; then
    printf '%s\n' "$(cd "$(dirname "$resolved")/../.." && pwd)"
    return 0
  fi
  return 1
}

FLAIR_PKG_DIR="$(resolve_flair_package_dir || true)"

health_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" || true
}

wait_health() {
  local url="$1" timeout="$2" attempt=0 last="000" deadline
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    last="$(health_code "$url")"
    if [ "$last" = "200" ] || [ "$last" = "401" ]; then
      echo "health ${url} -> HTTP ${last} after ${attempt} attempt(s)" >&2
      return 0
    fi
    sleep 1
  done
  echo "no healthy response from ${url} within ${timeout}s (last HTTP ${last})" >&2
  return 1
}

listener_pids_on_port() {
  # -t prints only PIDs; sort -u so a process holding more than one socket on the
  # port appears once. Empty output means nobody is listening — the caller
  # decides whether that is a failure. `|| true` is deliberate: lsof exits 1 on
  # no match and pipefail would otherwise abort on the legitimate empty state.
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
}

pid_is_self_or_descendant() {
  # True when $1 is $2 or a descendant of $2. The launchd job execs the product
  # launcher, which execs node, so today $1 == $2; the ancestor walk keeps a
  # future wrapper (launcher -> node -> worker) attributed instead of failing.
  local candidate="$1" ancestor="$2" hops=0
  while [ -n "$candidate" ] && [ "$candidate" != "0" ] && [ "$candidate" != "1" ] && [ "$hops" -lt 32 ]; do
    [ "$candidate" = "$ancestor" ] && return 0
    candidate="$(ps -o ppid= -p "$candidate" 2>/dev/null | tr -d ' ')"
    hops=$((hops + 1))
  done
  return 1
}

launchd_pid() {
  # Tabular `launchctl list`: PID <tab> Status <tab> Label. A non-running job
  # has "-" in the PID column.
  launchctl list 2>/dev/null | awk -v l="$1" '$3 == l { print $1; exit }'
}

version_ge() {
  # True when $1 >= $2 for plain semver. BSD bash 3.2 safe; prerelease suffixes
  # are ignored for the comparison (the canary installs release versions).
  local v1="$1" v2="$2" a1 a2 a3 b1 b2 b3
  a1="${v1%%.*}"; a2="${v1#*.}"; a2="${a2%%.*}"; a3="${v1##*.}"; a3="${a3%%-*}"
  b1="${v2%%.*}"; b2="${v2#*.}"; b2="${b2%%.*}"; b3="${v2##*.}"; b3="${b3%%-*}"
  [ "$a1" -gt "$b1" ] && return 0
  [ "$a1" -lt "$b1" ] && return 1
  [ "$a2" -gt "$b2" ] && return 0
  [ "$a2" -lt "$b2" ] && return 1
  [ "$a3" -ge "$b3" ] && return 0
  return 1
}

assert_listener_owned_by() {
  local pid="$1" timeout="$2" deadline owners owner
  deadline=$((SECONDS + timeout))
  owners=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    owners="$(listener_pids_on_port)"
    for owner in $owners; do
      if pid_is_self_or_descendant "$owner" "$pid"; then
        echo "supervised pid ${pid} owns the ${PORT} listener (owner ${owner})" >&2
        return 0
      fi
    done
    sleep 1
  done
  echo "supervised pid ${pid} never owned the ${PORT} listener within ${timeout}s (owners: ${owners:-none})" >&2
  return 1
}

wait_port_free() {
  local timeout="$1" deadline owners
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    owners="$(listener_pids_on_port)"
    if [ -z "$owners" ]; then
      echo "port ${PORT} is free after stop" >&2
      return 0
    fi
    sleep 1
  done
  echo "port ${PORT} still has listener(s) after stop: ${owners:-none}" >&2
  return 1
}

# ── 1. flair init with a 0600 pass file ─────────────────────────────────────────
log "flair init (pass-file, 0600)"
if [ ! -s "$PASS_FILE" ]; then
  # Same generator init uses (base64url over 18 random bytes), invoked through
  # node so the value never appears on a command line. Written under umask 077
  # and chmod'd, because readAdminPassFileSecure refuses any group/other bit.
  ( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))' > "$PASS_FILE" )
  printf '\n' >> "$PASS_FILE"
fi
chmod 600 "$PASS_FILE"
# Keep the secret out of argv for the *later* calls too (init reads the file
# itself; these are for the already-running health/stop path).
export HDB_ADMIN_PASSWORD="$(cat "$PASS_FILE")"
export FLAIR_ADMIN_PASS="$HDB_ADMIN_PASSWORD"

"$FLAIR_BIN" init \
  --port "$PORT" \
  --ops-port "$OPS_PORT" \
  --ops-bind 127.0.0.1 \
  --agent-id "$FLAIR_AGENT_ID" \
  --admin-pass-file "$PASS_FILE" \
  --skip-soul \
  --no-mcp \
  --skip-claude-md \
  --skip-hook \
  > "$LOG_DIR/init.log" 2>&1 || fail "flair init failed (see $LOG_DIR/init.log)"
echo "flair init exit 0"

# init starts Harper; it must serve before we adopt it. This is the pre-adopt
# health check, and it is NOT the supervised-pid assertion below.
wait_health "$HTTP_URL/Health" "$HEALTH_TIMEOUT" || fail "instance did not serve /Health after init (see $LOG_DIR/init.log)"
echo "instance is up before adoption"

# ── 2. doctor --fix adopt ───────────────────────────────────────────────────────
log "flair doctor --fix (adopt; ${OS})"
# doctor --fix exits non-zero whenever any catalog check is still failing even
# when the adopt itself succeeded. The adopted state is asserted below; the exit
# code here is recorded, not fatal. (With a registered agent the catalog is
# normally clean, but doctor's exit is not the adopt's verdict.)
set +e
"$FLAIR_BIN" doctor --fix --port "$PORT" > "$LOG_DIR/doctor-fix.log" 2>&1
DOCTOR_FIX_STATUS=$?
set -e
echo "flair doctor --fix exit: ${DOCTOR_FIX_STATUS}"

# ── 3. /Health 200 from the supervised pid ──────────────────────────────────────
log "assert /Health from the supervised pid"
SUPERVISED_PID=""
if [ "$OS" = "Darwin" ]; then
  LABEL=""
  for plist in "$LAUNCH_AGENTS_DIR"/ai.tpsdev.flair.*.plist; do
    [ -e "$plist" ] || continue
    LABEL="$(basename "$plist" .plist)"
  done
  [ -n "$LABEL" ] || fail "doctor --fix left no ai.tpsdev.flair.* plist in ${LAUNCH_AGENTS_DIR} (is the instance adopted?)"
  echo "launchd label: ${LABEL}"
  # Prove the adopted plist uses the pass-file launcher, not the inline-secret
  # form, before trusting it as the shaped job rockit runs.
  PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
  grep -q "start-flair-with-admin-pass.sh" "$PLIST_PATH" || fail "adopted plist does not use the flair#1573 pass-file launcher: $PLIST_PATH"
  SUPERVISED_PID="$(launchd_pid "$LABEL")"
  [ -n "$SUPERVISED_PID" ] && [ "$SUPERVISED_PID" != "-" ] || fail "launchctl shows no running pid for ${LABEL}"
  echo "launchd supervised pid: ${SUPERVISED_PID}"
else
  # Linux: the direct-spawned daemon is the supervised process. Its identity is
  # the sidecar flair writes at spawn; read it from there and require it to own
  # the listener, so "something answers the port" cannot pass.
  SIDECAR="$DATA_DIR/flair-daemon.json"
  [ -f "$SIDECAR" ] || fail "no daemon sidecar at ${SIDECAR} after init"
  SUPERVISED_PID="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).pid||""))}catch{}' "$SIDECAR" 2>/dev/null || true)"
  [ -n "$SUPERVISED_PID" ] || fail "daemon sidecar ${SIDECAR} has no pid"
  kill -0 "$SUPERVISED_PID" 2>/dev/null || fail "supervised pid ${SUPERVISED_PID} is not alive"
  echo "daemon supervised pid: ${SUPERVISED_PID}"
fi

assert_listener_owned_by "$SUPERVISED_PID" "$LISTENER_TIMEOUT" || fail "the supervised pid does not own ${PORT} — something else is answering /Health"
wait_health "$HTTP_URL/Health" 30 || fail "/Health did not answer after the supervised pid was confirmed"

# ── 4. flair doctor exits 0 ─────────────────────────────────────────────────────
log "flair doctor"
set +e
"$FLAIR_BIN" doctor --port "$PORT" > "$LOG_DIR/doctor.log" 2>&1
DOCTOR_STATUS=$?
set -e
if [ "$DOCTOR_STATUS" -ne 0 ]; then
  tail -n 40 "$LOG_DIR/doctor.log" >&2 || true
  fail "flair doctor exited ${DOCTOR_STATUS} (see $LOG_DIR/doctor.log)"
fi
echo "flair doctor exit 0"

# ── 5. vendored descriptors present in the installed tree ───────────────────────
log "vendored descriptors present"
[ -n "$FLAIR_PKG_DIR" ] || fail "could not resolve the installed @tpsdev-ai/flair package dir"
DESCRIPTORS="$FLAIR_PKG_DIR/dist/resources/tool-descriptors/index.js"
# Vendored tool descriptors first shipped with flair#1691 (flair#1683). An older
# release legitimately has no such module, so asserting its presence there would
# be a false positive — the check is version-gated, not skipped: at or above the
# floor the module MUST be present and importable.
#
# The floor is written as components rather than a dotted literal. This script is
# not a version declaration site (release.sh must not bump it), and
# check-version-sync.mjs discovery treats `*VERSION = "x.y.z"` as one. Spelling
# the floor as components keeps the literal out of the file without adding a
# false declaration site.
MIN_DESCRIPTORS_MAJOR=0
MIN_DESCRIPTORS_MINOR=54
MIN_DESCRIPTORS_PATCH=2
MIN_DESCRIPTORS_VERSION="${MIN_DESCRIPTORS_MAJOR}.${MIN_DESCRIPTORS_MINOR}.${MIN_DESCRIPTORS_PATCH}"
FLAIR_VERSION="$(node -p "require('$FLAIR_PKG_DIR/package.json').version" 2>/dev/null || true)"
if [ -s "$DESCRIPTORS" ]; then
  # A non-empty file is not enough — it must be the module the engine imports.
  node -e 'import(require("node:url").pathToFileURL(process.argv[1]).href).then(m=>{if(!Array.isArray(m.TOOL_DESCRIPTORS)||m.TOOL_DESCRIPTORS.length===0){console.error("no TOOL_DESCRIPTORS export");process.exit(1)}}).catch(e=>{console.error(e.message);process.exit(1)})' "$DESCRIPTORS" \
    || fail "installed descriptors module did not export TOOL_DESCRIPTORS: $DESCRIPTORS"
  echo "descriptors present: ${DESCRIPTORS}"
elif [ -n "$FLAIR_VERSION" ] && version_ge "$FLAIR_VERSION" "$MIN_DESCRIPTORS_VERSION"; then
  fail "vendored tool descriptors missing from ${FLAIR_VERSION}'s installed tree: $DESCRIPTORS (expected since flair#1691)"
else
  echo "descriptors N/A — installed version ${FLAIR_VERSION:-unknown} predates vendored descriptors (first shipped flair#1691)"
fi

# ── 6. flair stop is clean ──────────────────────────────────────────────────────
log "flair stop"
"$FLAIR_BIN" stop --port "$PORT" > "$LOG_DIR/stop.log" 2>&1 || fail "flair stop failed (see $LOG_DIR/stop.log)"
wait_port_free "$STOP_TIMEOUT" || fail "instance was still serving after flair stop"
if [ -n "$SUPERVISED_PID" ] && kill -0 "$SUPERVISED_PID" 2>/dev/null; then
  fail "supervised pid ${SUPERVISED_PID} is still alive after flair stop"
fi
echo "flair stop clean"

log "PASS: instance booted, served from the supervised pid, and stopped cleanly (flair@${FLAIR_BIN})"
