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
#   (1) the run's own admin password value must not appear in the scanned target
#       (binary content included: the grep has no -I); and
#   (2) no credential KEY in the redactor's list may appear in the supported
#       key/string shape with a value other than REDACTED.
#
# The redactor's --check exit code is authoritative: 0 = ran and found nothing,
# 1 = a finding (its stderr carries a line beginning `redact-launchd-plist:
# unredacted credential key`), 2 = the check could not run. An exit 1 with no
# such marker line is a startup crash, reported as could-not-run — not as a
# finding. A finding and a crash both fail the caller (flair#2589).

# True when the captured redactor output carries a finding-marker line, anchored
# at the start of a line so a Node diagnostic that merely quotes the phrase (a
# syntax error's source line, say) is not read as a finding. Compared with a
# shell pattern, never `... | grep -q`: under `set -o pipefail` a large captured
# output makes grep stop early, SIGPIPEs the producer, and turns a real finding
# into a false "could not run" (flair#2589).
has_finding_marker() {
  case $'\n'"$1" in
    *$'\n'"redact-launchd-plist: unredacted credential key"*) return 0 ;;
    *) return 1 ;;
  esac
}

assert_no_inline_credentials() {
  local target="$1"
  if [ -n "${ADMIN_PASS:-}" ]; then
    local admin_code=0
    # -e and -- so a password that begins with `-` is the pattern, never an
    # option. No -I: grep must scan binary content too, or a password after a
    # NUL byte is missed (flair#2589). grep exits 2 on an error (unreadable
    # target, bad option), which must be a scan FAILURE, never a clean result.
    grep -rlF -e "$ADMIN_PASS" -- "$target" >/dev/null 2>&1 || admin_code=$?
    if [ "$admin_code" -eq 0 ]; then
      echo "::error::the lane's admin password reached the diagnostics output under ${target}"
      return 1
    fi
    if [ "$admin_code" -gt 1 ]; then
      echo "::error::redaction check could not run (grep exit ${admin_code}) for ${target}"
      return 1
    fi
  fi
  local code=0
  local out
  # `|| code=$?` keeps a non-zero exit out of the ERR trap's path.
  out="$(node "$WORKSPACE/scripts/ci/redact-launchd-plist.mjs" --check "$target" 2>&1)" || code=$?
  if [ "$code" -eq 0 ]; then
    return 0
  fi
  # Exit 1 is a finding only when the redactor printed its finding marker on a
  # line of its own; a bare exit 1 (a startup syntax error, say) does not carry
  # that line and is a crash, not a credential finding.
  if [ "$code" -eq 1 ] && has_finding_marker "$out"; then
    echo "::error::a credential key with a non-REDACTED value reached the diagnostics output under ${target}"
    printf '%s\n' "$out" >&2
    return 1
  fi
  echo "::error::redaction check could not run (exit ${code}) for ${target}"
  printf '%s\n' "$out" >&2
  return 1
}
