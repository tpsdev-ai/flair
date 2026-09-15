#!/usr/bin/env bash
# macos-launchd-passfile-missing-check.sh — the fails-first check for
# flair#1685, found by the flair#1684 adopt-then-upgrade lane.
#
# `flair doctor --fix` adopts a detached instance into a launchd job built
# from templates/launchd/start-flair-with-admin-pass.sh. That launcher takes
# the admin-pass file as argv[1] and exits 1 when the file is missing, so a
# plist written while ~/.flair/admin-pass is absent can never start. Port
# health does not reveal that whenever something else still answers the port.
#
# Desired behavior (flair#1685): with the pass file absent, adoption must
# EITHER create the file from the running instance's credential OR refuse
# with actor + state + remedy, and must NOT leave a loadable plist whose
# launcher can never start.
#
# EXPECTED TO FAIL until #1685 lands; that red is the point. It runs as its
# own step after the adopt-then-upgrade lane, against the instance that lane
# already brought up, so it costs no extra install and no extra Harper boot.
#
# Inputs (environment): PORT (default 9926), OPS_PORT (default 9925),
# DIAG_DIR (diagnostics/artifact output dir).
#
# Exits 2 (DID NOT RUN), never 0, when its preconditions are absent — an
# unrunnable check must not read as a pass.

set -Eeuo pipefail

PORT="${PORT:-9926}"
OPS_PORT="${OPS_PORT:-9925}"
WORKSPACE="${GITHUB_WORKSPACE:-$PWD}"
DIAG_DIR="${DIAG_DIR:-$WORKSPACE/diagnostics/launchd-adopt-upgrade}"
PASS_FILE="$HOME/.flair/admin-pass"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
CHECK_LOG="$DIAG_DIR/passfile-missing-doctor.log"

mkdir -p "$DIAG_DIR"

log() { printf '\n=== %s ===\n' "$*"; }

find_plist() {
  local plist
  for plist in "$LAUNCH_AGENTS_DIR"/ai.tpsdev.flair.*.plist; do
    [ -e "$plist" ] || continue
    printf '%s\n' "$plist"
    return 0
  done
  return 1
}

dump_diagnostics() {
  set +e
  echo "::group::pass-file-missing diagnostics"
  echo "--- pass file ---"
  ls -la "$PASS_FILE" 2>/dev/null || echo "(no ${PASS_FILE})"
  echo "--- launchctl list | grep flair ---"
  launchctl list | grep -i flair || echo "(no flair job)"
  echo "--- plists ---"
  for plist in "$LAUNCH_AGENTS_DIR"/ai.tpsdev.flair.*.plist "$LAUNCH_AGENTS_DIR"/ai.tpsdev.flair.*.plist.fails-first-bak; do
    [ -e "$plist" ] || continue
    echo "### $plist"
    cat "$plist"
  done
  echo "--- lsof :$PORT ---"
  lsof -nP -iTCP:"$PORT" 2>/dev/null || echo "(nothing listening on $PORT)"
  echo "--- launchd stderr (tail 60) ---"
  tail -n 60 "$HOME/.flair/data/log/launchd-stderr.log" 2>/dev/null || echo "(no launchd-stderr.log)"
  echo "::endgroup::"
}

fail() {
  echo "::error title=flair#1685 fails-first::$*"
  dump_diagnostics
  exit 1
}

# ── Preconditions: the adopt-then-upgrade lane must have left an instance ──
PLIST="$(find_plist || true)"
if [ -z "$PLIST" ]; then
  echo "::error title=flair#1685 fails-first::DID NOT RUN — no ai.tpsdev.flair.* plist under ${LAUNCH_AGENTS_DIR}"
  exit 2
fi
if [ ! -s "$PASS_FILE" ]; then
  echo "::error title=flair#1685 fails-first::DID NOT RUN — ${PASS_FILE} is already absent, so the removal step proves nothing"
  exit 2
fi
LABEL="$(basename "$PLIST" .plist)"
echo "checking label ${LABEL} with ${PASS_FILE} present"

log "Reproduce the missing-credential repair: unload + remove the plist and pass file (flair#1685)"
# Remove the pass file, then unload the job and move the existing pass-file
# plist aside. This is the load-bearing setup: any pass-file plist found after
# `doctor --fix` was provably written BY `doctor --fix`, not left over from the
# lane. Without this the check would "fail" on the lane's own plist and prove
# nothing. The instance is down at this point, so the running instance cannot
# supply a credential and a clean refusal (desired behavior b) is the outcome
# #1685 can actually deliver.
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PASS_FILE"
mv "$PLIST" "${PLIST}.fails-first-bak"
if [ -e "$PASS_FILE" ] || [ -e "$PLIST" ]; then
  fail "could not clear ${PASS_FILE} / ${PLIST} before the check"
fi

log "Run flair doctor --fix with ${PASS_FILE} absent"
set +e
flair doctor --fix --port "$PORT" 2>&1 | tee "$CHECK_LOG"
DOCTOR_STATUS="${PIPESTATUS[0]}"
set -e
echo "doctor --fix exit: ${DOCTOR_STATUS}"

# (a) Desired: doctor created the file from the running instance's credential.
if [ -s "$PASS_FILE" ]; then
  echo "PASS: doctor --fix created ${PASS_FILE} (flair#1685 desired behavior a)"
  exit 0
fi

# (b) Undesired: doctor --fix wrote a pass-file plist even though the file it
# needs does not exist. This is exactly the defect #1685 names.
if [ -e "$PLIST" ] && grep -q "start-flair-with-admin-pass.sh" "$PLIST"; then
  fail "doctor --fix left a launchd plist (${PLIST}) whose launcher needs ${PASS_FILE}, but did not create it — the job can never start. (flair#1685)"
fi

# (c) Desired: doctor refused, naming actor + state + remedy, and wrote no
# broken plist.
if [ "$DOCTOR_STATUS" -ne 0 ] && grep -qiE "admin-pass|pass-file|flair init" "$CHECK_LOG"; then
  echo "PASS: doctor --fix refused (exit ${DOCTOR_STATUS}) naming the missing credential and a remedy (flair#1685 desired behavior b)"
  exit 0
fi

fail "doctor --fix neither created ${PASS_FILE} nor refused with actor+state+remedy (exit ${DOCTOR_STATUS})"
