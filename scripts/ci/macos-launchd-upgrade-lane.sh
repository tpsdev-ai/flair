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

# flair#1688/#1692 shipped the npm registry resolver in 0.54.2. A baseline CLI
# older than that has a HARDCODED registry.npmjs.org update check, so the
# scoped `@tpsdev-ai:registry` config the lane sets never reaches it and
# `flair upgrade` compares the installed version against the public `latest`,
# reports "current", and no-ops. The redirect shim is a test double for that
# pre-resolver update check ONLY; it self-retires the moment the derived
# baseline is at or above 0.54.2, and that run becomes the acceptance test for
# the product resolver (#1692). The PR build's own resolver is never shimmed.
FIRST_RESOLVER_RELEASE="0.54.2"

version_lt() {
  # True when $1 is strictly older than $2 (both x.y.z). BSD bash 3.2 safe,
  # and no IFS tampering (semgrep bash.lang.security.ifs-tampering).
  local v1="$1" v2="$2"
  local a1 a2 a3 b1 b2 b3
  a1="${v1%%.*}"
  a2="${v1#*.}"; a2="${a2%%.*}"
  a3="${v1##*.}"
  b1="${v2%%.*}"
  b2="${v2#*.}"; b2="${b2%%.*}"
  b3="${v2##*.}"
  [ "$a1" -lt "$b1" ] && return 0
  [ "$a1" -gt "$b1" ] && return 1
  [ "$a2" -lt "$b2" ] && return 0
  [ "$a2" -gt "$b2" ] && return 1
  [ "$a3" -lt "$b3" ] && return 0
  return 1
}

if version_lt "$BASELINE_VERSION" "$FIRST_RESOLVER_RELEASE"; then
  BASELINE_NEEDS_SHIM=1
else
  BASELINE_NEEDS_SHIM=0
fi

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
# ops-nv9d slice 2: these are BARE values on purpose. This lane deliberately
# exports a bare port as "the reported rockit shape" and then installs + exercises
# a PUBLISHED BASELINE (pre-parser) CLI. Qualifying HTTP_PORT here would delete
# legacy-input coverage and hand a pre-parser baseline a value it cannot read.
# Legacy bare inputs must keep being ACCEPTED on the way in; qualification is
# asserted at the new bind builder's OUTPUT, not by rewriting this fixture.
export HTTP_PORT="$PORT"
export OPERATIONSAPI_NETWORK_PORT="127.0.0.1:${OPS_PORT}"
export NODE_HOSTNAME="localhost"
export FLAIR_MODELS_DIR

log() { printf '\n=== %s ===\n' "$*"; }

redact_plist() {
  # Print a plist with any inline credential removed (flair#1684 review F1).
  # This repository is PUBLIC and the window between `flair init` (inline
  # plist, flair#1693) and `flair doctor --fix` (pass-file launcher) is exactly
  # when this dump can run, so a raw `cat`/`cp` here would publish the admin
  # password. Never print the raw bytes.
  node "$WORKSPACE/scripts/ci/redact-launchd-plist.mjs" "$@"
}

assert_no_inline_credentials() {
  # Fails-first companion to redact_plist. Two independent layers:
  #   (1) the run's own admin password value must not appear anywhere; and
  #   (2) no credential KEY may appear with a value other than REDACTED. A
  #       *different* credential in a plist is exactly the shape layer (1)
  #       cannot see, and this repository is PUBLIC.
  # The key list lives in the redactor (derived from the product's own
  # secret-key export), so this assertion widens with that list automatically.
  local target="$1"
  if [ -n "${ADMIN_PASS:-}" ] && grep -rIlF "$ADMIN_PASS" "$target" >/dev/null 2>&1; then
    echo "::error::the lane's admin password reached the diagnostics output under ${target}"
    return 1
  fi
  if ! node "$WORKSPACE/scripts/ci/redact-launchd-plist.mjs" --check "$target"; then
    echo "::error::a credential key with a non-REDACTED value reached the diagnostics output under ${target}"
    return 1
  fi
  return 0
}

dump_diagnostics() {
  set +e
  local printed_log
  printed_log="$(mktemp "${TMPDIR:-/tmp}/flair-launchd-lane-log.XXXXXX")"
  # Tee the printed group to a temp log OUTSIDE the artifact dir so the same
  # key-name assertion can run against what actually reached the runner log,
  # not only against the artifact copy.
  {
  echo "::group::launchd lane diagnostics"
  echo "--- env ---"
  echo "PORT=$PORT OPS_PORT=$OPS_PORT PR_VERSION=$PR_VERSION BASELINE_VERSION=$BASELINE_VERSION PR_COMMIT=$PR_COMMIT"
  echo "--- launchctl list | grep flair ---"
  launchctl list | grep -i flair || echo "(no flair job in launchctl list)"
  echo "--- launchd plists (credentials redacted) ---"
  ls -la "$LAUNCH_AGENTS_DIR" 2>/dev/null || echo "(no LaunchAgents dir)"
  for plist in "$LAUNCH_AGENTS_DIR"/*.plist; do
    [ -e "$plist" ] || continue
    echo "### $plist (credentials redacted)"
    redact_plist "$plist"
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
  # Copy plists REDACTED, not raw: the artifact is downloadable from a public
  # repo. Redaction (rather than a skip) keeps the launcher shape diagnosable.
  for plist in "$LAUNCH_AGENTS_DIR"/*.plist; do
    [ -e "$plist" ] || continue
    redact_plist "$plist" > "$DIAG_DIR/$(basename "$plist")"
  done
  echo "::endgroup::"
  } 2>&1 | tee "$printed_log"
  # Scan BOTH sinks: the artifact the diagnostics copied AND the log just
  # printed. A plist printed but not copied would otherwise escape, and vice
  # versa. Findings name keys and files only — never the value.
  if ! assert_no_inline_credentials "$DIAG_DIR"; then
    echo "::error::diagnostics redaction FAILED in the artifact — see the artifact scan above"
  fi
  if ! assert_no_inline_credentials "$printed_log"; then
    echo "::error::diagnostics redaction FAILED in the printed log — see the log scan above"
  fi
  rm -f "$printed_log"
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
# succeeded. The verdict is the adopted state asserted below, not doctor's exit
# code. Tolerate it WITHOUT tripping the ERR trap: a bash ERR trap fires on a
# failing pipeline even under `set +e`, so wrapping this line in set +e / set -e
# let on_error kill the lane before assert_launchd_serving (which waits up to
# 120s and proves the launchd pid owns the port) ever ran. `|| DOCTOR_STATUS=$?`
# puts the pipeline in a `||` list, which the ERR trap does not fire on.
DOCTOR_STATUS=0
flair doctor --fix --port "$PORT" 2>&1 | tee "$DIAG_DIR/doctor-fix.log" || DOCTOR_STATUS=$?
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
  # Redacted: this failure path runs in the flair#1693 window when the plist
  # can still carry the inline admin password (flair#1684 review F1).
  redact_plist "$PLIST_PATH" >&2
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
# flair#1688/#1692 resolution path, declared here and asserted from the log
# after the upgrade. See FIRST_RESOLVER_RELEASE above.
#
# npm writes reify warnings to its debug log even though `flair upgrade` pipes
# the child's stdio (which is why the log, not the tee, is the source for the
# lockfile-warning evidence). Snapshot the log directory so the post-upgrade
# scan only sees this install's logs.
NPM_LOG_DIR="$(npm config get cache 2>/dev/null || true)/_logs"
mkdir -p "$NPM_LOG_DIR"
ls -1 "$NPM_LOG_DIR" 2>/dev/null | sort > "$DIAG_DIR/npm-logs-before.txt" || true

if [ "$BASELINE_NEEDS_SHIM" -eq 1 ]; then
  echo "registry path: SHIM — baseline ${BASELINE_VERSION} < ${FIRST_RESOLVER_RELEASE} (pre-#1688 resolver)"
  echo "  the baseline CLI's update check hardcodes registry.npmjs.org; the CI shim rewrites"
  echo "  @tpsdev-ai/* fetches to http://127.0.0.1:${REGISTRY_PORT}. The PR build's own resolver is not shimmed."
  NODE_OPTIONS="${NODE_OPTIONS:-} --require $WORKSPACE/scripts/ci/redirect-upgrade-registry.cjs" \
    LOCAL_NPM_REGISTRY_URL="http://127.0.0.1:${REGISTRY_PORT}" \
    flair upgrade 2>&1 | tee "$DIAG_DIR/flair-upgrade.log"
else
  echo "registry path: RESOLVER — baseline ${BASELINE_VERSION} >= ${FIRST_RESOLVER_RELEASE} (carries #1688)"
  echo "  the baseline CLI resolves the registry from npm config (expected http://127.0.0.1:${REGISTRY_PORT}); no shim"
  flair upgrade 2>&1 | tee "$DIAG_DIR/flair-upgrade.log"
fi

# Assert which registry the baseline actually consulted, from the upgrade log.
if [ "$BASELINE_NEEDS_SHIM" -eq 1 ]; then
  if ! grep -q 'redirect-upgrade-registry] active' "$DIAG_DIR/flair-upgrade.log"; then
    echo "the redirect shim never activated — the baseline's hardcoded update check could not reach the lane registry" >&2
    exit 1
  fi
  echo "baseline consulted: registry.npmjs.org (hardcoded) -> shim -> http://127.0.0.1:${REGISTRY_PORT}"
else
  if ! grep -q "registry: http://127.0.0.1:${REGISTRY_PORT}" "$DIAG_DIR/flair-upgrade.log"; then
    echo "the baseline resolver did not report the lane registry http://127.0.0.1:${REGISTRY_PORT}" >&2
    grep -n "registry:" "$DIAG_DIR/flair-upgrade.log" >&2 || true
    exit 1
  fi
  echo "baseline consulted: registry reported by the resolver in flair-upgrade.log (see registry: lines)"
fi

log "Verify the upgraded global tree is the healthy PR build (flair#1683 evidence)"
# The task requires evidence the PR build was actually installed, not merely
# that the launchd restart succeeded: `flair --version`, the global tree's
# package count against the reviewed floor, zero reify lockfile warnings from
# the upgrade's own npm log, and a live harper.js. If #1691 regresses, these
# fail here instead of surfacing as a confusing post-restart timeout.
GLOBAL_ROOT="$(npm root -g)"
FLAIR_TREE="$GLOBAL_ROOT/@tpsdev-ai/flair"
HARPER_JS="$FLAIR_TREE/node_modules/harper/dist/bin/harper.js"
[ -e "$HARPER_JS" ] || HARPER_JS="$GLOBAL_ROOT/harper/dist/bin/harper.js"

INSTALLED_VERSION="$(flair --version 2>&1 | tail -n1 | tr -d '[:space:]')"
echo "flair --version: ${INSTALLED_VERSION} (expected ${PR_VERSION})"

PKG_FLOOR="$(node -p "require('${WORKSPACE}/.github/install-weight-budget.json').minPackages")"
# Tolerate a non-zero npm ls (it can fail on a partially-installed global
# tree) without tripping the ERR trap — same reason as the adopt step above:
# `set +e` alone does not stop the ERR trap. The count still comes from the
# pipeline's own output.
PKG_COUNT=0
PKG_COUNT="$(npm ls -g --all --parseable 2>/dev/null | wc -l | tr -d ' ')" || true
echo "global tree packages (npm ls -g --all --parseable): ${PKG_COUNT} (floor ${PKG_FLOOR})"

find "$NPM_LOG_DIR" -maxdepth 1 -name '*.log' -print > "$DIAG_DIR/npm-logs-after.txt" 2>/dev/null || true
LOCKFILE_WARNINGS=0
while IFS= read -r npm_log; do
  [ -e "$npm_log" ] || continue
  if grep -qxF "$(basename "$npm_log")" "$DIAG_DIR/npm-logs-before.txt" 2>/dev/null; then continue; fi
  n="$(grep -c 'invalid or damaged lockfile' "$npm_log" 2>/dev/null || true)"
  LOCKFILE_WARNINGS=$((LOCKFILE_WARNINGS + ${n:-0}))
done < "$DIAG_DIR/npm-logs-after.txt"
echo "invalid or damaged lockfile warnings in the upgrade's npm logs: ${LOCKFILE_WARNINGS}"

# Tolerate a non-zero harper.js version probe without tripping the ERR trap.
HARPER_STATUS=0
HARPER_OUT="$(node "$HARPER_JS" version 2>&1)" || HARPER_STATUS=$?
echo "node harper.js version exit: ${HARPER_STATUS}; output: $(printf '%s' "$HARPER_OUT" | tail -n1)"

if [ "$INSTALLED_VERSION" != "$PR_VERSION" ]; then
  echo "installed flair is ${INSTALLED_VERSION}, expected the PR build ${PR_VERSION}" >&2
  exit 1
fi
if [ "${PKG_COUNT:-0}" -lt "$PKG_FLOOR" ]; then
  echo "global tree has ${PKG_COUNT} packages, below the ${PKG_FLOOR} floor — the install collapsed (flair#1683)" >&2
  exit 1
fi
if [ "$LOCKFILE_WARNINGS" -ne 0 ]; then
  echo "the upgrade's npm log carries ${LOCKFILE_WARNINGS} 'invalid or damaged lockfile' warning(s) (flair#1683)" >&2
  exit 1
fi
if [ "$HARPER_STATUS" -ne 0 ]; then
  echo "node harper.js version exited ${HARPER_STATUS} — the installed engine cannot start (flair#1683)" >&2
  exit 1
fi

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
