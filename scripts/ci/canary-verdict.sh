#!/usr/bin/env bash
# canary-verdict.sh — the post-publish canary's PASS/FAIL output (flair#1686,
# flair#1781).
#
# This is the single definition of what the canary tells a human to do. It is a
# script, not prose in the workflow, so the exact sha256-bound promote lines (or
# the deprecate lines) can be exercised directly — including the fails-first
# proof that a promote line aborts when the sha input is wrong.
#
# flair#1781: the promote is LOCKSTEP. The release stages nine packages in
# lockstep, so the promote must move all of them — a partial paste leaves
# `latest` skewed across the set (the flair#1383 mismatch class). The package
# list is DERIVED from the manifests by `scripts/ci/lockstep-packages.mjs`; it is
# never copied here. PASS refuses to print a partial list.
#
# Usage:
#   scripts/ci/canary-verdict.sh <pass|fail> <version> <run-url> [--os <os>] <pkg>=<sha256> ...
#
#   <pkg>=<sha256> may be repeated; one binding per lockstep package. PASS
#   requires a binding for EVERY package (missing => DID NOT RUN). Output is
#   Markdown, suitable for `tee -a "$GITHUB_STEP_SUMMARY"`. Each promote line
#   begins with `test ` on a line of its own, so a caller can extract the block:
#   scripts/ci/canary-verdict.sh pass 0.54.2 "$URL" "@tpsdev-ai/flair=$SHA" | grep '^test '
#
# The promote guard hashes the PUBLISHED tarball, not `dist.shasum` (a SHA-1 that
# could never equal a sha256). It runs from the repo checkout because
# `registry-tarball-sha256.mjs` lives there, and `@tpsdev-ai/flair` is emitted
# LAST so a partial paste never leaves the CLI ahead of its client library.
#
# Exit: 0 emitted; 2 DID NOT RUN / usage error.

set -euo pipefail

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

OS_NAME="linux"
declare -A SHA=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --os) OS_NAME="${2:-}"; shift 2 ;;
    --os=*) OS_NAME="${1#--os=}"; shift ;;
    *=*) SHA["${1%%=*}"]="${1#*=}"; shift ;;
    *) echo "canary-verdict.sh: unexpected argument '$1'" >&2; exit 2 ;;
  esac
done

# The ONE source for the lockstep set (never a second list here).
mapfile -t PACKAGES < <(node scripts/ci/lockstep-packages.mjs) || true
if [ "${#PACKAGES[@]}" -eq 0 ]; then
  echo "canary-verdict.sh: DID NOT RUN — could not derive the lockstep package list (run from the repo root)" >&2
  exit 2
fi

is_known() {
  local k="$1" p
  for p in "${PACKAGES[@]}"; do [ "$k" = "$p" ] && return 0; done
  return 1
}
for k in "${!SHA[@]}"; do
  if ! is_known "$k"; then
    echo "canary-verdict.sh: DID NOT RUN — sha256 given for unknown package '$k'" >&2
    exit 2
  fi
done

if [ "$VERDICT" = "pass" ]; then
  missing=()
  for p in "${PACKAGES[@]}"; do
    v="${SHA[$p]:-}"
    if [ -z "$v" ]; then missing+=("$p"); continue; fi
    if ! printf '%s' "$v" | grep -Eq '^[0-9a-f]{64}$'; then
      echo "canary-verdict.sh: DID NOT RUN — sha256 for $p is not a 64-char hex value" >&2
      exit 2
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "canary-verdict.sh: DID NOT RUN — missing sha256 for: ${missing[*]}" >&2
    echo "  Refusing to print a PARTIAL promote list: the promote is all-or-none (flair#1781)." >&2
    exit 2
  fi

  cat <<EOF
### ✅ Canary PASS — \`${OS_NAME}\`

Promote ALL ${#PACKAGES[@]} lockstep packages to \`latest\` — **all or none**. A
partial paste leaves \`latest\` skewed across the set (the mismatch flair#1383
detects at runtime). Run these exact lines from the repo root:

\`\`\`
EOF
  for p in "${PACKAGES[@]}"; do
    printf 'test "$(node scripts/ci/registry-tarball-sha256.mjs %s %s)" = "%s" && npm dist-tag add %s@%s latest\n' \
      "$VERSION" "$p" "${SHA[$p]}" "$p" "$VERSION"
  done
  cat <<EOF

\`\`\`

Then confirm the set converged:

\`\`\`
node scripts/ci/registry-latest-skew.mjs ${VERSION}
\`\`\`

A stale PASS, a re-cut version, or a paste from a FAIL aborts at the \`test\`
before \`latest\` can move. \`@tpsdev-ai/flair\` is promoted LAST, so a partial paste
never leaves the CLI ahead of its client library. The sha256 helper downloads the
published tarball, so it checks the exact bytes, not a tag.
EOF
else
  cat <<EOF
### ❌ Canary FAIL — \`${OS_NAME}\`

Do not promote. Deprecate EVERY lockstep package (paste these exact lines):

\`\`\`
EOF
  for p in "${PACKAGES[@]}"; do
    printf 'npm deprecate %s@%s "failed post-publish canary: %s"\n' "$p" "$VERSION" "$RUN_URL"
  done
  cat <<EOF

\`\`\`

Re-cut the next patch; never refresh this version.
EOF
fi
