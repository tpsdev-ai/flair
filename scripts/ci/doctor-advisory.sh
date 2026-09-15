#!/usr/bin/env bash
# doctor-advisory.sh — decide whether a non-zero `flair doctor` exit is
# advisory-only (flair#1686 / #1698 follow-on; product bug flair#1701).
#
# Usage:
#   scripts/ci/doctor-advisory.sh <doctor-log-file>
#
# `check-instance-boot.sh` requires `flair doctor` to exit 0. On a fresh
# loopback instance doctor can still exit 1 for a finding that is a conditional
# hint rather than a defect (flair#1701), which made the boot contract unable
# to describe a healthy 0.54.2 macOS instance. This script answers the narrow
# question the boot check needs: did doctor fail ONLY because of finding(s) on
# the explicit advisory allow-list below?
#
# A "finding" is a `✗` line other than doctor's own `✗ N issue(s) found`
# summary. The summary is a COUNT, not a finding: it is excluded, and a
# non-zero exit with zero finding lines is a FAIL — a crash that prints no
# findings must never pass as "advisory-only".
#
# Exit:
#   0  every finding matched the allow-list. Prints
#      `doctor: advisory-only (allow-listed): <n>` on stdout.
#   1  a finding did not match, or there were no findings at all. Prints the
#      unmatched lines (or the no-findings reason) on stderr.
#   2  usage error.
#
# ── THE ALLOW-LIST — the one place it lives ─────────────────────────────────
# An entry is an ERE tested against a finding line, and is a promise that the
# finding names NO broken state. Nothing is added here to make a red canary
# green.
#
#   flair#1701 — `FLAIR_PUBLIC_URL is not set … which is correct for a
#   local-only install and unusable for any remote client` is a conditional
#   hint for an operator who might be running this instance publicly. On a
#   loopback instance it is not a defect.
#
# RULE: when flair#1701 ships, the allow-list goes back to EMPTY. It shrinks,
# never grows, and never suppresses a finding that names a broken state.
#
# Deliberately NOT allow-listed: the actual ✗ that failed canary run
# 35020214811 was the ops-socket posture finding, not this hint — the hint
# renders as `⚠` and does not increment doctor's issue count. Any such finding
# must keep the boot check red until the product is fixed or a human decides
# it is advisory too.

set -euo pipefail

LOG="${1:-}"
if [ -z "$LOG" ]; then
  echo "usage: doctor-advisory.sh <doctor-log-file>" >&2
  exit 2
fi
if [ ! -f "$LOG" ]; then
  echo "usage: doctor-advisory.sh <doctor-log-file> — not a file: ${LOG}" >&2
  exit 2
fi

# One ERE. Keep this the ONLY declaration site.
ADVISORY_ALLOWLIST='FLAIR_PUBLIC_URL is not set'

# Strip ANSI SGR sequences. Uses a literal ESC byte in the sed script rather
# than `\x1b`, which BSD sed (macOS) does not support; `\[` is a literal `[`
# in BRE, and `[0-9;]*` is the standard zero-or-more SGR parameters.
strip_sgr() {
  local esc=$'\033'
  printf '%s' "$1" | sed "s/${esc}\[[0-9;]*m//g"
}

findings=0
unmatched=0
while IFS= read -r raw || [ -n "$raw" ]; do
  line="$(strip_sgr "$raw")"
  # Only ✗ lines are findings.
  case "$line" in
    *✗*) ;;
    *) continue ;;
  esac
  # Drop everything up to and including the marker, then trim whitespace.
  finding="${line#*✗}"
  finding="$(printf '%s' "$finding" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  # Doctor's summary line is a count, not a finding.
  if printf '%s' "$finding" | grep -Eq '^[0-9]+ issues? found'; then
    continue
  fi
  findings=$((findings + 1))
  if [ -n "$ADVISORY_ALLOWLIST" ] && printf '%s' "$finding" | grep -Eq -- "$ADVISORY_ALLOWLIST"; then
    echo "allow-listed: ${finding}" >&2
  else
    echo "not allow-listed: ${finding}" >&2
    unmatched=$((unmatched + 1))
  fi
done < "$LOG"

if [ "$findings" -eq 0 ]; then
  echo "doctor exited non-zero but printed no finding (✗) lines — treating as a real failure, not advisory-only" >&2
  exit 1
fi
if [ "$unmatched" -gt 0 ]; then
  echo "doctor reported ${unmatched} finding(s) outside the advisory allow-list — treating as a real failure" >&2
  exit 1
fi

echo "doctor: advisory-only (allow-listed): ${findings}"
exit 0
