#!/usr/bin/env bash
# Cloud Agent install — idempotent dev-environment bootstrap for Flair.
#
# Runs after the repository is checked out. Prepares everything the standard
# dev loop needs (CONTRIBUTING.md / docs/quickstart.md):
#   * Bun 1.3.10          — the pinned package manager + test runner (`bun test`)
#   * A Harper-compatible Node (^22.18 || >=24) — Harper 5.2 refuses to boot on
#     older Node, and the cloud harness injects an older `node` ahead of the
#     base image's on PATH, so a compatible one is pinned at the front.
#   * Dependencies (bun install), the linux-x64 native embedding backend, and a
#     full build of the Harper resources, the CLI, and the flair-client package.
#   * The pinned embedding-model GGUF, pre-fetched into ./models where the
#     integration harness and `flair init` look for it.
#
# Safe to run repeatedly: every step is a no-op when already satisfied.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUN_VERSION="1.3.10"                               # package.json "packageManager"
NODE_FALLBACK_VERSION="v22.23.2"                   # only used if no compatible node exists
MODEL_FILE="nomic-embed-text-v1.5.Q4_K_M.gguf"     # the default embedding model

# ── 1. Bun (pinned to the version CI and package.json use) ───────────────────
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  echo "Installing Bun ${BUN_VERSION}..."
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
fi
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"               # bun's installer prepends this too

# ── 2. Harper-compatible Node on the front of PATH ───────────────────────────
# Harper 5.2 requires ^22.18.0 || >=24.0.0. Front-of-PATH ~/.bun/bin is the one
# directory that reliably precedes the harness-injected node, so a compatible
# node is symlinked there. Prefer any compatible node already on the box
# (e.g. nvm's), and only download a pinned tarball as a last resort.
node_is_compatible() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a>22||(a===22&&b>=18))?0:1)' 2>/dev/null
}
if ! node_is_compatible "$(command -v node || echo /nonexistent)"; then
  COMPAT_NODE=""
  for cand in /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node /usr/bin/node; do
    [ -x "$cand" ] || continue
    if node_is_compatible "$cand"; then COMPAT_NODE="$cand"; break; fi
  done
  if [ -z "$COMPAT_NODE" ]; then
    echo "No compatible Node found — downloading Node ${NODE_FALLBACK_VERSION}..."
    NODE_DIR="$HOME/.local/node-${NODE_FALLBACK_VERSION}"
    if [ ! -x "$NODE_DIR/bin/node" ]; then
      mkdir -p "$NODE_DIR"
      curl -fsSL "https://nodejs.org/dist/${NODE_FALLBACK_VERSION}/node-${NODE_FALLBACK_VERSION}-linux-x64.tar.xz" \
        | tar -xJ -C "$NODE_DIR" --strip-components=1
    fi
    COMPAT_NODE="$NODE_DIR/bin/node"
  fi
  NODE_BIN_DIR="$(dirname "$COMPAT_NODE")"
  ln -sf "$COMPAT_NODE" "$BUN_INSTALL/bin/node"
  [ -x "$NODE_BIN_DIR/npm" ] && ln -sf "$NODE_BIN_DIR/npm" "$BUN_INSTALL/bin/npm" || true
  [ -x "$NODE_BIN_DIR/npx" ] && ln -sf "$NODE_BIN_DIR/npx" "$BUN_INSTALL/bin/npx" || true
  hash -r
fi
echo "Toolchain: node $(node --version) · bun $(bun --version)"

# ── 3. Dependencies ──────────────────────────────────────────────────────────
echo "Installing dependencies..."
bun install --frozen-lockfile
# flair declares the mac-arm64 embedding binary as the optional dep; on linux we
# add the matching native backend so the embeddings engine can load (--no-save
# keeps package.json / bun.lock untouched).
bun add --no-save @node-llama-cpp/linux-x64@3

# ── 4. Build resources, CLI, and the workspace client package ────────────────
echo "Building Flair resources + CLI..."
bun run build
bun run build:cli
# flair-client ships as a workspace dep other packages resolve via its dist/.
( cd packages/flair-client && bun run build )

# ── 5. Pre-fetch the embedding model (sha256-pinned) ─────────────────────────
# The integration harness and `flair init` read ./models via FLAIR_MODELS_DIR;
# pre-fetching keeps first-run tests fast and offline-capable. Non-fatal: the
# embeddings engine will download on first use if this is skipped.
echo "Pre-fetching embedding model..."
bash scripts/ci/fetch-model.sh "$MODEL_FILE" "$REPO_ROOT/models" \
  || echo "warn: model pre-fetch failed; it will download on first use"

echo "Flair dev environment ready."
