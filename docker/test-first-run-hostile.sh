#!/usr/bin/env bash
# test-first-run-hostile.sh — the first-run-hostile guardrail (flair#1460)
#
# Runs as the non-root flairuser inside the container (see
# Dockerfile.first-run-hostile). Reproduces the environment a brand-new user
# actually has, and which every other CI lane accidentally provides:
#   lsof ABSENT, npm global prefix OFF PATH, non-root user.
#
# This script is the detector, not the CI verdict. Each failure is reported
# with the issue it maps to (`FAIL (#1459)`, `FAIL (#1454)`). Exit 0 only
# when no FAIL markers fire; non-zero while any are present. CI applies
# two-way xfail against docker/first-run-hostile.expected.json
# (scripts/ci/first-run-hostile-verdict.mjs, flair#1462) so a known defect
# does not paint every PR red. Deliberately NOT `set -e`: every failure
# must be recorded before the script exits.

set -uo pipefail

PORT="19926"

# Health check via node (curl is not in the minimal base; node is). Returns the
# HTTP status code, or "000" if the daemon is unreachable.
health_code() {
  local port="$1"
  PORT="$port" node -e '
    const http = require("http");
    const req = http.get("http://127.0.0.1:" + process.env.PORT + "/Health", (r) => {
      process.stdout.write(String(r.statusCode));
      process.exit(0);
    });
    req.on("error", () => { process.stdout.write("000"); process.exit(0); });
    req.setTimeout(5000, () => { req.destroy(); process.stdout.write("000"); process.exit(0); });
  '
}
AGENT_ID="mybot"
FLAIR_BIN="$HOME/.npm-global/bin/flair"

FAILURES=0

echo "=============================================="
echo " First-run-hostile gate: no lsof, npm prefix off PATH, non-root"
echo "=============================================="
echo "user:  $(whoami) (uid $(id -u))"
echo "HOME:  $HOME"
echo ""

# ── Assert the hostile conditions are actually hostile ──────────────────────
# If any of these fail, the lane is not testing what it claims and must abort
# (a green lane that never withheld anything proves nothing).

echo "── Asserting hostile conditions ──"

if [ "$(id -u)" = "0" ]; then
  echo "ERROR: running as root — the lane requires a non-root user."
  exit 1
fi
echo "  ✓ non-root user"

if command -v lsof >/dev/null 2>&1; then
  echo "ERROR: lsof is present — the lane requires lsof ABSENT."
  exit 1
fi
echo "  ✓ lsof absent"

PREFIX="$(npm config get prefix)"
if [ "$PREFIX" != "$HOME/.npm-global" ]; then
  echo "ERROR: npm prefix is '$PREFIX', expected '$HOME/.npm-global'."
  exit 1
fi
if echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.npm-global/bin"; then
  echo "ERROR: ~/.npm-global/bin IS on PATH — the lane requires it OFF PATH."
  exit 1
fi
echo "  ✓ npm prefix $PREFIX (off PATH)"
echo ""

# ── #1459: follow README.md to the first working command ─────────────────────
# README Quick start now: `npm install -g @tpsdev-ai/flair` then
# `flair --version` (verify). With the prefix off PATH, the bare `flair` is
# "command not found" — that is the trap the README now documents, and it is the
# evidence the hostile env is real. The README's inline remedy is
# `export PATH="$(npm prefix -g)/bin:$PATH"`, after which `flair --version` must
# succeed. FAIL(#1459) fires only if the trap is absent (env not hostile) or the
# remedy does not produce a working flair.

echo "── #1459: follow README.md to first working command ──"
echo "\$ flair --version (bare, prefix off PATH)"
if VERSION_OUTPUT="$(flair --version 2>&1)"; then
  echo "  FAIL (#1459): bare 'flair --version' succeeded — prefix is on PATH (env not hostile)"
  FAILURES=$((FAILURES + 1))
else
  if echo "$VERSION_OUTPUT" | grep -qi "command not found"; then
    echo "  ✓ 'flair: command not found' — the trap the README now documents"
    echo "\$ export PATH=\"\$(npm prefix -g)/bin:\$PATH\" (README remedy)"
    export PATH="$(npm prefix -g)/bin:$PATH"
    if flair --version >/dev/null 2>&1; then
      echo "  PASS: README remedy works — flair is on PATH (#1459 fixed)"
    else
      echo "  FAIL (#1459): README remedy did not put flair on PATH"
      FAILURES=$((FAILURES + 1))
    fi
  else
    echo "  FAIL (#1459): bare 'flair --version' failed for an unexpected reason:"
    echo "$VERSION_OUTPUT"
    FAILURES=$((FAILURES + 1))
  fi
fi
echo ""

# ── #1454: daemon lifecycle with lsof still absent ───────────────────────────
# Use the full path (the binary IS installed, just off PATH) to reach the
# daemon lifecycle, then `flair stop` must fail to find the live daemon.

echo "── #1454: daemon lifecycle (init → start → stop → status) ──"

echo "\$ $FLAIR_BIN init --agent $AGENT_ID (full path)"
if ! INIT_OUTPUT="$("$FLAIR_BIN" init --agent "$AGENT_ID" --skip-soul --no-mcp 2>&1)"; then
  echo "  ERROR: full-path flair init failed — cannot reach the daemon lifecycle:"
  echo "$INIT_OUTPUT"
  exit 1
fi
echo "  ✓ init succeeded"
echo "$INIT_OUTPUT"
echo ""

echo "\$ $FLAIR_BIN start"
START_OUTPUT="$("$FLAIR_BIN" start 2>&1)" || true
echo "$START_OUTPUT"
echo ""

# Confirm the daemon is actually alive before we ask stop to find it. Without
# this, "not running" would be the correct answer and #1454 would be untested.
HTTP_CODE="$(health_code "$PORT")"
if [ "$HTTP_CODE" != "200" ]; then
  echo "  ERROR: daemon not healthy (HTTP $HTTP_CODE) — cannot test #1454."
  exit 1
fi
echo "  ✓ daemon alive (HTTP $HTTP_CODE on /Health)"
echo ""

echo "\$ $FLAIR_BIN stop"
STOP_OUTPUT="$("$FLAIR_BIN" stop 2>&1)" || true
echo "$STOP_OUTPUT"
# `flair stop` exits 0 even when it prints "Flair is not running." (no
# process.exit on that branch), so detect #1454 via OUTPUT, not exit code.
if echo "$STOP_OUTPUT" | grep -qi "not running"; then
  echo "  FAIL (#1454): flair stop said 'not running' while the daemon is alive — lsof absent"
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS: flair stop actually stopped the daemon (#1454 fixed)"
fi
echo ""

echo "\$ $FLAIR_BIN status"
"$FLAIR_BIN" status 2>&1 || true
echo ""

# ── Report ───────────────────────────────────────────────────────────────────
echo "=============================================="
if [ "$FAILURES" -gt 0 ]; then
  echo "RED: $FAILURES first-run defect(s) still present."
  echo "  #1459: flair off PATH (npm prefix off PATH)"
  echo "  #1454: flair stop cannot find the daemon without lsof"
  echo "=============================================="
  exit 1
else
  echo "GREEN: both #1459 and #1454 are fixed."
  echo "=============================================="
  exit 0
fi
