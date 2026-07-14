#!/usr/bin/env bash
# fetch-model.sh — resolve a pinned embedding-model GGUF for CI lanes
# (flair#715).
#
# An HF outage on 2026-07-13 (sustained 403s) took five CI lanes red for
# hours with zero code at fault, and the same outage broke local
# fresh-clone runs (the in-process fallback download hits the same URL).
# actions/cache is not a guarantee either — 7-day/size-pressure eviction
# plus an HF outage still means red lanes with no recovery path but
# waiting. This script gives every lane (and, via the Dockerfile.test
# build, the from-scratch Docker lane too) one shared resolution order:
#
#   1. Already present at <dest-dir>/<filename> with a matching sha256 —
#      done. This is the actions/cache-hit path: point the cache step's
#      `path:` at the same file this script writes and a cache hit makes
#      this script a no-op.
#   2. First-party GitHub release asset on this repo's `ci-models` tag —
#      same-origin with the runner's existing GitHub access, no external
#      availability dependency, no new secret (public repo — plain curl
#      works unauthenticated).
#   3. HuggingFace — last resort.
#
# The sha256 is ALWAYS verified after download, regardless of source
# (today's raw HF curl has no integrity check at all — flair#715 calls
# that out as a supply-chain gap to close at the same time).
#
# Usage: fetch-model.sh <model-filename> <dest-dir> [expected-sha256]
#
# The expected sha256 is looked up by filename from model-checksums.txt
# (next to this script) when the third argument is omitted. That file is
# the single pinned source of truth — callers should not hardcode the hash
# per workflow; pass it explicitly only to override for a one-off (e.g.
# local testing of a checksum-mismatch path).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKSUMS_FILE="${SCRIPT_DIR}/model-checksums.txt"

if [[ $# -lt 2 ]]; then
  echo "usage: fetch-model.sh <model-filename> <dest-dir> [expected-sha256]" >&2
  exit 1
fi

MODEL_FILENAME="$1"
DEST_DIR="$2"
EXPECTED_SHA256="${3:-}"

if [[ -z "$EXPECTED_SHA256" ]]; then
  EXPECTED_SHA256="$(awk -v f="$MODEL_FILENAME" '$1 == f { print $2 }' "$CHECKSUMS_FILE")"
  if [[ -z "$EXPECTED_SHA256" ]]; then
    echo "::error::fetch-model.sh: no pinned sha256 for '${MODEL_FILENAME}' in ${CHECKSUMS_FILE} (and none passed as \$3)" >&2
    exit 1
  fi
fi

# Overridable for testing; real callers should rely on the defaults.
GITHUB_MIRROR_REPO="${FETCH_MODEL_MIRROR_REPO:-tpsdev-ai/flair}"
GITHUB_MIRROR_TAG="${FETCH_MODEL_MIRROR_TAG:-ci-models}"
HF_REPO="${FETCH_MODEL_HF_REPO:-nomic-ai/nomic-embed-text-v1.5-GGUF}"

DEST_PATH="${DEST_DIR}/${MODEL_FILENAME}"

sha256_of() {
  sha256sum "$1" | awk '{ print $1 }'
}

verify() {
  local path="$1" actual
  actual="$(sha256_of "$path")"
  if [[ "$actual" != "$EXPECTED_SHA256" ]]; then
    echo "::error::fetch-model.sh: sha256 mismatch for ${path} — expected ${EXPECTED_SHA256}, got ${actual}" >&2
    return 1
  fi
  echo "fetch-model.sh: sha256 verified for ${path} (${EXPECTED_SHA256})"
}

download() {
  local url="$1" label="$2"
  echo "fetch-model.sh: attempting ${label}: ${url}"
  if curl -fSL --retry 5 --retry-delay 10 --retry-all-errors --connect-timeout 30 \
      "$url" -o "${DEST_PATH}.partial"; then
    mv "${DEST_PATH}.partial" "$DEST_PATH"
    return 0
  fi
  rm -f "${DEST_PATH}.partial"
  echo "fetch-model.sh: ${label} download failed" >&2
  return 1
}

mkdir -p "$DEST_DIR"

# 1. Already present (the actions/cache-hit path).
if [[ -f "$DEST_PATH" ]]; then
  if verify "$DEST_PATH"; then
    echo "fetch-model.sh: ${DEST_PATH} already present and verified — skipping download"
    exit 0
  fi
  echo "fetch-model.sh: ${DEST_PATH} present but checksum mismatch — re-downloading" >&2
  rm -f "$DEST_PATH"
fi

# 2. First-party GitHub release asset mirror.
GITHUB_URL="https://github.com/${GITHUB_MIRROR_REPO}/releases/download/${GITHUB_MIRROR_TAG}/${MODEL_FILENAME}"
if download "$GITHUB_URL" "GitHub release mirror"; then
  if verify "$DEST_PATH"; then
    echo "fetch-model.sh: ${MODEL_FILENAME} ready at ${DEST_PATH} ($(du -sh "$DEST_PATH" | cut -f1), via GitHub release mirror)"
    exit 0
  fi
  rm -f "$DEST_PATH"
  echo "fetch-model.sh: GitHub mirror asset failed checksum verification — falling back to HuggingFace" >&2
fi

# 3. HuggingFace (last resort).
HF_URL="https://huggingface.co/${HF_REPO}/resolve/main/${MODEL_FILENAME}"
if download "$HF_URL" "HuggingFace"; then
  if verify "$DEST_PATH"; then
    echo "fetch-model.sh: ${MODEL_FILENAME} ready at ${DEST_PATH} ($(du -sh "$DEST_PATH" | cut -f1), via HuggingFace)"
    exit 0
  fi
  rm -f "$DEST_PATH"
  echo "::error::fetch-model.sh: HuggingFace asset failed checksum verification" >&2
  exit 1
fi

echo "::error::fetch-model.sh: failed to fetch ${MODEL_FILENAME} from both the GitHub release mirror (${GITHUB_URL}) and HuggingFace (${HF_URL})" >&2
exit 1
