#!/usr/bin/env bash
# launchd-redaction-check.sh — checks the run's password and supported
# credential key/string shapes, shared by scripts/ci/macos-launchd-upgrade-lane.sh and
# scripts/ci/check-redaction-fixtures.sh (flair#2589). Sourced, not executed.
#
# Expects:
#   WORKSPACE   the checkout root (used to locate the redactor)
#   ADMIN_PASS  optional; the run's own admin password, never printed
#
# Two independent layers:
#   (1) the run's own admin password value must not appear in the scanned target
#       (binary content included: the grep has no -I); and
#   (2) the redactor must report no credential key in the supported key/string
#       shape with a value other than REDACTED.
#
# Scanner exit 0 requires a valid empty-findings report; exit 1 requires a
# valid non-empty report. The helper returns 0 for clean, 1 for a finding,
# and 2 for could-not-run, including startup exit 1 without a report.

report_matches_exit() {
  node -e '
    const fs = require("node:fs");
    let doc;
    try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
    if (!doc || doc.schema !== "redact-launchd-plist/report/1") process.exit(1);
    const findings = doc.findings;
    if (!Array.isArray(findings)) process.exit(1);
    const code = process.argv[2];
    if (code !== "0" && code !== "1") process.exit(1);
    if ((code === "0") !== (findings.length === 0)) process.exit(1);
    for (const f of findings) {
      if (!f || typeof f.file !== "string" || f.file.length === 0) process.exit(1);
      if (!Array.isArray(f.keys) || f.keys.length === 0) process.exit(1);
      for (const k of f.keys) if (typeof k !== "string" || k.length === 0) process.exit(1);
    }
    process.exit(0);
  ' "$1" "$2"
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
      return 2
    fi
  fi
  local report code=0
  local out
  # `|| code=$?` avoids the ERR trap.
  report="$(mktemp "${TMPDIR:-/tmp}/redact-check-report.XXXXXX")" || {
    echo "::error::redaction check could not run (cannot create the report file for ${target})"
    return 2
  }
  out="$(node "$WORKSPACE/scripts/ci/redact-launchd-plist.mjs" --check --report "$report" "$target" 2>&1)" || code=$?
  if [ "$code" -eq 0 ] && report_matches_exit "$report" "$code"; then
    rm -f "$report"
    return 0
  fi
  if [ "$code" -eq 1 ] && report_matches_exit "$report" "$code"; then
    rm -f "$report"
    echo "::error::a credential key with a non-REDACTED value reached the diagnostics output under ${target}"
    printf '%s\n' "$out" >&2
    return 1
  fi
  rm -f "$report"
  echo "::error::redaction check could not run (exit ${code}) for ${target}"
  printf '%s\n' "$out" >&2
  return 2
}
