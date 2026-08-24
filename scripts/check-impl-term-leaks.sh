#!/usr/bin/env bash
set -euo pipefail

# Define the patterns to search for. Each uses a leading (^|[^-a-z0-9]) token guard so
# the term only matches as a standalone token, never glued to a preceding word/hyphen.
# This prevents false positives on legitimate CLI flags (e.g. --ops-target) and
# compounds (e.g. devops-pipeline, blogpost-2.0).
# Bead IDs:            ops-[a-z0-9]{4,}
# Implementation labels: post-#.# or pre-#.# (where # is digit)
# NB: portable ERE only — earlier \b word-boundary anchors were double-escaped inside
#     the single-quoted string (\\b -> literal "\b"), so post-/pre- detection was dead.
BEAD_PATTERN='(^|[^-a-z0-9])ops-[a-z0-9]{4,}'
LABEL_PATTERN='(^|[^-a-z0-9])(post|pre)-[0-9]+\.[0-9]+'
PATTERNS="$BEAD_PATTERN|$LABEL_PATTERN"

# Exact-literal allowlist of English ops-* compounds that are not bead IDs (flair#1381).
# Not a regex. Not a heuristic. A real bead ID can only get onto this list by being
# added here, in a diff, visibly. Membership is string equality against one line.
# ops-api is three letters and the bead pattern requires four — listed anyway so
# the exemption stays explicit if the pattern ever widens.
ALLOWLIST_EXACT='
ops-port
ops-api
ops-target
ops-server
'

# Temporary file for list of files
TMPFILE=$(mktemp)
ERRFILE=$(mktemp)
trap 'rm -f "$TMPFILE" "$ERRFILE"' EXIT

# Find files to search:
# 1. All files under packages/*/dist/
find packages -type f -path '*/dist/*' -not -path '*/.github/*' -not -path '*/specs/*' -not -path '*/test/*' 2>/dev/null >> "$TMPFILE"
# 2. All packages/*/README.md
find packages -type f -name 'README.md' -path 'packages/*' -not -path '*/.github/*' -not -path '*/specs/*' -not -path '*/test/*' 2>/dev/null >> "$TMPFILE"
# 3. Root README.md
if [[ -f README.md && ! README.md -ef */.github/* && ! README.md -ef */specs/* && ! README.md -ef */test/* ]]; then
  echo "README.md" >> "$TMPFILE"
fi
# 4. All files under docs/
find docs -type f -not -path '*/.github/*' -not -path '*/specs/*' -not -path '*/test/*' 2>/dev/null >> "$TMPFILE"

# Sort and remove duplicates
sort -u "$TMPFILE" > "${TMPFILE}.sorted"
mv "${TMPFILE}.sorted" "$TMPFILE"

# An empty corpus is a broken scan, not a clean one (flair#953). This is a
# REQUIRED status check, and the corpus depends on `packages/*/dist/` having been
# built by the caller — so "no files to search" is the exact shape of this gate
# silently going dark while still reporting green.
if [[ ! -s "$TMPFILE" ]]; then
  echo "✗ found 0 files to search — the corpus is empty, so NOTHING was checked."
  echo "  This gate scans packages/*/dist/, packages/*/README.md, README.md and docs/."
  echo "  If dist/ has not been built yet, build it first; if the layout moved, fix the"
  echo "  find expressions above. An empty scan is not a passing scan."
  exit 1
fi

FILE_COUNT=$(wc -l < "$TMPFILE" | tr -d ' ')

# Search for patterns in the collected files
echo "Searching for implementation term leaks in $FILE_COUNT file(s):"
cat "$TMPFILE"
echo "---"

# grep's exit codes are three-valued and the distinction is load-bearing:
#   0 = matches found (leaks — fail)
#   1 = no matches (clean — pass)
#  ≥2 = grep ITSELF failed (unreadable file, bad pattern, argv overflow)
# The previous `... 2>/dev/null || true` collapsed 2 into 1: a grep that errored
# out printed "No leaks found." and exited 0. Verified: grep on a chmod-000 file
# returns 2, and the old line rendered that as clean.
#
# The file list goes through a quoted array rather than an unquoted `$(cat ...)`
# so a path containing a space is scanned as one path instead of being split into
# two nonexistent ones — which, under the old code, also read as "no leaks".
# (Built with a read loop rather than mapfile: bash 3.2 still ships as /bin/bash
# on macOS, where the pre-commit hook runs this. xargs is deliberately avoided —
# it batches, and a batched run collapses grep's three exit codes into 123.)
FILES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && FILES+=("$line")
done < "$TMPFILE"

# -H (--with-filename) is required: grep omits the path when the corpus is a
# single file, and the finding formatter below splits on file:line:content.
# Without -H a one-file scan (the exact shape of the unit fixtures) would
# print the raw line and never name the token or the rule (flair#1381).
set +e
OUTPUT=$(grep -n -H -E "$PATTERNS" "${FILES[@]}" 2>"$ERRFILE")
GREP_RC=$?
set -e

if (( GREP_RC >= 2 )); then
  echo "✗ grep exited $GREP_RC — the scan FAILED and verified nothing:"
  cat "$ERRFILE"
  exit 1
fi

# Strip the optional 1-char leading token guard from a grep -oE hit.
strip_guard() {
  case "$1" in
    ops-*|post-*|pre-*) printf '%s' "$1" ;;
    *) printf '%s' "${1#?}" ;;
  esac
}

# Exact string equality against ALLOWLIST_EXACT. Not regex membership.
is_allowlisted() {
  local allowed
  for allowed in $ALLOWLIST_EXACT; do
    if [ "$1" = "$allowed" ]; then
      return 0
    fi
  done
  return 1
}

# Turn grep's raw hits into named findings (file:line: rule + token).
# Allowlisted compounds are dropped here so a real bead ID on the same line
# still fails. If grep matched a line we cannot name a token on, fail closed.
FINDINGS=""
FINDING_COUNT=0

if [[ -n "$OUTPUT" ]]; then
  while IFS= read -r match; do
    [[ -z "$match" ]] && continue

    file="${match%%:*}"
    rest="${match#*:}"
    lineno="${rest%%:*}"
    content="${rest#*:}"

    case "$lineno" in
      ''|*[!0-9]*)
        FINDINGS="${FINDINGS}${match}"$'\n'
        FINDING_COUNT=$((FINDING_COUNT + 1))
        continue
        ;;
    esac

    line_hits=0

    set +e
    bead_raw=$(printf '%s\n' "$content" | grep -oE "$BEAD_PATTERN")
    impl_raw=$(printf '%s\n' "$content" | grep -oE "$LABEL_PATTERN")
    set -e

    if [[ -n "${bead_raw:-}" ]]; then
      while IFS= read -r hit; do
        [[ -z "$hit" ]] && continue
        token=$(strip_guard "$hit")
        if is_allowlisted "$token"; then
          continue
        fi
        FINDINGS="${FINDINGS}${file}:${lineno}: matched bead-ID pattern on token \"${token}\""$'\n'
        FINDING_COUNT=$((FINDING_COUNT + 1))
        line_hits=$((line_hits + 1))
      done <<< "$bead_raw"
    fi

    if [[ -n "${impl_raw:-}" ]]; then
      while IFS= read -r hit; do
        [[ -z "$hit" ]] && continue
        token=$(strip_guard "$hit")
        FINDINGS="${FINDINGS}${file}:${lineno}: matched impl-label pattern on token \"${token}\""$'\n'
        FINDING_COUNT=$((FINDING_COUNT + 1))
        line_hits=$((line_hits + 1))
      done <<< "$impl_raw"
    fi

    # grep said this line matched, but we named no token and filtered none.
    # That is a parser hole, not a clean line — fail closed so the gate
    # cannot go dark on a shape it does not understand.
    if [[ "$line_hits" -eq 0 && -z "${bead_raw:-}" && -z "${impl_raw:-}" ]]; then
      FINDINGS="${FINDINGS}${file}:${lineno}: matched implementation-term pattern (could not extract token)"$'\n'
      FINDING_COUNT=$((FINDING_COUNT + 1))
    fi
  done <<< "$OUTPUT"
fi

if [[ "$FINDING_COUNT" -gt 0 ]]; then
  printf '%s' "$FINDINGS"
  exit 1
else
  echo "No leaks found across $FILE_COUNT file(s)."
  exit 0
fi
