// Published-path helpers for the docs-freshness changelog rule (flair#1098).
//
// "Does this path ship?" is a checkable fact: package.json's `files[]`, the same
// set `publishedEntryNames()` in src/deploy.ts already reads. Hardcoding a second
// list here is how the two sides drift. This module derives the set the same way
// that function does — same `files[]` parse, same npm always-includes, same
// `.env` deploy extra — and a unit test asserts the two Sets are equal on this
// repo so a change to one without the other is a failure, not a comment.
//
// Source trees are not in `files[]`. `src/` and `resources/` compile into the
// published `dist/` entry. A top-level-name-only check would treat them as
// unpublished and silently stop requiring fragments on real shipping changes —
// the failure direction flair#1098 calls the worst one.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Keep lockstep with `publishedEntryNames()` in src/deploy.ts, including the
// deploy-only `.env` extra (COMPONENT_ENV_FILENAME). The agreement test is the
// lock; do not edit one list without the other.
const ALWAYS = ["package.json", "README.md", "LICENSE", "LICENCE", ".env"];

// Trees that compile into a published `dist/` entry.
//   tsconfig.json            resources/** → dist/resources/**  (rootDir: ".")
//   tsconfig.cli.json        src/cli.ts   → dist/cli.js        (rootDir: "src")
//   tsconfig.check.src.json  src/**       → dist/src/**        (rootDir: ".")
const DIST_SOURCE_ROOTS = new Set(["src", "resources"]);

export function publishedEntryNames(packageRoot) {
  let declared = [];
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (Array.isArray(pkg.files)) declared = pkg.files;
  } catch {
    /* caller decides what an empty set means */
  }
  const names = declared
    .map((f) => String(f).replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((f) => f !== "" && !f.includes("*") && !f.startsWith("!"));
  return new Set([...names, ...ALWAYS]);
}

export function hasDeclaredFiles(packageRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return Array.isArray(pkg.files) && pkg.files.length > 0;
  } catch {
    return false;
  }
}

export function pathTouchesPublished(relPath, published) {
  const p = String(relPath).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!p) return false;
  const top = p.split("/")[0];
  if (published.has(top)) return true;
  // src/ and resources/ ship via dist/. Mapping must be present or a fix: on
  // src/cli.ts would look unpublished and the gate would go quiet.
  if (DIST_SOURCE_ROOTS.has(top) && published.has("dist")) return true;
  return false;
}

/**
 * Whether THIS change needs a changelog fragment.
 *
 * Fail-closed: if `files[]` is missing we cannot prove a path is unpublished,
 * and if the changed-path list is empty we cannot see what the change touched.
 * Either case keeps the existing require-a-fragment behaviour. The escape is
 * only the narrow case the issue named — every observed path is outside the
 * published set (after the source→dist mapping).
 */
export function changeTouchesPublished(relPaths, packageRoot) {
  if (!hasDeclaredFiles(packageRoot)) return true;
  const paths = (relPaths ?? []).map((p) => String(p).trim()).filter((p) => p !== "");
  if (paths.length === 0) return true;
  const published = publishedEntryNames(packageRoot);
  return paths.some((p) => pathTouchesPublished(p, published));
}
