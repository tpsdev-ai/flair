#!/usr/bin/env bash
set -euo pipefail
HARPER_DIR="node_modules/harperdb"
[ -d "$HARPER_DIR" ] || { echo "Run 'npm install' first." >&2; exit 1; }
echo "Building Harper v5 from source..."
npx tsc --project "$HARPER_DIR/tsconfig.build.json" --skipLibCheck --noCheck 2>&1 | grep -v "TS4023" || true
echo "Patching .ts requires..."
find "$HARPER_DIR" -name "*.js" -not -path "$HARPER_DIR/dist/*" -not -path "$HARPER_DIR/node_modules/*" -not -path "$HARPER_DIR/unitTests/*" | xargs grep -l "require.*\.ts['\"]" 2>/dev/null | while read -r f; do
  sed -i '' -e "s/require('\(.*\)\.ts')/require('\1.js')/g" -e "s/require(\"\(.*\)\.ts\")/require(\"\1.js\")/g" "$f"
done
echo "Copying compiled JS for .ts-only files..."
find "$HARPER_DIR" -name "*.ts" -not -path "$HARPER_DIR/dist/*" -not -path "$HARPER_DIR/node_modules/*" -not -name "*.d.ts" | while read -r f; do
  distf="$HARPER_DIR/dist/${f#$HARPER_DIR/}"
  distf="${distf%.ts}.js"
  srcjs="${f%.ts}.js"
  [ -f "$distf" ] && [ ! -f "$srcjs" ] && cp "$distf" "$srcjs"
done
echo "Done. Run: node node_modules/harperdb/bin/harper.js dev ."
