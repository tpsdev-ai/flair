/**
 * models-dir.ts — the ONE place that decides where model GGUFs live.
 *
 * Extracted from embeddings-provider.ts (flair#815) so the reranker
 * (rerank-provider.ts) can share the exact same resolution WITHOUT importing
 * embeddings-provider: several unit-isolated tests `mock.module()` the whole
 * embeddings-provider module (with only the named exports THEY consume), and
 * bun's module cache is process-wide — so any new cross-module import of
 * embeddings-provider from another resource makes those mocks incomplete and
 * kills unrelated test files at module load. This module is tiny, pure
 * node-stdlib, and never mocked, so both providers (and any future model
 * consumer) can depend on it safely.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the directory model GGUFs live in / download into — shared by the
 * embedding engine (embeddings-boot.ts's `register()` options) and the
 * cross-encoder reranker (rerank-provider.ts, flair#815 — it used to hardcode
 * `<cwd>/models`, silently failing open wherever Harper's cwd wasn't the
 * models location).
 *
 * Resolution order (everything writable, never the read-only package dir):
 *   1. FLAIR_MODELS_DIR        — explicit operator/docker override.
 *   2. <ROOTPATH>/models       — Harper's data dir (Flair passes ROOTPATH =
 *                                ~/.flair/data when it spawns Harper). User-
 *                                owned and writable even on sudo-global installs.
 *   3. <cwd>/models            — ONLY if a model already lives there. Backward
 *                                compat for existing writable installs that
 *                                downloaded into the package dir before this fix;
 *                                never used as a download target on fresh installs.
 *   4. ~/.flair/data/models    — last-resort default when ROOTPATH is unset.
 *
 * The chosen dir is always writable, so the embeddings engine can download the
 * model on first use without hitting EACCES on a root-owned package dir.
 *
 * Tested independently (test/unit/embeddings-models-dir.test.ts, via
 * embeddings-provider's re-export) as the single documented source of truth
 * for this default.
 */
export function resolveModelsDir(): string {
  const override = process.env.FLAIR_MODELS_DIR;
  if (override) return override;

  const rootPath = process.env.ROOTPATH;
  if (rootPath) return join(rootPath, "models");

  // Backward compat: a prior (writable) install may have the model cached in
  // the package dir. Reuse it rather than re-downloading — but only if present.
  const cwdModels = join(process.cwd(), "models");
  if (existsSync(cwdModels)) return cwdModels;

  return join(homedir(), ".flair", "data", "models");
}
