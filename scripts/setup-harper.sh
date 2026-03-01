#!/usr/bin/env bash
set -euo pipefail

HARPER_DIR="node_modules/harperdb"
HARPER_DATA="${HARPER_DATA:-/tmp/harper-flair}"
HARPER_ADMIN_USER="${HARPER_ADMIN_USER:-admin}"
HARPER_ADMIN_PASS="${HARPER_ADMIN_PASS:-admin123}"
NODE="${NODE:-node}"
OPS_URL="http://localhost:9925"

[ -d "$HARPER_DIR" ] || { echo "Run 'bun install' first." >&2; exit 1; }

# Step 1: Build Harper v5 from source
echo "==> Building Harper v5 from source..."
npx tsc --project "$HARPER_DIR/tsconfig.build.json" --skipLibCheck --noCheck 2>&1 | grep -v "TS4023" || true

echo "==> Patching .ts requires..."
find "$HARPER_DIR" -name "*.js" \
  -not -path "$HARPER_DIR/dist/*" \
  -not -path "$HARPER_DIR/node_modules/*" \
  -not -path "$HARPER_DIR/unitTests/*" \
  -print0 | while IFS= read -r -d '' f; do
  if grep -q "require.*\.ts['\"]" "$f" 2>/dev/null; then
    perl -pi -e "s/require\('(.*?)\.ts'\)/require('\$1.js')/g; s/require\(\"(.*?)\.ts\"\)/require(\"\$1.js\")/g" "$f"
  fi
done

echo "==> Copying compiled JS for .ts-only files..."
find "$HARPER_DIR" -name "*.ts" \
  -not -path "$HARPER_DIR/dist/*" \
  -not -path "$HARPER_DIR/node_modules/*" \
  -not -name "*.d.ts" -print0 | while IFS= read -r -d '' f; do
  distf="$HARPER_DIR/dist/${f#$HARPER_DIR/}"
  distf="${distf%.ts}.js"
  srcjs="${f%.ts}.js"
  [ -f "$distf" ] && [ ! -f "$srcjs" ] && cp "$distf" "$srcjs"
done

# Step 2: Build Flair resources
echo "==> Building Flair resources..."
bun run build

# Step 3: Non-interactive Harper install (idempotent)
echo "==> Installing Harper data directory at $HARPER_DATA..."
ROOTPATH="$HARPER_DATA" \
  HDB_ADMIN_USERNAME="$HARPER_ADMIN_USER" \
  HDB_ADMIN_PASSWORD="$HARPER_ADMIN_PASS" \
  DEFAULTS_MODE=dev \
  NODE_HOSTNAME=localhost \
  "$NODE" "$HARPER_DIR/bin/harper.js" install 2>&1 || echo "(install may have already completed)"

# Step 4: Start Harper in background
echo "==> Starting Harper..."
nohup "$NODE" "$HARPER_DIR/bin/harper.js" dev . > "$HARPER_DATA/harper-stdout.log" 2>&1 &
HARPER_PID=$!
echo "Harper PID: $HARPER_PID"

# Wait for port
echo "==> Waiting for Harper to bind port 9926..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:9926/Health > /dev/null 2>&1; then
    echo "Harper is listening on port 9926."
    break
  fi
  [ "$i" -eq 30 ] && { echo "ERROR: Harper did not start within 30s"; exit 1; }
  sleep 1
done

# Step 5: Create tps_agent role and user
HARPER_ADMIN_AUTH="Basic $(echo -n "${HARPER_ADMIN_USER}:${HARPER_ADMIN_PASS}" | base64)"
echo "==> Setting up tps_agent role..."
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

echo "==> Setting up tps_agent user..."
curl -sf -X POST "$OPS_URL" -H "Content-Type: application/json" -H "Authorization: $HARPER_ADMIN_AUTH" -d '{
  "operation": "add_user",
  "username": "tps_agent",
  "password": "tps_agent_internal_only",
  "role": "tps_agent",
  "active": true
}' 2>/dev/null && echo "User created." || echo "User may already exist (ok)."

echo ""
echo "==> Flair is ready at http://localhost:9926"
echo "    Operations API at http://localhost:9925"
echo "    Harper PID: $HARPER_PID"
echo "    Logs: $HARPER_DATA/harper-stdout.log"
