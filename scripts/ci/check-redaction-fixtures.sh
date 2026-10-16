#!/usr/bin/env bash
# check-redaction-fixtures.sh — exercise the launchd diagnostics redaction
# (scripts/ci/redact-launchd-plist.mjs via scripts/ci/launchd-redaction-check.sh)
# on committed fixtures (flair#2589).
#
# The macOS launchd lane runs the check only when the lane itself fails, so a
# change that broke the scanner (or its ability to load) could stay invisible on
# a long green stretch. This runs on every PR targeting main instead.
#
#   clean/  a redacted plist                 -> reported clean
#   leaky/  a credential key, non-REDACTED   -> reported as a finding, key named
#
# Exit 0 needs a valid empty-findings report; exit 1 needs a valid non-empty
# report. Any mismatch or other outcome fails as could-not-run.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/scripts/ci/redact-fixtures"
# The shared assertion locates the redactor under WORKSPACE.
WORKSPACE="$ROOT"
source "$ROOT/scripts/ci/launchd-redaction-check.sh"

exit_code=0

if assert_no_inline_credentials "$FIXTURES/clean"; then
  echo "clean fixture: passed"
else
  echo "::error::the clean fixture did not pass the redaction check (expected a clean scan)"
  exit_code=1
fi

code=0
out="$(assert_no_inline_credentials "$FIXTURES/leaky" 2>&1)" || code=$?
if [ "$code" -eq 0 ]; then
  echo "::error::the leaky fixture was not reported as a finding"
  printf '%s\n' "$out"
  exit_code=1
elif ! printf '%s\n' "$out" | grep -q "a credential key with a non-REDACTED value"; then
  echo "::error::the leaky fixture was not reported as a credential finding (got a check that could not run)"
  printf '%s\n' "$out"
  exit_code=1
elif ! printf '%s\n' "$out" | grep -q "HDB_ADMIN_PASSWORD"; then
  echo "::error::the leaky fixture finding did not name the credential key"
  printf '%s\n' "$out"
  exit_code=1
elif printf '%s\n' "$out" | grep -q "example-placeholder-not-a-secret"; then
  echo "::error::the finding printed the credential value; findings must name the key only"
  exit_code=1
else
  echo "leaky fixture: reported as a finding (key named, value not printed)"
fi

exit "$exit_code"
