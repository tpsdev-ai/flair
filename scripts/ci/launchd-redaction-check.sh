#!/usr/bin/env bash
# launchd-redaction-check.sh — the "no inline credential reached the output"
# assertion, shared by scripts/ci/macos-launchd-upgrade-lane.sh and its unit
# test (flair#2589). Sourced, not executed.
#
# Expects:
#   WORKSPACE   the checkout root (used to locate the redactor)
#   ADMIN_PASS  optional; the run's own admin password, never printed
#
# Two independent layers:
#   (1) the run's own admin password value must not appear anywhere; and
#   (2) no credential KEY may appear with a value other than REDACTED.
#
# The redactor's --check exit code is authoritative: 0 = ran and found nothing,
# 1 = a finding, 2 = the check could not run. A crash is reported as a crash,
# distinct from a finding; both fail the caller (flair#2589).

assert_no_inline_credentials() {
  local target="$1"
  if [ -n "${ADMIN_PASS:-}" ] && grep -rIlF "$ADMIN_PASS" "$target" >/dev/null 2>&1; then
    echo "::error::the lane's admin password reached the diagnostics output under ${target}"
    return 1
  fi
  local code=0
  # `|| code=$?` keeps a non-zero exit out of the ERR trap's path.
  node "$WORKSPACE/scripts/ci/redact-launchd-plist.mjs" --check "$target" || code=$?
  if [ "$code" -eq 0 ]; then
    return 0
  fi
  if [ "$code" -eq 1 ]; then
    echo "::error::a credential key with a non-REDACTED value reached the diagnostics output under ${target}"
    return 1
  fi
  echo "::error::redaction check could not run (exit ${code}) for ${target}"
  return 1
}
