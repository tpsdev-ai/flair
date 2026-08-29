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

line_count() {
  wc -l < "$1" | tr -d ' '
}

# Find files to search. Each find is dir-guarded so a missing tree cannot
# trip `set -e` before the per-source floor below (flair#1420, flair#1427).
# Counts are taken per source so one present tree cannot hide another that
# disappeared (the all-or-nothing `! -s $TMPFILE` floor never fired in a
# real checkout because README.md / docs/ always kept the corpus non-empty).
DIST_COUNT=0
DIST_DIR_COUNT=0
PKG_README_COUNT=0
PACKAGES_PRESENT=0
README_COUNT=0
DOCS_COUNT=0
CHANGELOG_COUNT=0
CHANGELOG_FRAG_COUNT=0

# 1. All files under packages/*/dist/
# 2. All packages/*/README.md
if [[ -d packages ]]; then
  PACKAGES_PRESENT=1
  DIST_DIR_COUNT=$(find packages -type d -path '*/dist' -not -path '*/.github/*' -not -path '*/specs/*' -not -path '*/test/*' 2>/dev/null | wc -l | tr -d ' ')
  BEFORE=$(line_count "$TMPFILE")
  find packages -type f -path '*/dist/*' -not -path '*/.github/*' -not -path '*/specs/*' -not -path '*/test/*' 2>/dev/null >> "$TMPFILE"
  DIST_COUNT=$(( $(line_count "$TMPFILE") - BEFORE ))
  BEFORE=$(line_count "$TMPFILE")
  find packages -type f -name 'README.md' -path 'packages/*' -not -path '*/.github/*' -not -path '*/specs/*' -not -path '*/test/*' 2>/dev/null >> "$TMPFILE"
  PKG_README_COUNT=$(( $(line_count "$TMPFILE") - BEFORE ))
fi
# 3. Root README.md
if [[ -f README.md && ! README.md -ef */.github/* && ! README.md -ef */specs/* && ! README.md -ef */test/* ]]; then
  echo "README.md" >> "$TMPFILE"
  README_COUNT=1
fi
# 4. All files under docs/
if [[ -d docs ]]; then
  BEFORE=$(line_count "$TMPFILE")
  find docs -type f -not -path '*/.github/*' -not -path '*/specs/*' -not -path '*/test/*' 2>/dev/null >> "$TMPFILE"
  DOCS_COUNT=$(( $(line_count "$TMPFILE") - BEFORE ))
fi
# 5. Root CHANGELOG.md (flair#1420) — release notes are the most consumer-facing
#    document we publish. A leak here is what a reader actually sees.
if [[ -f CHANGELOG.md ]]; then
  echo "CHANGELOG.md" >> "$TMPFILE"
  CHANGELOG_COUNT=1
fi
# 6. Changelog fragments (flair#1420) — this is where the text is authored, so
#    a leak fails the PR that introduces it rather than the release that
#    assembles it.
if [[ -d .changelog ]]; then
  BEFORE=$(line_count "$TMPFILE")
  find .changelog -type f -not -path '*/.github/*' -not -path '*/specs/*' -not -path '*/test/*' 2>/dev/null >> "$TMPFILE"
  CHANGELOG_FRAG_COUNT=$(( $(line_count "$TMPFILE") - BEFORE ))
fi

# Sort and remove duplicates
sort -u "$TMPFILE" > "${TMPFILE}.sorted"
mv "${TMPFILE}.sorted" "$TMPFILE"

# Per-source floor (flair#1427, flair#953). An empty *total* corpus is the
# wrong check: README.md and docs/ keep it non-empty in every real checkout,
# so a missing CHANGELOG.md, an absent .changelog/, or an unbuilt
# packages/*/dist/ used to scan less and still report green. Each source this
# script intends to scan must contribute at least one file. Report every
# empty source, then refuse — a hole in one source is not a passing scan.
FLOOR_FAILED=0
floor_fail() {
  echo "✗ $1"
  echo "  $2"
  FLOOR_FAILED=1
}

if [[ "$PACKAGES_PRESENT" -eq 0 ]]; then
  floor_fail \
    "packages/ is missing — packages/*/dist/ and packages/*/README.md were not scanned." \
    "The packages tree is a required source (flair#953). If the layout moved, fix the find expressions above. Skipping it silently is how this gate goes dark."
else
  if [[ "$DIST_COUNT" -eq 0 ]]; then
    if [[ "$DIST_DIR_COUNT" -eq 0 ]]; then
      floor_fail \
        "packages/*/dist/ contributed 0 files — that source was not scanned." \
        "dist/ directories are absent, so the publishable packages have not been built. This gate scans the shipped dist/ surface (flair#953). Build the packages first; an unbuilt dist/ is not a passing scan."
    else
      floor_fail \
        "packages/*/dist/ contributed 0 files — that source was not scanned." \
        "dist/ directories exist but contain no files (built and empty). That is not a passing scan — a build that produced nothing still left this source dark."
    fi
  fi
  if [[ "$PKG_README_COUNT" -eq 0 ]]; then
    floor_fail \
      "packages/*/README.md contributed 0 files — that source was not scanned." \
      "Package README files are consumer-facing. If the layout moved, fix the find expressions above."
  fi
fi

if [[ "$README_COUNT" -eq 0 ]]; then
  floor_fail \
    "README.md contributed 0 files — that source was not scanned." \
    "The root README.md is missing. It is a consumer-facing document this gate intends to scan."
fi

if [[ "$DOCS_COUNT" -eq 0 ]]; then
  if [[ ! -d docs ]]; then
    floor_fail \
      "docs/ contributed 0 files — that source was not scanned." \
      "docs/ is missing. User-facing documentation is a required source; skipping it silently is how a leak ships."
  else
    floor_fail \
      "docs/ contributed 0 files — that source was not scanned." \
      "docs/ exists but find returned no files. If the layout moved, fix the find expressions above."
  fi
fi

if [[ "$CHANGELOG_COUNT" -eq 0 ]]; then
  floor_fail \
    "CHANGELOG.md contributed 0 files — that source was not scanned." \
    "CHANGELOG.md is missing. Release notes are consumer-facing; skipping them silently is how a leak ships (flair#1420)."
fi

if [[ "$CHANGELOG_FRAG_COUNT" -eq 0 ]]; then
  if [[ ! -d .changelog ]]; then
    floor_fail \
      ".changelog/ contributed 0 files — that source was not scanned." \
      ".changelog/ is missing. Fragments are where the text is authored; skipping them silently is how a leak reaches the release cut (flair#1420)."
  else
    floor_fail \
      ".changelog/ contributed 0 files — that source was not scanned." \
      ".changelog/ exists but find returned no files. Fragments are where the text is authored; an empty fragment tree is not a passing scan (flair#1420)."
  fi
fi

if [[ "$FLOOR_FAILED" -ne 0 ]]; then
  echo "  An empty source is a broken scan, not a clean one. Coverage must not narrow silently."
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
