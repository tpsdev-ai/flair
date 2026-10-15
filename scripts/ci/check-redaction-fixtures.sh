#!/usr/bin/env bash
# check-redaction-fixtures.sh — exercise scripts/ci/redact-launchd-plist.mjs
# --check on committed fixtures (flair#2589).
#
# The macOS launchd lane runs --check only when the lane itself fails, so a
# change that broke the scanner (or its ability to load) could stay invisible on
# a long green stretch. This runs on every PR targeting main instead.
#
#   clean/  a redacted plist                 -> --check exits 0
#   leaky/  a credential key, non-REDACTED   -> --check exits 1, naming the key
#
# The finding must name the credential KEY only, never its value.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/ci/redact-launchd-plist.mjs"
FIXTURES="$ROOT/scripts/ci/redact-fixtures"

if ! node "$SCRIPT" --check "$FIXTURES/clean"; then
  echo "::error::the clean fixture did not pass --check (expected exit 0)"
  exit 1
fi
echo "clean fixture: passed"

code=0
out="$(node "$SCRIPT" --check "$FIXTURES/leaky" 2>&1)" || code=$?
if [ "$code" -ne 1 ]; then
  echo "::error::the leaky fixture was not reported as a finding: expected exit 1, got ${code}"
  printf '%s\n' "$out"
  exit 1
fi
if ! printf '%s\n' "$out" | grep -q "unredacted credential key"; then
  echo "::error::the leaky fixture was not reported as an unredacted credential key"
  printf '%s\n' "$out"
  exit 1
fi
if ! printf '%s\n' "$out" | grep -q "HDB_ADMIN_PASSWORD"; then
  echo "::error::the leaky fixture finding did not name the credential key"
  printf '%s\n' "$out"
  exit 1
fi
if printf '%s\n' "$out" | grep -q "example-placeholder-not-a-secret"; then
  echo "::error::the finding printed the credential value; findings must name the key only"
  exit 1
fi
echo "leaky fixture: reported as a finding (key named, value not printed)"
