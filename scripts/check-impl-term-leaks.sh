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
PATTERNS='(^|[^-a-z0-9])ops-[a-z0-9]{4,}|(^|[^-a-z0-9])(post|pre)-[0-9]+\.[0-9]+'

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

set +e
OUTPUT=$(grep -n -E "$PATTERNS" "${FILES[@]}" 2>"$ERRFILE")
GREP_RC=$?
set -e

if (( GREP_RC >= 2 )); then
  echo "✗ grep exited $GREP_RC — the scan FAILED and verified nothing:"
  cat "$ERRFILE"
  exit 1
fi

if [[ -n "$OUTPUT" ]]; then
  echo "$OUTPUT"
  exit 1
else
  echo "No leaks found across $FILE_COUNT file(s)."
  exit 0
fi