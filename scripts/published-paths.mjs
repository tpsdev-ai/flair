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
// published `dist/` entry (mapped only when `dist` itself ships). `packages/`
// and `examples/` ship independently of that entry — workspace packages are
// separately published, and examples already appear in CHANGELOG.md. A
// top-level-name-only check would treat them as unpublished and silently stop
// requiring fragments on real shipping changes — the failure direction
// flair#1098 calls the worst one.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Keep lockstep with `publishedEntryNames()` in src/deploy.ts, including the
// deploy-only `.env` extra (COMPONENT_ENV_FILENAME). The agreement test is the
// lock; do not edit one list without the other.
const ALWAYS = ["package.json", "README.md", "LICENSE", "LICENCE", ".env"];

// Trees that compile into a published `dist/` entry. Mapped only when `dist`
// is in the published set — without that gate, a src/ change would look like
// it ships even if the package no longer publishes dist/.
//   tsconfig.json            resources/** → dist/resources/**  (rootDir: ".")
//   tsconfig.cli.json        src/cli.ts   → dist/cli.js        (rootDir: "src")
//   tsconfig.check.src.json  src/**       → dist/src/**        (rootDir: ".")
const DIST_SOURCE_ROOTS = new Set(["src", "resources"]);

// Trees that ship even when `dist` is absent from `files[]`. Same class of
// mapping as src/resources, but not conditional on dist: they are not compiled
// into the root tarball. `packages/` is the workspace of separately published
// npm packages (flair-client, flair-mcp, …). `examples/` already appears in
// release notes; omitting it would be the same silent-skip.
const INDEPENDENT_SHIPPING_ROOTS = new Set(["packages", "examples"]);

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

function workspacePatterns(packageRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
    if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) return pkg.workspaces.packages;
  } catch {
    /* no workspaces declared */
  }
  return [];
}

/** Top-level directory names declared as npm workspaces (`packages/*` → `packages`). */
export function workspaceTopLevels(packageRoot) {
  return new Set(
    workspacePatterns(packageRoot)
      .map((w) => String(w).replace(/^\.\//, "").split("/")[0])
      .filter((t) => t !== "" && t !== "*" && !t.startsWith("!")),
  );
}

/**
 * Top-level names that count as shipping for the changelog gate: `files[]` plus
 * npm always-includes, plus source trees that compile into `dist/`, plus
 * independently published trees (`packages/`, `examples/`), plus any extra
 * workspace roots declared in package.json. `publishedEntryNames()` stays the
 * deploy-filter set — this is that set plus the mappings the changelog rule
 * has to get right.
 */
export function shippingTopLevels(packageRoot) {
  const published = publishedEntryNames(packageRoot);
  const tops = new Set(published);
  if (published.has("dist")) {
    for (const root of DIST_SOURCE_ROOTS) tops.add(root);
  }
  // Not gated on dist. A files[] that omitted dist/ must not excuse a
  // packages/flair-client fix from carrying a fragment.
  for (const root of INDEPENDENT_SHIPPING_ROOTS) tops.add(root);
  for (const root of workspaceTopLevels(packageRoot)) tops.add(root);
  return tops;
}

export function pathTouchesPublished(relPath, shipping) {
  const p = String(relPath).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!p) return false;
  return shipping.has(p.split("/")[0]);
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
  const shipping = shippingTopLevels(packageRoot);
  return paths.some((p) => pathTouchesPublished(p, shipping));
}
