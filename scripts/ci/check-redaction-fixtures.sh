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
#   leaky/  a credential key, non-REDACTED   -> reported as a finding
#
# Require the helper's clean (0) and finding (1) statuses respectively;
# could-not-run (2) fails either fixture.
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
if [ "$code" -ne 1 ]; then
  echo "::error::the leaky fixture was not reported as a finding (helper exit ${code})"
  printf '%s\n' "$out"
  exit_code=1
else
  echo "leaky fixture: reported as a finding"
fi

exit "$exit_code"
