#!/usr/bin/env bash
set -euo pipefail

# release.sh — Bump all workspace packages to a single version and publish.
#
# Two-phase flow (respects main branch protection — no direct pushes, no bypass):
#
#   Phase 1 — open release PR:
#     ./scripts/release.sh 0.5.0
#       → creates branch release/v0.5.0, bumps + builds + tests,
#         commits, pushes, opens PR. Review and merge via GitHub.
#
#   Phase 2 — publish after merge:
#     ./scripts/release.sh 0.5.0 --publish
#       → verifies main HEAD matches v0.5.0, publishes all packages
#         to npm in dep order, tags, pushes the tag.
#
#   ./scripts/release.sh 0.5.0 --dry
#       → phase-1 bump + build + test on a local branch, skip push/PR.

VERSION="${1:?Usage: release.sh <version> [--publish|--dry]}"
MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# VERSION is interpolated into node -e heredocs and git/gh commands below.
# Anchored semver-ish pattern: digits, dots, optional pre-release (-rc.1,
# -alpha, etc.). Rejects quotes, backticks, semicolons — nothing that could
# break out of the string literal in `pkg.version = '$VERSION';`.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  echo "❌ Invalid version: '$VERSION'. Expected semver (e.g. 0.5.6 or 1.0.0-rc.1)."
  exit 1
fi

PACKAGES=(
  "$ROOT/packages/flair-client"
  "$ROOT/packages/flair-mcp"
  "$ROOT/packages/openclaw-flair"
  "$ROOT/packages/pi-flair"
  "$ROOT"
)

PACKAGE_JSONS=(
  "$ROOT/packages/flair-client/package.json"
  "$ROOT/packages/flair-mcp/package.json"
  "$ROOT/packages/openclaw-flair/package.json"
  "$ROOT/packages/pi-flair/package.json"
  "$ROOT/package.json"
)

# Prefer gh-as flint (tpsdev-ai org access) per CLAUDE.md
if command -v gh-as >/dev/null 2>&1; then
  GH="gh-as flint"
else
  GH="gh"
fi

# -----------------------------------------------------------------------------
# Phase 2: publish after release PR is merged
# -----------------------------------------------------------------------------
if [[ "$MODE" == "--publish" ]]; then
  echo "=== Flair Release v${VERSION} — PUBLISH ==="

  if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
    echo "❌ Working tree is dirty. Check out main at the release commit."
    exit 1
  fi

  BRANCH="$(git -C "$ROOT" branch --show-current)"
  if [[ "$BRANCH" != "main" ]]; then
    echo "❌ --publish must run from main (on: $BRANCH)."
    exit 1
  fi

  echo "🔄 Pulling latest main..."
  git -C "$ROOT" pull --ff-only origin main

  # Verify every package.json is at the declared version — catches running
  # --publish before the release PR was actually merged.
  for pj in "${PACKAGE_JSONS[@]}"; do
    name="$(node -e "console.log(require('$pj').name)")"
    pv="$(node -e "console.log(require('$pj').version)")"
    if [[ "$pv" != "$VERSION" ]]; then
      echo "❌ $name is at $pv, expected $VERSION. Has the release PR been merged?"
      exit 1
    fi
  done

  if git -C "$ROOT" rev-parse "v${VERSION}" >/dev/null 2>&1; then
    echo "❌ Tag v${VERSION} already exists. Did you already publish?"
    exit 1
  fi

  echo "🔨 Building from merged main..."
  (cd "$ROOT" && npm run build && npm run build:cli) || { echo "❌ Build failed"; exit 1; }
  (cd "$ROOT/packages/flair-client" && npm run build) || { echo "❌ flair-client build failed"; exit 1; }
  (cd "$ROOT/packages/flair-mcp" && npm run build) || { echo "❌ flair-mcp build failed"; exit 1; }

  echo "🚀 Publishing to npm..."
  echo "  Publishing @tpsdev-ai/flair-client..."
  (cd "$ROOT/packages/flair-client" && npm publish) || { echo "❌ flair-client publish failed"; exit 1; }

  echo "  Publishing @tpsdev-ai/flair-mcp..."
  (cd "$ROOT/packages/flair-mcp" && npm publish) || { echo "❌ flair-mcp publish failed"; exit 1; }

  echo "  Publishing @tpsdev-ai/flair..."
  (cd "$ROOT" && npm publish) || { echo "❌ flair publish failed"; exit 1; }

  echo "  Publishing @tpsdev-ai/openclaw-flair..."
  (cd "$ROOT/packages/openclaw-flair" && npm publish) || { echo "⚠️  openclaw-flair publish failed (may need build step)"; }

  echo "  Publishing @tpsdev-ai/pi-flair..."
  (cd "$ROOT/packages/pi-flair" && npm publish) || { echo "⚠️  pi-flair publish failed (may need build step)"; }

  echo "🏷️  Tagging v${VERSION} on main..."
  git -C "$ROOT" tag -a "v${VERSION}" -m "Release v${VERSION}"
  git -C "$ROOT" push origin "v${VERSION}"

  echo ""
  echo "✅ Flair v${VERSION} published and tagged."
  exit 0
fi

# -----------------------------------------------------------------------------
# Phase 1: prepare release PR
# -----------------------------------------------------------------------------
echo "=== Flair Release v${VERSION} — PR PREP ==="

# 1. Validate git state
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "❌ Working tree is dirty. Commit or stash changes first."
  exit 1
fi

BRANCH="$(git -C "$ROOT" branch --show-current)"
if [[ "$BRANCH" != "main" ]]; then
  echo "⚠️  Not on main (on: $BRANCH). Release PRs must branch from main."
  read -p "Continue anyway? [y/N] " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

echo "🔄 Pulling latest main..."
git -C "$ROOT" pull --ff-only origin main

RELEASE_BRANCH="release/v${VERSION}"
if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$RELEASE_BRANCH"; then
  echo "❌ Branch $RELEASE_BRANCH already exists locally. Delete it first if re-running."
  exit 1
fi

echo "🌿 Creating $RELEASE_BRANCH..."
git -C "$ROOT" checkout -b "$RELEASE_BRANCH"

# 2. Bump versions in all package.json files
echo "📦 Bumping all packages to v${VERSION}..."
for pkg in "${PACKAGES[@]}"; do
  name="$(node -e "console.log(require('$pkg/package.json').name)")"
  node -e "
    const fs = require('fs');
    const path = '$pkg/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  ✓ $name → $VERSION"
done

# 3. Update internal dependencies (flair-mcp + pi-flair both depend on flair-client)
echo "🔗 Aligning internal dependencies..."
for INTERNAL_DEPENDENT in "$ROOT/packages/flair-mcp/package.json" "$ROOT/packages/pi-flair/package.json"; do
  node -e "
    const fs = require('fs');
    const path = '$INTERNAL_DEPENDENT';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (pkg.dependencies?.['@tpsdev-ai/flair-client']) {
      pkg.dependencies['@tpsdev-ai/flair-client'] = '$VERSION';
      fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
      console.log('  ✓ ' + pkg.name + ' → flair-client: $VERSION');
    }
  "
done

# 3a. Refresh bun.lock so CI's --frozen-lockfile passes post-bump.
# Omitting this was the 0.5.6 release failure: version bumps desynced the
# lockfile, --frozen-lockfile killed every CI job at install.
echo "🔒 Refreshing bun.lock..."
(cd "$ROOT" && bun install) || { echo "❌ bun install failed"; exit 1; }

# 4. Build
echo "🔨 Building..."
(cd "$ROOT" && npm run build && npm run build:cli) || { echo "❌ Build failed"; exit 1; }
(cd "$ROOT/packages/flair-client" && npm run build) || { echo "❌ flair-client build failed"; exit 1; }
(cd "$ROOT/packages/flair-mcp" && npm run build) || { echo "❌ flair-mcp build failed"; exit 1; }
echo "  ✓ All packages built"

# 5. Test
# Scope matches CI's test job split: unit + integration under bun. Playwright
# e2e specs live under test/e2e/ and fail to load under bun — they're run via
# `bunx playwright test` against a live server in CI, not locally here.
echo "🧪 Running tests..."
(cd "$ROOT" && bun test test/unit/ test/integration/) || { echo "❌ Tests failed"; exit 1; }
echo "  ✓ Tests passed"

# 6. Commit version bump (explicit paths — no -A)
echo "📝 Committing version bump..."
git -C "$ROOT" add \
  "$ROOT/package.json" \
  "$ROOT/packages/flair-client/package.json" \
  "$ROOT/packages/flair-mcp/package.json" \
  "$ROOT/packages/openclaw-flair/package.json" \
  "$ROOT/packages/pi-flair/package.json" \
  "$ROOT/bun.lock"
git -C "$ROOT" commit -m "release: v${VERSION} — align all workspace packages"

if [[ "$MODE" == "--dry" ]]; then
  echo ""
  echo "🏁 Dry run complete. All packages at v${VERSION}, built and tested, commit on $RELEASE_BRANCH."
  echo "   To open PR: re-run without --dry after resetting the branch."
  exit 0
fi

# 7. Push branch + open PR
echo "📤 Pushing $RELEASE_BRANCH..."
git -C "$ROOT" push -u origin "$RELEASE_BRANCH"

echo "🔖 Opening release PR..."
PR_URL="$($GH pr create \
  --repo tpsdev-ai/flair \
  --base main \
  --head "$RELEASE_BRANCH" \
  --title "release: v${VERSION}" \
  --body "Version bump across workspace packages to v${VERSION}.

See CHANGELOG.md for what's in this release.

After CI is green and this is merged:
\`\`\`
git checkout main && git pull
./scripts/release.sh ${VERSION} --publish
\`\`\`")"

echo ""
echo "✅ Release PR opened: $PR_URL"
echo ""
echo "Next steps:"
echo "  1. Wait for CI green on the PR"
echo "  2. Merge via GitHub UI (or: $GH pr merge --squash --repo tpsdev-ai/flair <num>)"
echo "  3. git checkout main && git pull"
echo "  4. ./scripts/release.sh ${VERSION} --publish"
