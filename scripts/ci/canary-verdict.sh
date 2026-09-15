#!/usr/bin/env bash
# canary-verdict.sh — the post-publish canary's PASS/FAIL line (flair#1686).
#
# This is the single definition of what the canary tells a human to do. It is a
# script, not prose in the workflow, so the exact sha256-bound promote command (or
# the deprecate command) can be exercised directly — including the fails-first
# proof that the promote line aborts when the sha input is wrong.
#
# Usage:
#   scripts/ci/canary-verdict.sh <pass|fail> <version> <sha256> <run-url> [os]
#
# Output is Markdown, suitable for `tee -a "$GITHUB_STEP_SUMMARY"` and for the
# run log. The promote line begins with `test "` and appears on a line of its
# own, so a caller can extract it:
#   scripts/ci/canary-verdict.sh pass 0.54.2 "$SHA" "$URL" | grep '^test '
#
# The promote guard hashes the PUBLISHED tarball, not `dist.shasum` (which is a
# SHA-1 and could never equal a sha256). It runs from the repo checkout because
# `registry-tarball-sha256.mjs` lives there.
#
# Exit: 0 emitted; 2 usage error.

set -euo pipefail

VERDICT="${1:-}"
VERSION="${2:-}"
SHA="${3:-}"
RUN_URL="${4:-}"
OS_NAME="${5:-linux}"

if [ "$VERDICT" != "pass" ] && [ "$VERDICT" != "fail" ]; then
  echo "usage: canary-verdict.sh <pass|fail> <version> <sha256> <run-url> [os]" >&2
  exit 2
fi
if [ -z "$VERSION" ]; then
  echo "usage: canary-verdict.sh <pass|fail> <version> <sha256> <run-url> [os] — version is required" >&2
  exit 2
fi

if [ "$VERDICT" = "pass" ]; then
  cat <<EOF
### ✅ Canary PASS — \`${OS_NAME}\`

Promote to \`latest\` (sha256-bound; run this exact line from the repo root):

\`\`\`
test "\$(node scripts/ci/registry-tarball-sha256.mjs ${VERSION})" = "${SHA}" && npm dist-tag add @tpsdev-ai/flair@${VERSION} latest && npm view @tpsdev-ai/flair dist-tags.latest
\`\`\`

A stale PASS, a re-cut version, or a paste from a FAIL aborts at the \`test\`
before \`latest\` can move. The sha256 helper downloads the published tarball, so
it checks the exact bytes, not a tag.
EOF
else
  cat <<EOF
### ❌ Canary FAIL — \`${OS_NAME}\`

Do not promote. Deprecate the public version (paste this exact line):

\`\`\`
npm deprecate @tpsdev-ai/flair@${VERSION} "failed post-publish canary: ${RUN_URL}"
\`\`\`

Re-cut the next patch; never refresh this version.
EOF
fi
