#!/usr/bin/env bash
set -euo pipefail

# release.sh — Bump all workspace packages to a single version and publish.
#
# Usage:
#   ./scripts/release.sh 0.5.0        # bump + publish
#   ./scripts/release.sh 0.5.0 --dry  # bump + build + test, skip publish

VERSION="${1:?Usage: release.sh <version> [--dry]}"
DRY="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PACKAGES=(
  "$ROOT/packages/flair-client"
  "$ROOT/packages/flair-mcp"
  "$ROOT/plugins/openclaw-flair"
  "$ROOT"
)

echo "=== Flair Release v${VERSION} ==="

# 1. Validate git state
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "❌ Working tree is dirty. Commit or stash changes first."
  exit 1
fi

BRANCH="$(git -C "$ROOT" branch --show-current)"
if [[ "$BRANCH" != "main" ]]; then
  echo "⚠️  Not on main (on: $BRANCH). Publishing from non-main branch."
  read -p "Continue? [y/N] " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

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

# 3. Update internal dependency (flair-mcp → flair-client)
echo "🔗 Aligning internal dependencies..."
node -e "
  const fs = require('fs');
  const path = '$ROOT/packages/flair-mcp/package.json';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (pkg.dependencies?.['@tpsdev-ai/flair-client']) {
    pkg.dependencies['@tpsdev-ai/flair-client'] = '$VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    console.log('  ✓ flair-mcp → flair-client: $VERSION');
  }
"

# 4. Build
echo "🔨 Building..."
(cd "$ROOT" && npm run build && npm run build:cli) || { echo "❌ Build failed"; exit 1; }
(cd "$ROOT/packages/flair-client" && npm run build) || { echo "❌ flair-client build failed"; exit 1; }
(cd "$ROOT/packages/flair-mcp" && npm run build) || { echo "❌ flair-mcp build failed"; exit 1; }
echo "  ✓ All packages built"

# 5. Test
echo "🧪 Running tests..."
(cd "$ROOT" && bun test) || { echo "❌ Tests failed"; exit 1; }
echo "  ✓ Tests passed"

# 6. Commit version bump
echo "📝 Committing version bump..."
git -C "$ROOT" add -A
git -C "$ROOT" commit -m "release: v${VERSION} — align all workspace packages"

if [[ "$DRY" == "--dry" ]]; then
  echo ""
  echo "🏁 Dry run complete. All packages at v${VERSION}, built and tested."
  echo "   To publish: git push && run this script again without --dry"
  exit 0
fi

# 7. Publish in dependency order
echo "🚀 Publishing to npm..."
echo "  Publishing @tpsdev-ai/flair-client..."
(cd "$ROOT/packages/flair-client" && npm publish) || { echo "❌ flair-client publish failed"; exit 1; }

echo "  Publishing @tpsdev-ai/flair-mcp..."
(cd "$ROOT/packages/flair-mcp" && npm publish) || { echo "❌ flair-mcp publish failed"; exit 1; }

echo "  Publishing @tpsdev-ai/flair..."
(cd "$ROOT" && npm publish) || { echo "❌ flair publish failed"; exit 1; }

echo "  Publishing @tpsdev-ai/openclaw-flair..."
(cd "$ROOT/plugins/openclaw-flair" && npm publish) || { echo "⚠️  openclaw-flair publish failed (may need build step)"; }

# 8. Tag and push
echo "🏷️  Tagging v${VERSION}..."
git -C "$ROOT" tag "v${VERSION}"
git -C "$ROOT" push && git -C "$ROOT" push --tags

echo ""
echo "✅ Flair v${VERSION} released!"
echo "   @tpsdev-ai/flair@${VERSION}"
echo "   @tpsdev-ai/flair-client@${VERSION}"
echo "   @tpsdev-ai/flair-mcp@${VERSION}"
echo "   @tpsdev-ai/openclaw-flair@${VERSION}"
