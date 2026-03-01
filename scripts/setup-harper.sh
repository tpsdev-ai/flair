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

# Step 4: Create tps_agent role and user (idempotent — errors if exists, that's fine)
echo "Setting up tps_agent role and user..."
HARPER_ADMIN_AUTH="Basic $(echo -n admin:admin123 | base64)"
OPS_URL="http://localhost:9925"

curl -sf -X POST "$OPS_URL" -H "Content-Type: application/json" -H "Authorization: $HARPER_ADMIN_AUTH" -d '{
  "operation": "add_role",
  "role": "tps_agent",
  "permission": {
    "super_user": false,
    "data": {
      "tables": {
        "Agent": { "read": true, "insert": true, "update": true, "delete": false, "attribute_permissions": [] },
        "Memory": { "read": true, "insert": true, "update": true, "delete": true, "attribute_permissions": [] },
        "Soul": { "read": true, "insert": true, "update": true, "delete": true, "attribute_permissions": [] },
        "Integration": { "read": true, "insert": true, "update": true, "delete": true, "attribute_permissions": [] }
      }
    }
  }
}' 2>/dev/null && echo "Role created." || echo "Role may already exist (ok)."

curl -sf -X POST "$OPS_URL" -H "Content-Type: application/json" -H "Authorization: $HARPER_ADMIN_AUTH" -d '{
  "operation": "add_user",
  "username": "tps_agent",
  "password": "tps_agent_internal_only",
  "role": "tps_agent",
  "active": true
}' 2>/dev/null && echo "User created." || echo "User may already exist (ok)."

echo "tps_agent setup complete."
