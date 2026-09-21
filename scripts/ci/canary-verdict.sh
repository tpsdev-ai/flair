#!/usr/bin/env bash
# canary-verdict.sh — the post-publish canary's PASS/FAIL output (flair#1686,
# flair#1781).
#
# This is the single definition of what the canary tells a human to do. It is a
# script, not prose in the workflow, so the exact sha256-bound promote block (or
# the deprecate lines) can be exercised directly.
#
# flair#1781: the promote is LOCKSTEP. The release stages the lockstep set (nine
# packages today) together, so the promote must move all of them — a partial
# paste leaves `latest` skewed across the set (the flair#1383 mismatch class).
# The package list is DERIVED from the manifests by
# `scripts/ci/lockstep-packages.mjs`; it is never copied here.
#
# PASS emits ONE block the operator pastes once, in TWO phases: a preflight that
# verifies EVERY package's published-tarball sha256 (nothing moves if any check
# fails — so a registry hiccup mid-paste cannot leave a partial promote), then
# the `npm dist-tag add` lines (`@tpsdev-ai/flair` LAST), then the skew check.
#
# bash 3.2-safe (flair#1781 R0): the macOS canary leg runs this under stock
# /bin/bash 3.2, so this file uses NO bash-4 feature (no `declare -A`, no
# `mapfile`). A too-old shell fails fast with a clear message, never a feature
# syntax error.
#
# Usage:
#   scripts/ci/canary-verdict.sh <pass|fail> <version> <run-url> [--os <os>] <pkg>=<sha256> ...
#
#   <pkg>=<sha256> may be repeated; one binding per lockstep package, and a
#   duplicate binding for the same package is rejected. PASS requires a binding
#   for EVERY package (missing => DID NOT RUN). Output is Markdown, suitable for
#   `tee -a "$GITHUB_STEP_SUMMARY"`.
#
# The promote guard hashes the PUBLISHED tarball, not `dist.shasum` (a SHA-1 that
# could never equal a sha256). It runs from the repo checkout because
# `registry-tarball-sha256.mjs` lives there, and `@tpsdev-ai/flair` is emitted
# LAST so a partial paste never leaves the CLI ahead of its client library.
#
# Exit: 0 emitted; 2 DID NOT RUN / usage error.

set -euo pipefail

# ── bash floor (flair#1781 R0/R5) ───────────────────────────────────────────
# Keep the whole file to bash 3.2 features; fail fast and clearly on anything
# older. `BASH_VERSION` is unset under a plain sh.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "canary-verdict.sh: must run under bash (bash 3.2+)" >&2
  exit 2
fi
_bash_major="${BASH_VERSION%%.*}"
_bash_rest="${BASH_VERSION#*.}"
_bash_minor="${_bash_rest%%.*}"
if [ "${_bash_major:-0}" -lt 3 ] || { [ "${_bash_major:-0}" -eq 3 ] && [ "${_bash_minor:-0}" -lt 2 ]; }; then
  echo "canary-verdict.sh: bash ${BASH_VERSION} is too old — bash 3.2+ is required (stock macOS /bin/bash is 3.2)" >&2
  exit 2
fi

VERDICT="${1:-}"
VERSION="${2:-}"
RUN_URL="${3:-}"

if [ "$VERDICT" != "pass" ] && [ "$VERDICT" != "fail" ]; then
  echo "usage: canary-verdict.sh <pass|fail> <version> <run-url> [--os <os>] <pkg>=<sha256>..." >&2
  exit 2
fi
if [ -z "$VERSION" ]; then
  echo "usage: canary-verdict.sh <pass|fail> <version> <run-url> [--os <os>] <pkg>=<sha256>... — version is required" >&2
  exit 2
fi

if [ "$#" -ge 3 ]; then shift 3; fi

# Parse `[--os <os>]` and repeated `<pkg>=<sha256>` bindings. bash 3.2: parallel
# indexed arrays, never an associative array. A duplicate binding for the same
# package is rejected by name (flair#1781 R7).
OS_NAME="linux"
BIND_NAME=()
BIND_SHA=()
add_binding() {
  local name="$1" sha="$2" i
  for ((i = 0; i < ${#BIND_NAME[@]}; i++)); do
    if [ "${BIND_NAME[$i]}" = "$name" ]; then
      echo "canary-verdict.sh: DID NOT RUN — duplicate sha256 binding for '$name'" >&2
      exit 2
    fi
  done
  BIND_NAME[${#BIND_NAME[@]}]="$name"
  BIND_SHA[${#BIND_SHA[@]}]="$sha"
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --os) OS_NAME="${2:-}"; shift 2 ;;
    --os=*) OS_NAME="${1#--os=}"; shift ;;
    *=*) add_binding "${1%%=*}" "${1#*=}"; shift ;;
    *) echo "canary-verdict.sh: unexpected argument '$1'" >&2; exit 2 ;;
  esac
done

# The ONE source for the lockstep set (never a second list here).
PACKAGES=()
while IFS= read -r _line; do
  [ -n "$_line" ] && PACKAGES[${#PACKAGES[@]}]="$_line"
done < <(node scripts/ci/lockstep-packages.mjs)
if [ "${#PACKAGES[@]}" -eq 0 ]; then
  echo "canary-verdict.sh: DID NOT RUN — could not derive the lockstep package list (run from the repo root)" >&2
  exit 2
fi

is_known() {
  local k="$1" i
  for ((i = 0; i < ${#PACKAGES[@]}; i++)); do [ "${PACKAGES[$i]}" = "$k" ] && return 0; done
  return 1
}
sha_for() {
  local p="$1" i
  for ((i = 0; i < ${#BIND_NAME[@]}; i++)); do
    if [ "${BIND_NAME[$i]}" = "$p" ]; then printf '%s' "${BIND_SHA[$i]}"; return 0; fi
  done
  return 1
}

for ((i = 0; i < ${#BIND_NAME[@]}; i++)); do
  if ! is_known "${BIND_NAME[$i]}"; then
    echo "canary-verdict.sh: DID NOT RUN — sha256 given for unknown package '${BIND_NAME[$i]}'" >&2
    exit 2
  fi
done

if [ "$VERDICT" = "pass" ]; then
  missing=""
  for ((i = 0; i < ${#PACKAGES[@]}; i++)); do
    p="${PACKAGES[$i]}"
    if ! v="$(sha_for "$p")" || [ -z "$v" ]; then
      missing="${missing} ${p}"
      continue
    fi
    if ! printf '%s' "$v" | grep -Eq '^[0-9a-f]{64}$'; then
      echo "canary-verdict.sh: DID NOT RUN — sha256 for $p is not a 64-char hex value" >&2
      exit 2
    fi
  done
  if [ -n "$missing" ]; then
    echo "canary-verdict.sh: DID NOT RUN — missing sha256 for:${missing}" >&2
    echo "  Refusing to print a PARTIAL promote list: the promote is all-or-none (flair#1781)." >&2
    exit 2
  fi

  cat <<EOF
### ✅ Canary PASS — \`${OS_NAME}\`

Promote ALL ${#PACKAGES[@]} lockstep packages to \`latest\` — **all or none**. A
partial paste leaves \`latest\` skewed across the set (the mismatch flair#1383
detects at runtime). Paste this WHOLE block once, from the repo root: it verifies
EVERY published tarball's sha256 first (so a mid-paste failure touches no tag),
then moves the tags, then confirms the set converged.

\`\`\`
set -e

# 1. Preflight — every published tarball must hash to its recorded sha256.
#    Nothing below runs if any check fails.
EOF
  for ((i = 0; i < ${#PACKAGES[@]}; i++)); do
    p="${PACKAGES[$i]}"
    printf 'test "$(node scripts/ci/registry-tarball-sha256.mjs %s %s)" = "%s"\n' "$VERSION" "$p" "$(sha_for "$p")"
  done
  cat <<EOF

# 2. Promote every lockstep package (\`@tpsdev-ai/flair\` LAST, so a partial paste
#    never leaves the CLI ahead of its client library).
EOF
  for ((i = 0; i < ${#PACKAGES[@]}; i++)); do
    p="${PACKAGES[$i]}"
    printf 'npm dist-tag add %s@%s latest\n' "$p" "$VERSION"
  done
  cat <<EOF

# 3. Confirm the set converged.
node scripts/ci/registry-latest-skew.mjs ${VERSION}
\`\`\`

A stale PASS, a re-cut version, or a paste from a FAIL aborts at the preflight
before \`latest\` can move. The sha256 helper downloads the published tarball, so
it checks the exact bytes, not a tag.
EOF
else
  cat <<EOF
### ❌ Canary FAIL — \`${OS_NAME}\`

Do not promote. Deprecate EVERY lockstep package — the CLI FIRST (the likeliest
install target), so a partial paste warns it earliest. Paste these exact lines:

\`\`\`
EOF
  for ((i = ${#PACKAGES[@]} - 1; i >= 0; i--)); do
    p="${PACKAGES[$i]}"
    printf 'npm deprecate %s@%s "failed post-publish canary: %s"\n' "$p" "$VERSION" "$RUN_URL"
  done
  cat <<EOF

\`\`\`

Re-cut the next patch; never refresh this version.
EOF
fi
