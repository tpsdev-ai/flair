#!/usr/bin/env bash
# setup-vm.sh — Set up Flair + Claude Code MCP on a fresh exe.dev VM
#
# Usage: ./scripts/setup-vm.sh <vm-hostname>
# Example: ./scripts/setup-vm.sh tps-claude.exe.xyz
#
# Prerequisites:
#   - SSH access to the VM (configured in ~/.ssh/config)
#   - Node.js installed on the VM (exe.dev VMs have it by default)
#
# What it does:
#   1. Installs @tpsdev-ai/flair globally
#   2. Runs flair init (starts Harper, creates database, registers default agent)
#   3. Creates a test project with .mcp.json for Claude Code
#   4. Adds bootstrap instruction to CLAUDE.md

set -euo pipefail

VM="${1:?Usage: $0 <vm-hostname>}"
AGENT_ID="${2:-local}"
ADMIN_PASS="${3:-$(openssl rand -base64 18)}"
PROJECT_DIR="${4:-test-project}"

echo "=== Setting up Flair on $VM ==="
echo "  Agent: $AGENT_ID"
echo "  Project: ~/$PROJECT_DIR"
echo ""

# Step 1: Verify we're on the right host
HOSTNAME=$(ssh "$VM" 'hostname')
echo "[1/5] Connected to: $HOSTNAME"
if [ "$HOSTNAME" != "$(echo "$VM" | sed 's/\.exe\.xyz//')" ]; then
  echo "WARNING: hostname '$HOSTNAME' doesn't match expected '$(echo "$VM" | sed 's/\.exe\.xyz//')'"
  read -p "Continue? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# Step 2: Install Flair
echo ""
echo "[2/5] Installing @tpsdev-ai/flair..."
ssh "$VM" 'sudo npm install -g @tpsdev-ai/flair@latest 2>&1 | tail -3'
ssh "$VM" 'which flair && flair --version' || {
  echo "ERROR: flair not in PATH after install"
  exit 1
}

# Step 3: Init Flair
echo ""
echo "[3/5] Initializing Flair..."
ssh "$VM" "flair init --agent-id $AGENT_ID --admin-pass '$ADMIN_PASS' 2>&1 | tail -10"

# Verify
ssh "$VM" 'flair status 2>&1'

# Step 4: Create project with MCP config
echo ""
echo "[4/5] Creating project with MCP config..."
ssh "$VM" "mkdir -p ~/$PROJECT_DIR && cat > ~/$PROJECT_DIR/.mcp.json << 'MCPEOF'
{
  \"mcpServers\": {
    \"flair\": {
      \"command\": \"npx\",
      \"args\": [\"@tpsdev-ai/flair-mcp\"],
      \"env\": {
        \"FLAIR_AGENT_ID\": \"$AGENT_ID\"
      }
    }
  }
}
MCPEOF"

# Step 5: Create CLAUDE.md with bootstrap instruction
echo ""
echo "[5/5] Creating CLAUDE.md..."
ssh "$VM" "cat > ~/$PROJECT_DIR/CLAUDE.md << 'CLAUDEEOF'
# Project Memory

At the start of every session, run mcp__flair__bootstrap before responding.

## Memory

You have persistent memory via Flair. Use it to remember context across sessions.

- Remember something: use the memory_store tool
- Search memory: use the memory_search tool
- Store lessons and decisions with durability: persistent
CLAUDEEOF"

# Verify
echo ""
echo "=== Verification ==="
ssh "$VM" "echo 'Host: $(hostname)' && flair status && echo '' && echo 'MCP config:' && cat ~/$PROJECT_DIR/.mcp.json && echo '' && echo 'CLAUDE.md:' && cat ~/$PROJECT_DIR/CLAUDE.md"

echo ""
echo "=============================="
echo "✅ Flair setup complete on $VM"
echo ""
echo "   SSH in and start Claude Code:"
echo "     ssh $VM"
echo "     cd ~/$PROJECT_DIR && claude"
echo "=============================="
