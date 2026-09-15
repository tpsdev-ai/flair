#!/usr/bin/env bash
# macos-launchd-upgrade-lane.sh — the real launchd adopt-then-upgrade lane
# (flair#1671 slice 1, reproducing flair#1683).
#
# What it does, end to end, on a macOS runner:
#
#   1. Installs the previously published Flair globally (the baseline).
#   2. Brings an instance up the product way — `flair init`, then
#      `flair doctor --fix` so the instance runs under a per-user launchd
#      agent built from templates/launchd/start-flair-with-admin-pass.sh
#      (the flair#1573 adoption shape, same as the reported rockit job).
#   3. Asserts the pre-adoption process is gone and the launchd-spawned pid
#      (or a child) owns the 127.0.0.1:9926 listener — not merely that some
#      process answers the port.
#   4. Packs the PR checkout and serves that tarball as the registry's
#      version, then runs `flair upgrade` against it — the exact path that
#      broke production on rockit.
#   5. Asserts a NEW launchd-spawned pid serves /Health with the PR's
#      buildCommit.
#
# On any failure it dumps launchctl/lsof/hdb.log/launchd logs into the
# artifact directory, because the whole point of this lane is to make a
# silent "engine started but nothing serves" failure self-diagnosing.
#
# Inputs (environment):
#   TGZ_PATH            absolute path to the `npm pack` tarball of the PR build
#   PR_VERSION          version inside that tarball (from package.json)
#   PR_COMMIT           the checked-out commit that was built (git rev-parse HEAD)
#   BASELINE_VERSION    previously published version to start from
#   PORT                HTTP port (default 9926)
#   OPS_PORT            operations API port (default 9925)
#   ADMIN_PASS          admin password (default: generated per run)
#   FLAIR_MODELS_DIR    shared embedding-model dir (default: ~/.flair/models)
#   DIAG_DIR            diagnostics/artifact output dir
#
# This script talks to REAL launchd and a REAL Harper install. It assumes a
# disposable runner HOME and must never be pointed at a populated host.

set -Eeuo pipefail

: "${TGZ_PATH:?TGZ_PATH is required}"
: "${PR_VERSION:?PR_VERSION is required}"
: "${PR_COMMIT:?PR_COMMIT is required}"
: "${BASELINE_VERSION:?BASELINE_VERSION is required}"

PORT="${PORT:-9926}"
OPS_PORT="${OPS_PORT:-9925}"
FLAIR_MODELS_DIR="${FLAIR_MODELS_DIR:-$HOME/.flair/models}"
WORKSPACE="${GITHUB_WORKSPACE:-$PWD}"
DIAG_DIR="${DIAG_DIR:-$WORKSPACE/diagnostics/launchd-adopt-upgrade}"
REGISTRY_PORT="${REGISTRY_PORT:-4873}"

DATA_DIR="$HOME/.flair/data"
PASS_FILE="$HOME/.flair/admin-pass"
HTTP_URL="http://127.0.0.1:${PORT}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
REGISTRY_PID=""
BASELINE_PID=""
SERVING_PID=""
LABEL=""

mkdir -p "$DIAG_DIR" "$FLAIR_MODELS_DIR"

# The reported rockit shape. These are the env keys the doctor --fix plist
# carries (HTTP_PORT / OPERATIONSAPI_NETWORK_PORT / NODE_HOSTNAME); we export
# them here so a direct-spawn fallback and the CLI's own port resolution see
# the same values. HARPER_SET_CONFIG is deliberately NOT exported: on this
# shape it is the launchd plist (written by doctor --fix from the instance's
# harper-config.yaml) that supplies it, and exporting a second copy would
# mask whether the plist's own value is what the upgraded server honours.
#
# The admin password is NOT placed in argv: the lane writes it to the 0600
# `~/.flair/admin-pass` and passes only that path to `flair init
# --admin-pass-file`. Passing the password inline makes init skip the file,
# which is not the rockit shape and makes the adopted launchd job fail to
# start. The value reaches later restart/verify calls through the environment
# only, and is never echoed.
export HTTP_PORT="$PORT"
export OPERATIONSAPI_NETWORK_PORT="127.0.0.1:${OPS_PORT}"
export NODE_HOSTNAME="localhost"
export FLAIR_MODELS_DIR

log() { printf '\n=== %s ===\n' "$*"; }

dump_diagnostics() {
  set +e
  echo "::group::launchd lane diagnostics"
  echo "--- env ---"
  echo "PORT=$PORT OPS_PORT=$OPS_PORT PR_VERSION=$PR_VERSION BASELINE_VERSION=$BASELINE_VERSION PR_COMMIT=$PR_COMMIT"
  echo "--- launchctl list | grep flair ---"
  launchctl list | grep -i flair || echo "(no flair job in launchctl list)"
  echo "--- launchd plists ---"
  ls -la "$LAUNCH_AGENTS_DIR" 2>/dev/null || echo "(no LaunchAgents dir)"
  for plist in "$LAUNCH_AGENTS_DIR"/*.plist; do
    [ -e "$plist" ] || continue
    echo "### $plist"
    cat "$plist"
  done
  echo "--- lsof :$PORT ---"
  lsof -nP -iTCP:"$PORT" 2>/dev/null || echo "(nothing listening on $PORT)"
  echo "--- listener pids on :$PORT (lsof -t) ---"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || echo "(no listener pids)"
  echo "--- direct pid recorded before adoption: ${DIRECT_PID:-unset} ---"
  echo "--- lsof :$OPS_PORT ---"
  lsof -nP -iTCP:"$OPS_PORT" 2>/dev/null || echo "(nothing listening on $OPS_PORT)"
  echo "--- hdb.log (tail 200) ---"
  tail -n 200 "$DATA_DIR/log/hdb.log" 2>/dev/null || echo "(no hdb.log)"
  echo "--- launchd stdout (tail 100) ---"
  tail -n 100 "$DATA_DIR/log/launchd-stdout.log" 2>/dev/null || echo "(no launchd-stdout.log)"
  echo "--- launchd stderr (tail 100) ---"
  tail -n 100 "$DATA_DIR/log/launchd-stderr.log" 2>/dev/null || echo "(no launchd-stderr.log)"
  mkdir -p "$DIAG_DIR/data-log"
  cp -f "$DATA_DIR/log/"*.log "$DIAG_DIR/data-log/" 2>/dev/null || true
  cp -f "$DATA_DIR/harper-config.yaml" "$DIAG_DIR/data-harper-config.yaml" 2>/dev/null || true
  cp -f "$HOME/.flair/config.yaml" "$DIAG_DIR/flair-config.yaml" 2>/dev/null || true
  cp -f "$LAUNCH_AGENTS_DIR"/*.plist "$DIAG_DIR/" 2>/dev/null || true
  echo "::endgroup::"
}

extract_symptom() {
  local logfile="$DIAG_DIR/flair-upgrade.log"
  if [ ! -f "$logfile" ]; then
    echo "::warning::no flair-upgrade.log captured"
    return 0
  fi
  echo "::group::flair#1683 symptom excerpt (flair-upgrade.log)"
  grep -nE "Restarting Flair|did not respond within|launchd start failed|Harper at port|Rolling back|rolled back|restart failed|post-restart verification failed" "$logfile" || echo "(no known symptom line found)"
  echo "::endgroup::"
}

on_error() {
  local code=$?
  set +e
  echo "::error::launchd adopt-then-upgrade lane failed (exit ${code})"
  dump_diagnostics
  extract_symptom
  if [ -n "$REGISTRY_PID" ]; then kill "$REGISTRY_PID" 2>/dev/null || true; fi
  exit "$code"
}
trap on_error ERR

launchd_pid() {
  # Tabular `launchctl list`: PID <tab> Status <tab> Label. A non-running job
  # has "-" in the PID column.
  launchctl list 2>/dev/null | awk -v l="$1" '$3 == l { print $1; exit }'
}

wait_health() {
  local url="$1"
  local timeout="${2:-120}"
  local attempt=0
  local last="000"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    attempt=$((attempt + 1))
    last="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)"
    if [ "$last" = "200" ] || [ "$last" = "401" ]; then
      echo "health ${url} -> HTTP ${last} after ${attempt} attempt(s)"
      return 0
    fi
    sleep 1
  done
  echo "no healthy response from ${url} within ${timeout}s (last HTTP ${last})" >&2
  return 1
}

listener_pids_on_port() {
  # -t prints only PIDs. sort -u so a process holding more than one socket on
  # the port appears once. Empty output is "nobody is listening" — the caller
  # decides whether that is a failure, never this helper. `|| true` is
  # deliberate: lsof exits 1 when it matches nothing, and with pipefail that
  # would otherwise abort the caller on the legitimate "no listener yet" state.
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
}

pid_is_self_or_descendant() {
  # True when $1 is $2 or a descendant of $2. The launchd job execs the
  # product launcher, which execs node, so today $1 == $2; the ancestor walk
  # is what lets a future wrapper (launcher -> node -> worker) stay attributed
  # instead of silently failing the ownership check. Bounded to guard against
  # a malformed/cyclic ppid chain.
  local candidate="$1" ancestor="$2" hops=0
  while [ -n "$candidate" ] && [ "$candidate" != "0" ] && [ "$candidate" != "1" ] && [ "$hops" -lt 32 ]; do
    [ "$candidate" = "$ancestor" ] && return 0
    candidate="$(ps -o ppid= -p "$candidate" 2>/dev/null | tr -d ' ')"
    hops=$((hops + 1))
  done
  return 1
}

wait_listener_owned_by() {
  # Poll until $1 (or a descendant) owns the ${PORT} listener. The launchd job
  # needs a moment after `launchctl list` first shows its pid to actually bind,
  # so a single check here would race the start and report a false failure.
  local pid="$1"
  local timeout="${2:-120}"
  local deadline=$((SECONDS + timeout))
  local owner owners
  while (( SECONDS < deadline )); do
    owners="$(listener_pids_on_port)"
    for owner in $owners; do
      if pid_is_self_or_descendant "$owner" "$pid"; then
        echo "launchd pid ${pid} owns the ${PORT} listener (owner ${owner})"
        return 0
      fi
    done
    sleep 1
  done
  echo "launchd pid ${pid} never owned the ${PORT} listener within ${timeout}s (owners: ${owners:-none})" >&2
  return 1
}

assert_bound_by_pid() {
  local pid="$1"
  local label="$2"
  local outfile="$DIAG_DIR/lsof-${label}-${pid}.txt"
  lsof -nP -p "$pid" -iTCP -sTCP:LISTEN > "$outfile" 2>/dev/null || true
  echo "--- $outfile ---"; cat "$outfile"
  if ! grep -Eq "127\\.0\\.0\\.1:${PORT}|\\*:${PORT}|localhost:${PORT}" "$outfile"; then
    echo "pid ${pid} is not listening on port ${PORT}" >&2
    return 1
  fi
}

assert_launchd_serving() {
  # Three independent facts, in order, because port health alone is the signal
  # that lied here (flair#1684 review): the direct-spawned instance answered
  # 9926 the whole time the adopted launchd job was failing to start.
  local label="$1" expectation="$2" predecessor_pid="${3:-}"
  SERVING_PID="$(launchd_pid "$label")"
  if [ -z "$SERVING_PID" ] || [ "$SERVING_PID" = "-" ]; then
    echo "launchctl list shows no running pid for ${label} (${expectation})" >&2
    return 1
  fi
  echo "launchd ${label} pid=${SERVING_PID} (${expectation})" >&2

  # (1) The process that served this port before the bounce must actually be
  # gone. If it is alive, whatever answers health is that process, not launchd.
  if [ -n "$predecessor_pid" ]; then
    if kill -0 "$predecessor_pid" 2>/dev/null; then
      echo "predecessor pid ${predecessor_pid} is STILL ALIVE after ${expectation}; the launchd pid cannot own the port" >&2
      return 1
    fi
    echo "predecessor pid ${predecessor_pid} is gone" >&2
  fi

  # (2) The launchd pid (or a child of it) must OWN the ${PORT} listener. Ask
  # who owns the port — not merely whether the launchd pid has a socket open —
  # because "some process answers 9926" is exactly the false green this guards.
  wait_listener_owned_by "$SERVING_PID" 120

  # (3) Only now does health mean the launchd-owned listener answers.
  wait_health "$HTTP_URL/Health" 120 >&2
  assert_bound_by_pid "$SERVING_PID" "$expectation" >&2
}

log "Tool and version baseline"
echo "sw_vers: $(sw_vers 2>/dev/null | tr '\n' ' ')"
echo "node: $(node --version)  npm: $(npm --version)"
echo "baseline (previous npm-published): @tpsdev-ai/flair@${BASELINE_VERSION}"
echo "PR build under test: @tpsdev-ai/flair@${PR_VERSION} (unpublished tarball ${TGZ_PATH})"
echo "PR commit (built): ${PR_COMMIT}"

log "Install the baseline globally"
npm install -g "@tpsdev-ai/flair@${BASELINE_VERSION}"
echo "installed: $(flair --version 2>&1 | tail -n1)"

log "Bring the instance up the product way (flair init, direct-spawned)"
# Match rockit exactly: the admin password lives in the 0600
# `~/.flair/admin-pass`, and init reads it through `--admin-pass-file` (the
# product's preferred flag). The #1573 pass-file launcher takes that same file
# as argv[1], so the file has to exist BEFORE doctor --fix writes the plist.
# Writing it here (rather than letting init generate it) keeps the secret out
# of argv and out of the logs, and makes the lane's shape the one rockit runs.
ADMIN_PASS="${ADMIN_PASS:-}"
if [ -z "$ADMIN_PASS" ]; then
  # Same generator init uses (base64url over 18 random bytes), invoked through
  # node so the value never appears on a command line anyone can read.
  ADMIN_PASS="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')"
fi
mkdir -p "$HOME/.flair"
# umask 077 + chmod: readAdminPassFileSecure refuses any group/other bit, and
# the launcher re-checks the mode at start time.
( umask 077; printf '%s\n' "$ADMIN_PASS" > "$PASS_FILE" )
chmod 600 "$PASS_FILE"
# init reads the file (passwordSource becomes "file"), so it neither writes
# nor prints the secret. The env vars below are for this lane's own
# restart/verify calls; they are not argv and are never echoed.
unset FLAIR_ADMIN_PASS HDB_ADMIN_PASSWORD
flair init \
  --port "$PORT" \
  --ops-port "$OPS_PORT" \
  --ops-bind 127.0.0.1 \
  --admin-pass-file "$PASS_FILE" \
  --skip-soul \
  --no-mcp
if [ ! -s "$PASS_FILE" ]; then
  echo "admin-pass file ${PASS_FILE} is missing after flair init — the pass-file launcher cannot start" >&2
  exit 1
fi
export HDB_ADMIN_PASSWORD="$ADMIN_PASS"
export FLAIR_ADMIN_PASS="$ADMIN_PASS"
wait_health "$HTTP_URL/Health" 180
echo "instance is up before adoption"

log "Adopt into launchd (flair doctor --fix, flair#1573)"
# Record who owns the port BEFORE adoption. The post-adopt assertion needs the
# concrete pid to prove the direct-spawned process is gone; a bare "something
# answers /Health" is not evidence the launchd job ever started.
DIRECT_PID="$(listener_pids_on_port | head -n1 || true)"
if [ -z "$DIRECT_PID" ]; then
  echo "could not identify the direct-spawned listener on ${PORT} before adoption" >&2
  exit 1
fi
echo "direct-spawned pid before adoption: ${DIRECT_PID}"
# doctor --fix exits non-zero whenever ANY catalog check is still failing (e.g.
# the missing keys dir on an agentless init) even when the launchd adopt itself
# succeeded. The assertion is the adopted state below, not doctor's exit code.
set +e
flair doctor --fix --port "$PORT" 2>&1 | tee "$DIAG_DIR/doctor-fix.log"
DOCTOR_STATUS="${PIPESTATUS[0]}"
set -e
echo "flair doctor --fix exit: ${DOCTOR_STATUS}"

# Resolve the instance-scoped label from the plist doctor --fix just wrote.
LABEL="$(
  for plist in "$LAUNCH_AGENTS_DIR"/ai.tpsdev.flair.*.plist; do
    [ -e "$plist" ] || continue
    basename "$plist" .plist
  done | head -n1
)"
if [ -z "$LABEL" ]; then
  echo "doctor --fix did not leave an ai.tpsdev.flair.* plist in ${LAUNCH_AGENTS_DIR}" >&2
  exit 1
fi
echo "launchd label: ${LABEL}"

assert_launchd_serving "$LABEL" "post-adopt baseline" "$DIRECT_PID"
BASELINE_PID="$SERVING_PID"
echo "baseline launchd pid: ${BASELINE_PID}"

# The pass-file launcher shape is what rockit runs; prove the adopted plist
# actually uses it rather than the inline-secret form.
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
if ! grep -q "start-flair-with-admin-pass.sh" "$PLIST_PATH"; then
  echo "adopted plist does not use the flair#1573 pass-file launcher" >&2
  cat "$PLIST_PATH" >&2
  exit 1
fi

log "Serve the PR's packed build through a local registry"
node "$WORKSPACE/scripts/ci/local-npm-registry.mjs" \
  --port "$REGISTRY_PORT" \
  --package "@tpsdev-ai/flair" \
  --version "$PR_VERSION" \
  --tarball "$TGZ_PATH" \
  --package-json "$WORKSPACE/package.json" \
  > "$DIAG_DIR/registry.out" 2> "$DIAG_DIR/registry.err" &
REGISTRY_PID=$!
for _ in $(seq 1 60); do
  grep -q "^READY " "$DIAG_DIR/registry.out" 2>/dev/null && break
  if ! kill -0 "$REGISTRY_PID" 2>/dev/null; then
    echo "local registry exited before becoming ready" >&2
    cat "$DIAG_DIR/registry.err" >&2
    exit 1
  fi
  sleep 0.5
done
if ! grep -q "^READY " "$DIAG_DIR/registry.out" 2>/dev/null; then
  echo "local registry did not become ready within 30s" >&2
  cat "$DIAG_DIR/registry.err" >&2
  exit 1
fi
cat "$DIAG_DIR/registry.out"
cat "$DIAG_DIR/registry.err" >&2
npm config set "@tpsdev-ai:registry" "http://127.0.0.1:${REGISTRY_PORT}"
echo "npm @tpsdev-ai registry: $(npm config get @tpsdev-ai:registry)"
echo "resolved target via npm: $(npm view '@tpsdev-ai/flair' version)"

log "Upgrade baseline -> PR build (the flair#1683 path)"
flair upgrade 2>&1 | tee "$DIAG_DIR/flair-upgrade.log"

log "Assert the upgraded instance is the PR build, under launchd"
assert_launchd_serving "$LABEL" "post-upgrade" "$BASELINE_PID"
NEW_PID="$SERVING_PID"
if [ "$NEW_PID" = "$BASELINE_PID" ]; then
  echo "upgrade did not produce a new launchd pid (still ${BASELINE_PID})" >&2
  exit 1
fi
echo "post-upgrade launchd pid: ${NEW_PID} (was ${BASELINE_PID})"

HEALTH_JSON="$(curl -fsS "$HTTP_URL/Health")"
BUILD_COMMIT="$(
  printf '%s' "$HEALTH_JSON" | node -e \
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(String(JSON.parse(d).buildCommit??''))}catch{process.stdout.write('')}})"
)"
echo "served buildCommit: ${BUILD_COMMIT}"
if [ "$BUILD_COMMIT" != "$PR_COMMIT" ]; then
  echo "served buildCommit ${BUILD_COMMIT} != built PR commit ${PR_COMMIT}" >&2
  exit 1
fi

log "PASS: launchd adopt-then-upgrade served @tpsdev-ai/flair@${PR_VERSION} (${BUILD_COMMIT}) on ${PORT}"
if [ -n "$REGISTRY_PID" ]; then kill "$REGISTRY_PID" 2>/dev/null || true; fi
