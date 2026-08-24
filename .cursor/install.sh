#!/usr/bin/env bash
# Cloud Agent install — idempotent dev-environment bootstrap for Flair.
#
# Runs after the repository is checked out. Prepares everything the standard
# dev loop needs (CONTRIBUTING.md / docs/quickstart.md):
#   * Bun 1.3.10          — the pinned package manager + test runner (`bun test`),
#     installed from the sha256-pinned official release archive (no curl | bash).
#   * A Harper-compatible Node (^22.18 || >=24) — Harper 5.2 refuses to boot on
#     older Node, and the cloud harness injects an older `node` ahead of the
#     base image's on PATH, so a compatible one is pinned at the front.
#   * Dependencies (bun install), the linux-x64 native embedding backend, and a
#     full build of the Harper resources, the CLI, and the flair-client package.
#   * The pinned embedding-model GGUF, pre-fetched into ./models and wired to the
#     agent's shells via FLAIR_MODELS_DIR so both `flair init` and the integration
#     harness reuse it instead of re-downloading.
#
# Safe to run repeatedly: every step is a no-op when already satisfied.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUN_VERSION="1.3.10"                               # package.json "packageManager"
# sha256 of bun-linux-x64.zip @ bun-v1.3.10, from the release's SHASUMS256.txt.
BUN_SHA256="f57bc0187e39623de716ba3a389fda5486b2d7be7131a980ba54dc7b733d2e08"
NODE_FALLBACK_VERSION="v22.23.2"                   # only used if no compatible node exists
# sha256 of node-<ver>-linux-x64.tar.xz @ NODE_FALLBACK_VERSION, from nodejs.org SHASUMS256.txt.
NODE_FALLBACK_SHA256="d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307"
MODEL_FILE="nomic-embed-text-v1.5.Q4_K_M.gguf"     # the default embedding model

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"               # bun's bin dir, front of PATH
# Ensure the front-of-PATH bin dir exists before anything writes into it — both
# the Bun install and the Node symlink below target it, and the Node pin runs
# even when Bun is already present (its install branch is then skipped).
mkdir -p "$BUN_INSTALL/bin"

# ── 1. Bun (pinned + sha256-verified official release archive) ───────────────
# Installed from the pinned release zip rather than `curl | bash`: deterministic,
# supply-chain-auditable (checksum-gated), and no remote script executes.
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  echo "Installing Bun ${BUN_VERSION}..."
  bun_tmp="$(mktemp -d)"
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    -o "$bun_tmp/bun.zip"
  echo "${BUN_SHA256}  ${bun_tmp}/bun.zip" | sha256sum -c -
  unzip -q "$bun_tmp/bun.zip" -d "$bun_tmp"
  install -m 0755 "$bun_tmp/bun-linux-x64/bun" "$BUN_INSTALL/bin/bun"
  ln -sf "$BUN_INSTALL/bin/bun" "$BUN_INSTALL/bin/bunx"
  rm -rf "$bun_tmp"
fi

# ── 2. Harper-compatible Node on the front of PATH ───────────────────────────
# Harper 5.2 requires ^22.18.0 || >=24.0.0. Front-of-PATH ~/.bun/bin is the one
# directory that reliably precedes the harness-injected node, so a compatible
# node is symlinked there. Prefer any compatible node already on the box
# (e.g. nvm's), and only download a pinned tarball as a last resort.
node_is_compatible() {
  # Accept exactly Harper's range: 22.18+ on the 22.x line, or 24 and newer.
  # (Node 23 is deliberately excluded — it is outside ^22.18.0 || >=24.0.0.)
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(((a===22&&b>=18)||a>=24)?0:1)' 2>/dev/null
}
if ! node_is_compatible "$(command -v node || echo /nonexistent)"; then
  COMPAT_NODE=""
  for cand in /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node /usr/bin/node; do
    [ -x "$cand" ] || continue
    if node_is_compatible "$cand"; then COMPAT_NODE="$cand"; break; fi
  done
  if [ -z "$COMPAT_NODE" ]; then
    NODE_DIR="$HOME/.local/node-${NODE_FALLBACK_VERSION}"
    # Reuse the cache only if it holds a genuinely compatible node — never trust a
    # bare `[ -x bin/node ]`, which would pin a partial/corrupt tree from an
    # interrupted earlier run. Otherwise download to a temp dir, checksum-gate the
    # tarball, extract there, and promote to the cache ONLY after the extracted
    # binary passes node_is_compatible; wipe the temp dir on any failure.
    if ! { [ -x "$NODE_DIR/bin/node" ] && node_is_compatible "$NODE_DIR/bin/node"; }; then
      echo "No compatible Node found — downloading Node ${NODE_FALLBACK_VERSION}..."
      rm -rf "$NODE_DIR"
      node_tmp="$(mktemp -d)"
      curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
        "https://nodejs.org/dist/${NODE_FALLBACK_VERSION}/node-${NODE_FALLBACK_VERSION}-linux-x64.tar.xz" \
        -o "$node_tmp/node.tar.xz"
      echo "${NODE_FALLBACK_SHA256}  ${node_tmp}/node.tar.xz" | sha256sum -c -
      mkdir -p "$node_tmp/extract"
      tar -xJf "$node_tmp/node.tar.xz" -C "$node_tmp/extract" --strip-components=1
      if node_is_compatible "$node_tmp/extract/bin/node"; then
        mkdir -p "$(dirname "$NODE_DIR")"
        mv "$node_tmp/extract" "$NODE_DIR"
      else
        rm -rf "$node_tmp"
        echo "error: downloaded Node ${NODE_FALLBACK_VERSION} is not Harper-compatible" >&2
        exit 1
      fi
      rm -rf "$node_tmp"
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

# ── 5. Pre-fetch the embedding model (sha256-pinned) and wire it up ───────────
# resolveModelsDir() (resources/models-dir.ts) and the integration harness both
# honor FLAIR_MODELS_DIR first. Pre-fetch the model once, then export that dir to
# the agent's shells so `flair init` and `bun test test/integration` reuse the
# warm copy instead of re-downloading on first run. Non-fatal: the embeddings
# engine still downloads on demand if the pre-fetch is skipped.
MODELS_DIR="$REPO_ROOT/models"
echo "Pre-fetching embedding model..."
bash scripts/ci/fetch-model.sh "$MODEL_FILE" "$MODELS_DIR" \
  || echo "warn: model pre-fetch failed; it will download on first use"
if ! grep -qs 'FLAIR_MODELS_DIR=' "$HOME/.bashrc" 2>/dev/null; then
  printf '\n# Flair dev env: reuse the pre-fetched embedding model (.cursor/install.sh)\nexport FLAIR_MODELS_DIR=%q\n' "$MODELS_DIR" >> "$HOME/.bashrc"
fi

echo "Flair dev environment ready."
