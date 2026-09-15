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
#   0  every finding matched the allow-list under count parity. Prints
#      `doctor: advisory-only (allow-listed): <n>` on stdout.
#   1  a finding did not match, the number of findings did not equal the number
#      of allow-list hits (count parity), or there were no findings at all.
#      Prints the unmatched lines (or the reason) on stderr.
#   2  usage error.
#
# ── THE ALLOW-LIST — the one place it lives ─────────────────────────────────
# An entry is a LITERAL, FULL-LINE string, matched with a fixed-string,
# whole-line comparison (`grep -Fxq`) against the normalised ✗ line. It is NOT
# a pattern. An entry must not contain ERE metacharacters
# (`| ( ) [ ] * + ? . ^ $ \` or `{`), because a pattern — even one entry — can
# hide several findings (e.g. `A|B`) or match a finding that merely contains
# the phrase. One entry covers exactly one finding.
#
# Count parity is enforced at runtime: the boot check passes only when the
# number of ✗ findings equals the number of allow-list HITS, and every hit is a
# distinct entry (an entry may be used at most once). That is what makes "the
# allow-list has one entry" true at runtime, not just in a comment: a single
# entry can never excuse two findings, and it can never excuse a finding that
# only starts with (or contains) the allow-listed text. The test additionally
# pins the entry count to the number of distinct findings it covers.
#
#   flair#1701 — the stable, metacharacter-free identity phrase of the
#   public-URL hint. The hint's rendered text embeds the loopback issuer
#   (`http://127.0.0.1:<port>`), so only the phrase is literal-allow-listed;
#   doctor prints that hint as `⚠` (not `✗`) and it does not increment the
#   issue count, so this entry is a placeholder that goes back to EMPTY with
#   the product fix. It never suppresses the ops-socket `✗` that failed canary
#   run 35020214811.
#
# RULE: when flair#1701 ships, the allow-list goes back to EMPTY. It shrinks,
# never grows, and never suppresses a finding that names a broken state.

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

# Literal full-line entries. One entry per finding. Keep this the ONLY
# declaration site, and keep every entry free of ERE metacharacters — the test
# in test/unit/doctor-advisory.test.ts enforces both.
ADVISORY_ALLOWLIST=(
  'FLAIR_PUBLIC_URL is not set'
)
allow_count=${#ADVISORY_ALLOWLIST[@]}

# Strip ANSI SGR sequences. Uses a literal ESC byte in the sed script rather
# than `\x1b`, which BSD sed (macOS) does not support; `\[` is a literal `[`
# in BRE, and `[0-9;]*` is the standard zero-or-more SGR parameters.
strip_sgr() {
  local esc=$'\033'
  printf '%s' "$1" | sed "s/${esc}\[[0-9;]*m//g"
}

# One slot per entry: an entry may excuse at most one finding.
used=()
i=0
while [ "$i" -lt "$allow_count" ]; do
  used[i]=0
  i=$((i + 1))
done

findings=0
matched=0
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
  # Find the entry that is exactly this line. `-F` (literal) and `-x` (whole
  # line) together mean a finding can never be excused by a prefix, substring,
  # or ERE alternation. An entry that already excused an earlier finding is not
  # reused, so every hit is a distinct entry.
  matched_here=0
  i=0
  while [ "$i" -lt "$allow_count" ]; do
    if [ "${used[i]}" -eq 0 ] && printf '%s\n' "$finding" | grep -Fxq -- "${ADVISORY_ALLOWLIST[i]}"; then
      used[i]=1
      matched_here=1
      break
    fi
    i=$((i + 1))
  done
  if [ "$matched_here" -eq 1 ]; then
    echo "allow-listed: ${finding}" >&2
    matched=$((matched + 1))
  else
    echo "not allow-listed: ${finding}" >&2
  fi
done < "$LOG"

if [ "$findings" -eq 0 ]; then
  echo "doctor exited non-zero but printed no finding (✗) lines — treating as a real failure, not advisory-only" >&2
  exit 1
fi
# Count parity: every ✗ line must be matched by its own (distinct) entry. An
# unmatched line, or a second line that would reuse an already-used entry,
# leaves findings > matched and fails here.
if [ "$findings" -ne "$matched" ]; then
  echo "doctor reported ${findings} finding(s) but only ${matched} matched the advisory allow-list — refusing a count-parity pass" >&2
  exit 1
fi

echo "doctor: advisory-only (allow-listed): ${findings}"
exit 0
