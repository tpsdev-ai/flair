#!/usr/bin/env bash
# test-clean-vm.sh — the REALISTIC user-environment gate (ops-cd37).
#
# Reproduces what a real user gets and what CI's existing from-scratch test
# does NOT: flair installed via a ROOT/global `npm install -g` (root-owned
# package dir), then `flair init` + Harper run as a NON-ROOT user, with NO
# FLAIR_MODELS_DIR override (the real default model-path resolution).
#
# This is the exact shape of the showstopper fixed in #538: a fresh
#   sudo npm install -g @tpsdev-ai/flair
# left semantic search dead because the embeddings model targeted the
# root-owned package dir and Harper-as-user couldn't write it (EACCES) →
# recall silently fell back to keyword-only while `flair init` reported success.
#
# The old Dockerfile.test never caught it because it runs as ROOT (no perms
# mismatch) AND sets FLAIR_MODELS_DIR=/opt/flair-models (a writable override).
# That isn't the user's environment. This script IS.
#
# Runs as the non-root flairuser inside the container (see Dockerfile.clean-vm).
# Exit 0 on success, non-zero on any failure.

set -euo pipefail

# flair was installed globally as root → `flair` is on PATH, package dir is
# root-owned. We invoke the global binary, NOT a repo-relative dist/cli.js,
# so we exercise the published file set exactly as a real user gets it.
ADMIN_PASS="cleanvm-admin"
PORT="9926"
AGENT_ID="cleanvmbot"

# Sanity: we must NOT be root (the whole point of this gate).
if [ "$(id -u)" = "0" ]; then
  echo "ERROR: test-clean-vm.sh must run as a non-root user (running as uid 0)."
  echo "       The realistic gate requires a non-root user against a root-owned install."
  exit 1
fi

# Sanity: NO model-path override may be set — we test the real default.
if [ -n "${FLAIR_MODELS_DIR:-}" ]; then
  echo "ERROR: FLAIR_MODELS_DIR is set ($FLAIR_MODELS_DIR) — this gate must test"
  echo "       the DEFAULT model-path resolution, not a writable override."
  exit 1
fi

# Dump diagnostics on any failure (Harper + HDB logs) for CI debugging.
trap '
  echo ""
  echo "=== Harper stdout/stderr log ==="
  cat "$HOME/.flair/data/harper.log" 2>/dev/null || echo "(no flair log found)"
  echo "=== HDB log ==="
  find "$HOME" /tmp -name "hdb.log" 2>/dev/null | head -3 | while read -r f; do echo "--- $f ---"; tail -100 "$f"; done
  echo "=== whoami / perms ==="
  echo "uid=$(id -u) user=$(whoami) HOME=$HOME"
  echo "global flair: $(command -v flair) → $(readlink -f "$(command -v flair)" 2>/dev/null)"
  echo "package dir owner: $(ls -ld "$(dirname "$(readlink -f "$(command -v flair)")")/.." 2>/dev/null)"
  echo "user models dir: $(ls -la "$HOME/.flair/data/models" 2>&1 | head)"
  echo "=== end ==="
' ERR

echo "=============================================="
echo " Clean-VM gate: non-root sudo-install + embed→search verify"
echo "=============================================="
echo "user:  $(whoami) (uid $(id -u))"
echo "HOME:  $HOME"
echo "flair: $(command -v flair)"
echo "FLAIR_MODELS_DIR: ${FLAIR_MODELS_DIR:-<unset> (testing real default)}"
echo ""

# ── Step 1: flair init as the non-root user ──────────────────────────────────
# All defaults: data → ~/.flair/data, keys → ~/.flair/keys, model →
# <ROOTPATH=~/.flair/data>/models (the #538 user-writable default). No
# FLAIR_MODELS_DIR. `flair init` runs the #533 embed-verification at the end.
echo "[1/3] flair init --agent-id $AGENT_ID --port $PORT (no model-dir override)"
INIT_OUTPUT=$(flair init \
  --agent-id "$AGENT_ID" \
  --admin-pass "$ADMIN_PASS" \
  --port "$PORT" \
  --skip-soul 2>&1) || { echo "$INIT_OUTPUT"; echo "ERROR: flair init exited non-zero"; exit 1; }
echo "$INIT_OUTPUT"
echo ""

# ── Step 2: assert init's #533 embed-verification reported OPERATIONAL ────────
# `flair init` PRINTS "Semantic search DEGRADED" but does NOT exit non-zero on
# degraded — so the exit code alone would not catch a regression. Assert on the
# verification line directly: it must say operational, never degraded.
echo "[2/3] Asserting init's semantic-search verification (#533)..."
if echo "$INIT_OUTPUT" | grep -qi "Semantic search DEGRADED"; then
  echo "FAIL: init reported 'Semantic search DEGRADED' — embeddings not loaded."
  echo "      This is the #538 regression: model targeted a non-writable dir on a"
  echo "      root-owned install and recall fell back to keyword-only."
  exit 1
fi
if ! echo "$INIT_OUTPUT" | grep -qi "Semantic search operational"; then
  echo "FAIL: init did not report 'Semantic search operational' — semantic"
  echo "      verification did not pass (degraded or skipped). Recall-by-meaning"
  echo "      is not confirmed working on this realistic install."
  exit 1
fi
echo "  ✓ init: Semantic search operational"
echo ""

# ── Step 3: hard gate — `flair doctor` must exit 0 ───────────────────────────
# `flair doctor` runs the SAME real embed→paraphrase round-trip
# (verifySemanticSearch) and `process.exit(1)` if issues > 0. A degraded
# semantic search is an issue → doctor exits non-zero. This is the
# belt-and-suspenders hard assertion: a genuine semantic score on a paraphrase
# query with ZERO keyword overlap. Keyword-only fallback cannot satisfy it.
echo "[3/3] flair doctor --agent $AGENT_ID --port $PORT (hard semantic gate)"
DOCTOR_OUTPUT=$(flair doctor --agent "$AGENT_ID" --port "$PORT" 2>&1) || {
  echo "$DOCTOR_OUTPUT"
  echo ""
  echo "FAIL: flair doctor exited non-zero — semantic search is DEGRADED on a"
  echo "      realistic non-root sudo-install. The embeddings model could not be"
  echo "      written/loaded (the #538 showstopper class). Recall-by-meaning is dead."
  exit 1
}
echo "$DOCTOR_OUTPUT"
echo ""
# Defense in depth: doctor exited 0, but also confirm the semantic line is OK
# and not a degraded line that somehow slipped past the exit code.
if echo "$DOCTOR_OUTPUT" | grep -qi "Semantic search DEGRADED"; then
  echo "FAIL: flair doctor exited 0 but still printed 'Semantic search DEGRADED'."
  exit 1
fi
echo "  ✓ doctor: exit 0, semantic search verified"
echo ""

echo "=============================================="
echo "✅ Clean-VM gate PASSED"
echo "   Realistic non-root sudo-install → flair init → embed→paraphrase"
echo "   round-trip returns a genuine semantic score. The #538 fix holds."
echo "=============================================="
