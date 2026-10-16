#!/usr/bin/env bash
# launchd-redaction-check.sh — the "no inline credential reached the output"
# assertion, shared by scripts/ci/macos-launchd-upgrade-lane.sh and
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
# The redactor's report file is authoritative, not its exit code or its
# stdout/stderr. `--check` writes a JSON finding record to the file named by
# `--report`, and a scan is a finding only when that file holds a well-formed
# record. Node prints the offending source line of a syntax error, so a scanner
# that cannot start can print a line that reads like the finding marker and exit
# 1; that run writes no report and is reported as could-not-run. A finding and a
# could-not-run both fail the caller.

# True when the report file (the redactor's finding-record channel) holds a
# well-formed finding record: a JSON object whose `findings` array is non-empty
# and whose every entry names a file and at least one credential key. A missing,
# unreadable or malformed file is NOT a finding — it is a check that could not
# run. Deliberately a self-contained `node -e` snippet, not an import of the
# scanner, so a scanner that cannot load cannot decide its own verdict.
report_holds_finding() {
  node -e '
    const fs = require("node:fs");
    let doc;
    try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
    const findings = doc && doc.findings;
    if (!Array.isArray(findings) || findings.length === 0) process.exit(1);
    for (const f of findings) {
      if (!f || typeof f.file !== "string" || f.file.length === 0) process.exit(1);
      if (!Array.isArray(f.keys) || f.keys.length === 0) process.exit(1);
      for (const k of f.keys) if (typeof k !== "string" || k.length === 0) process.exit(1);
    }
    process.exit(0);
  ' "$1"
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
  local report code=0
  local out
  # The report starts empty and is written only by the redactor, only when it
  # finishes a scan. A crash (a Node startup syntax error, say) leaves it empty,
  # so an exit 1 with no report is could-not-run, never a finding. `|| code=$?`
  # keeps a non-zero exit out of the ERR trap's path.
  report="$(mktemp "${TMPDIR:-/tmp}/redact-check-report.XXXXXX")" || {
    echo "::error::redaction check could not run (cannot create the report file for ${target})"
    return 1
  }
  out="$(node "$WORKSPACE/scripts/ci/redact-launchd-plist.mjs" --check --report "$report" "$target" 2>&1)" || code=$?
  if [ "$code" -eq 0 ]; then
    rm -f "$report"
    return 0
  fi
  # Exit 1 is a finding only when the report file holds a well-formed finding
  # record. The exit code and the printed output are not the signal: a Node
  # diagnostic can quote the finding phrase and exit 1 (flair#2589).
  if [ "$code" -eq 1 ] && report_holds_finding "$report"; then
    rm -f "$report"
    echo "::error::a credential key with a non-REDACTED value reached the diagnostics output under ${target}"
    printf '%s\n' "$out" >&2
    return 1
  fi
  rm -f "$report"
  echo "::error::redaction check could not run (exit ${code}) for ${target}"
  printf '%s\n' "$out" >&2
  return 1
}
