#!/usr/bin/env bash
set -euo pipefail

# Define the patterns to search for
# Bead IDs: ops-[a-z0-9]{4,}
# Implementation labels: post-#.# or pre-#.# (where # is digit)
PATTERNS='ops-[a-z0-9]{4,}|\\bpost-[0-9]+\\.[0-9]+\\b|\\bpre-[0-9]+\\.[0-9]+\\b'

# Temporary file for list of files
TMPFILE=$(mktemp)
trap "rm -f $TMPFILE" EXIT

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

# If no files found, exit 0
if [[ ! -s "$TMPFILE" ]]; then
  echo "No files to search."
  exit 0
fi

# Search for patterns in the collected files
echo "Searching for implementation term leaks in:"
cat "$TMPFILE"
echo "---"

# Use grep with line numbers and filename
# We use command substitution to pass the list of files as arguments
OUTPUT=$(grep -n -E "$PATTERNS" $(cat "$TMPFILE") 2>/dev/null || true)

if [[ -n "$OUTPUT" ]]; then
  echo "$OUTPUT"
  exit 1
else
  echo "No leaks found."
  exit 0
fi