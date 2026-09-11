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
 * Usage (cwd = the package being packed):
 *   node scripts/materialize-bundled-descriptors.mjs
 *
 * Exit codes:
 *   0 — dest/node_modules/@tpsdev-ai/flair-tool-descriptors/dist/index.js exists
 *   1 — source missing, build failed, or dest could not be written
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const BUNDLED_NAME = "@tpsdev-ai/flair-tool-descriptors";
export const BUNDLED_REL = "packages/flair-tool-descriptors";

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
    const built = spawnSync("npm", ["run", "build"], { cwd: src, stdio: "inherit" });
    if (built.status !== 0) {
      throw new Error(`failed to build ${BUNDLED_NAME} (exit ${built.status ?? "null"})`);
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
const invoked = process.argv[1] ? fileURLToPath(pathToFileURL(process.argv[1])) : "";
if (invoked && thisFile === invoked) {
  try {
    const dest = materializeBundledDescriptors(process.cwd());
    console.log(`materialized ${BUNDLED_NAME} → ${dest}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
