#!/usr/bin/env node
/**
 * check-workspace-deps.mjs — fail CI if any workspace package declares an
 * internal `@tpsdev-ai/*` dependency at a version other than the version
 * shipped by that workspace package.
 *
 * Why: 0.8.0 shipped openclaw-flair declaring flair-client@0.5.0 because no
 * automation ensured intra-monorepo deps stay in lockstep. Local workspace
 * symlinks hide the staleness during dev/CI; only consumers of the
 * published tarball see the bug.
 *
 * This check is bun/node-agnostic, no deps, zero config.
 *
 * Usage:
 *   node scripts/check-workspace-deps.mjs
 *
 * Exit codes:
 *   0 — all internal deps lockstep with their target workspace's version
 *   1 — at least one mismatch (printed to stderr)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPkg(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Build a name → version map of every workspace package
const workspaceVersions = new Map();
const rootPkg = readPkg(join(REPO_ROOT, "package.json"));
workspaceVersions.set(rootPkg.name, rootPkg.version);

const packagesDir = join(REPO_ROOT, "packages");
const workspacePkgs = [];
for (const entry of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, entry, "package.json");
  let pkg;
  try { pkg = readPkg(pkgPath); } catch { continue; }
  workspaceVersions.set(pkg.name, pkg.version);
  workspacePkgs.push({ pkg, path: pkgPath });
}

// Check every internal `@tpsdev-ai/*` dep against the workspace version map
const violations = [];
const allPkgs = [{ pkg: rootPkg, path: join(REPO_ROOT, "package.json") }, ...workspacePkgs];

for (const { pkg, path } of allPkgs) {
  for (const depKind of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[depKind] ?? {};
    for (const [name, declared] of Object.entries(deps)) {
      if (!name.startsWith("@tpsdev-ai/")) continue;
      const expected = workspaceVersions.get(name);
      if (expected == null) continue; // not a workspace pkg
      // Allow `workspace:*` and `workspace:^` resolution sentinels
      if (typeof declared === "string" && declared.startsWith("workspace:")) continue;
      if (declared !== expected) {
        violations.push({ from: pkg.name, depKind, name, declared, expected, path });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("");
  console.error("❌ Workspace internal-dep version mismatch:");
  console.error("");
  for (const v of violations) {
    console.error(`  ${v.from} → ${v.depKind}["${v.name}"] = "${v.declared}" (workspace ships ${v.expected})`);
    console.error(`    in ${v.path}`);
  }
  console.error("");
  console.error("All @tpsdev-ai/* internal deps must match the version of the workspace package they target.");
  console.error("Bump the dep to the current version, or use 'workspace:*' / 'workspace:^'.");
  process.exit(1);
}

console.log(`✓ All ${workspaceVersions.size} workspace packages have consistent internal deps.`);
