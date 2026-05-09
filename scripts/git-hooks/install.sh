#!/bin/sh
# Install the Flair pre-commit hook into .git/hooks/.
#
# Usage: ./scripts/git-hooks/install.sh
# Run from anywhere inside the flair repo.

set -e

cd "$(git rev-parse --show-toplevel)"
HOOKS_DIR=$(git rev-parse --git-path hooks)

cp scripts/git-hooks/pre-commit "$HOOKS_DIR/pre-commit"
chmod +x "$HOOKS_DIR/pre-commit"

echo "✓ installed flair pre-commit hook → $HOOKS_DIR/pre-commit"
echo
echo "Runs: workspace-deps + dep-ages (bake-time) + impl-term-leaks"
echo "Bypass with --no-verify (rarely warranted; CI will catch anyway)."
