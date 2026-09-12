#!/usr/bin/env node
/**
 * materialize-bundled-descriptors.mjs — flair#1580 pack/install.
 *
 * `@tpsdev-ai/flair-tool-descriptors` is a new workspace package (first-publish
 * still pending). Root and flair-mcp declare it as a runtime dependency, so
 * `npm install` of a packed tarball 404s on the registry. `bundleDependencies`
 * puts the package inside those tarballs — but bun's workspace link is a
 * symlink, and `npm pack` will not follow it into the payload.
 *
 * This script replaces that symlink with a real directory containing only the
 * publishable files (`package.json` + `files[]`). `npm pack` then embeds it.
 *
 * Docker pack images (Dockerfile.first-run-hostile, Dockerfile.clean-vm,
 * Dockerfile.test) copy this file next to write-build-info.mjs. They do not
 * COPY all of scripts/. Leaving it out makes `npm pack` → prepack
 * MODULE_NOT_FOUND (exit 1). A files[]-only pack stage (upgrade-liveness)
 * must copy PACK_STAGE_EXTRAS for the same reason.
 *
 * Success logs go to stderr. `npm pack --silent` still runs prepack, and
 * callers capture stdout as the tarball path (`TGZ=$(npm pack --silent)` in
 * the audit gate; `npm pack --dry-run --json` in the health stamp IT). A
 * stdout line here concatenates into that path (ENOENT) or precedes the
 * JSON array so JSON.parse fails.
 *
 * Usage (cwd = the package being packed):
 *   node scripts/materialize-bundled-descriptors.mjs
 *
 * Exit codes:
 *   0 — dest/node_modules/@tpsdev-ai/flair-tool-descriptors/dist/index.js exists
 *   1 — source missing, build failed, or dest could not be written
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const BUNDLED_NAME = "@tpsdev-ai/flair-tool-descriptors";
export const BUNDLED_REL = "packages/flair-tool-descriptors";

/** Extra paths a files[]-only pack stage must copy so prepack can run. */
export const PACK_STAGE_EXTRAS = [
  "scripts/materialize-bundled-descriptors.mjs",
  "scripts/materialize-patched-harper.mjs",
  "scripts/alasql-rn-peer.mjs",
  BUNDLED_REL,
];

/** Build the package without assuming bun, a workspace link, or `npm run`. */
export function buildDescriptors(src, repoRoot) {
  const tscCandidates = [
    join(src, "node_modules", "typescript", "bin", "tsc"),
    join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
  ];
  const tsc = tscCandidates.find((p) => existsSync(p));
  if (tsc) {
    const built = spawnSync(process.execPath, [tsc, "--noCheck"], { cwd: src, stdio: "inherit" });
    if (built.status === 0) return;
  }
  const npm = spawnSync("npm", ["run", "build"], { cwd: src, stdio: "inherit" });
  if (npm.status !== 0) {
    throw new Error(`failed to build ${BUNDLED_NAME} (tsc=${tsc ?? "none"} npm-exit ${npm.status ?? "null"})`);
  }
}

export function findRepoRoot(from) {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, BUNDLED_REL, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`cannot find ${BUNDLED_REL}/package.json walking up from ${from}`);
    }
    dir = parent;
  }
}

export function materializeBundledDescriptors(callerRoot, repoRoot = findRepoRoot(callerRoot)) {
  const src = join(repoRoot, BUNDLED_REL);
  const srcPkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  if (srcPkg.name !== BUNDLED_NAME) {
    throw new Error(`${src}/package.json name is ${srcPkg.name}, expected ${BUNDLED_NAME}`);
  }
  if (!existsSync(join(src, "dist", "index.js"))) {
    buildDescriptors(src, repoRoot);
    if (!existsSync(join(src, "dist", "index.js"))) {
      throw new Error(`failed to build ${BUNDLED_NAME}: ${join(src, "dist", "index.js")} still missing`);
    }
  }
  const entries = ["package.json", ...(srcPkg.files ?? [])].map((f) => String(f).replace(/\/+$/, ""));
  for (const entry of entries) {
    if (!existsSync(join(src, entry))) {
      throw new Error(`${BUNDLED_NAME} files[] entry missing at ${join(src, entry)}`);
    }
  }

  const dest = join(callerRoot, "node_modules", ...BUNDLED_NAME.split("/"));
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    cpSync(join(src, entry), join(dest, entry), { recursive: true });
  }
  const js = join(dest, "dist", "index.js");
  if (!existsSync(js)) throw new Error(`materialize left no ${js}`);
  return dest;
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && thisFile === invoked) {
  try {
    const dest = materializeBundledDescriptors(process.cwd());
    console.error(`materialized ${BUNDLED_NAME} → ${dest}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
