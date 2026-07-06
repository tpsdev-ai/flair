#!/usr/bin/env bash
# E2E CLI test — verifies CLI commands work against a running Flair instance.
set -euo pipefail

FLAIR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if command -v bun > /dev/null 2>&1; then
  FLAIR=(bun "${FLAIR_DIR}/dist/cli.js")
else
  FLAIR=(node "${FLAIR_DIR}/dist/cli.js")
fi

AGENT_ID="e2e-test-$$"
PORT="${FLAIR_PORT:-9926}"
ADMIN_PASS="${FLAIR_ADMIN_PASS:-admin123}"
export FLAIR_URL="http://localhost:${PORT}"

# retry_until <description> <check_fn> <cmd...>
#
# Runs <cmd...> and hands its captured output to <check_fn> as $1, retrying
# on failure. This absorbs eventual-consistency lag between a write and its
# read-visibility in live Harper (indexing/commit lag) — a single immediate
# read after a write is a race, not a guarantee, no matter how long a fixed
# `sleep` before it is. Passes as soon as check_fn succeeds; only fails once
# every attempt is exhausted, dumping the last output for debugging.
#
# Output is captured into a variable rather than piped into the checker
# (e.g. `echo "$out" | grep -q ...`) on purpose: grep -q exits the instant it
# finds a match, closing its end of the pipe while the producer may still be
# writing — the shell then delivers SIGPIPE to the writer ("write error:
# Broken pipe"). Capturing to a variable first and testing that removes the
# concurrent pipe entirely.
#
# Tunable via RETRY_ATTEMPTS (default 10) / RETRY_DELAY seconds (default 1).
retry_until() {
  local description="$1"; shift
  local check_fn="$1"; shift
  local attempts="${RETRY_ATTEMPTS:-10}"
  local delay="${RETRY_DELAY:-1}"
  local output="" attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    output="$("$@" 2>&1)" || true
    if "$check_fn" "$output"; then
      echo "$output"
      echo "PASS: ${description} (attempt ${attempt}/${attempts})"
      return 0
    fi
    [ "$attempt" -lt "$attempts" ] && sleep "$delay"
  done
  echo "FAIL: ${description} — condition not met after ${attempts} attempts (${delay}s apart)"
  echo "--- last output ---"
  echo "$output"
  echo "--- end output ---"
  return 1
}

contains_quick_brown_fox() {
  grep -q "quick brown fox" <<< "$1"
}

has_search_results() {
  ! grep -q '"results":\[\]' <<< "$1"
}

echo "=== E2E CLI Test ==="

# Wait for Harper
for i in $(seq 1 60); do
  if curl -sf -u "admin:${ADMIN_PASS}" "http://localhost:${PORT}/Health" > /dev/null 2>&1; then
    echo "Harper ready (${i}s)"
    break
  fi
  [ "$i" -eq 60 ] && { echo "FAIL: Harper not ready"; docker logs harper-flair 2>&1 | tail -10; exit 1; }
  sleep 1
done

echo "--- status ---"
"${FLAIR[@]}" status
echo "PASS: status"

echo "--- agent add ---"
"${FLAIR[@]}" agent add "$AGENT_ID" --name "E2E Bot" --admin-pass "$ADMIN_PASS" --port "$PORT"
echo "PASS: agent add"

echo "--- memory add ---"
"${FLAIR[@]}" memory add --agent "$AGENT_ID" --content "The quick brown fox jumps over the lazy dog"
echo "PASS: memory add"

echo "--- memory list ---"
retry_until "memory list (content found)" contains_quick_brown_fox \
  "${FLAIR[@]}" memory list --agent "$AGENT_ID"

echo "--- memory search ---"
retry_until "memory search (results returned; empty ⇒ embeddings not generated on write)" has_search_results \
  "${FLAIR[@]}" memory search --agent "$AGENT_ID" --q "animals jumping"

echo "=== E2E CLI Test PASSED ==="
