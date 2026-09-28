#!/usr/bin/env node
/**
 * check-peer-deps.mjs — fail CI if a workspace package's NON-OPTIONAL peer
 * dependency, as RESOLVED in bun.lock, does not satisfy the range the package
 * declares for it.
 *
 * Why: `bun install --frozen-lockfile` refuses only a manifest/lockfile
 * mismatch. It does not check that a *resolved* peer satisfies the declared
 * peer range, so raising a peer floor without refreshing the lockfile passes
 * every gate while the workspace keeps installing a version below the declared
 * minimum. flair#1936: openclaw-flair declares `"openclaw": ">=2026.8.1"` but
 * bun.lock resolved `openclaw@2026.7.1`.
 *
 * What it checks: for every workspace package (the root and packages/*), every
 * entry in `peerDependencies` whose `peerDependenciesMeta` entry is not
 * `optional: true`, it looks up the version bun.lock resolves for that peer
 * (the package's own NESTED resolution when the lock carries one, else the
 * top-level resolution) and requires `semver.satisfies(version, range)`.
 *
 * What it skips: OPTIONAL peers (`peerDependenciesMeta[peer].optional === true`).
 *
 * Fail closed: every workspace listed in bun.lock is a required input. Missing,
 * unreadable or malformed manifests, an unreadable packages/ directory, and
 * non-optional peers with no lock resolution are failures.
 *
 * Uses the `semver` implementation the repo already depends on — no new dep.
 *
 * Usage:
 *   node scripts/check-peer-deps.mjs
 *   node scripts/check-peer-deps.mjs --root <dir>   # test seam (fixture trees)
 *
 * Exit codes:
 *   0 — every non-optional peer's lock resolution satisfies its declared range
 *   1 — at least one violation, or a required input could not be read or parsed
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1] !== undefined) {
      root = argv[++i];
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    }
  }
  return { root };
}

/**
 * bun.lock is JSON-with-trailing-commas (JSONC but, in practice, no comments):
 * strip the trailing commas and parse. Reading the whole file (no `2>/dev/null`
 * suppression) keeps a missing or unreadable lock a loud error.
 */
function readBunLock(repoRoot) {
  const path = join(repoRoot, "bun.lock");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${path} (${err instanceof Error ? err.message : String(err)}). Maintainer: restore a readable bun.lock from version control, or regenerate it with bun install, then rerun the peer check.`,
    );
  }
  try {
    return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  } catch (err) {
    throw new Error(
      `${path} is not parsable (${err instanceof Error ? err.message : String(err)}). Maintainer: repair bun.lock or regenerate it with bun install, then rerun the peer check.`,
    );
  }
}

/** Lock-listed manifests are required; also check additional packages/* manifests. */
function workspacePackages(repoRoot, lock) {
  const workspaces = lock?.workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces) ||
      !Object.hasOwn(workspaces, "")) {
    throw new Error(
      `${join(repoRoot, "bun.lock")} has an invalid or missing workspaces inventory (including the root workspace). Maintainer: regenerate bun.lock with bun install from a complete checkout, then rerun the peer check.`,
    );
  }
  const required = new Set(Object.keys(workspaces).map((dir) => join(dir, "package.json")));
  const packagesDir = join(repoRoot, "packages");
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `cannot read ${packagesDir} (${err instanceof Error ? err.message : String(err)}). Maintainer: restore the packages/ directory and its read/search permissions, then rerun the peer check.`,
    );
  }
  const paths = new Set(required);
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      paths.add(join("packages", entry.name, "package.json"));
    }
  }
  const out = [];
  for (const rel of [...paths].sort()) {
    const path = join(repoRoot, rel);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      // Non-JS directories need no manifest unless bun.lock lists them.
      if (!required.has(rel) && err?.code === "ENOENT") continue;
      throw new Error(
        `cannot read ${path} (${err instanceof Error ? err.message : String(err)}). Maintainer: restore this workspace's readable package.json from version control; if the workspace was intentionally removed, regenerate bun.lock with bun install, then rerun the peer check.`,
      );
    }
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `${path} is not parsable (${err instanceof Error ? err.message : String(err)}). Maintainer: repair package.json to valid JSON, then rerun the peer check.`,
      );
    }
    if (!pkg || Array.isArray(pkg) || typeof pkg.name !== "string" || !pkg.name.trim()) {
      throw new Error(
        `${path} is not a package object with a non-empty name. Maintainer: repair package.json to include the workspace's name, then rerun the peer check.`,
      );
    }
    out.push({ name: pkg.name, path: rel, pkg });
  }
  return out;
}

/**
 * The version bun.lock resolves for `peer` in `workspaceName`'s context. A
 * workspace's own dependency is keyed `<workspaceName>/<peer>` when its
 * resolution differs from the hoisted one, so that entry wins; otherwise the
 * top-level `<peer>` resolution is used. Returns undefined when neither exists.
 */
export function resolvedPeerVersion(lock, workspaceName, peer) {
  const packages = lock?.packages ?? {};
  const entry = packages[`${workspaceName}/${peer}`] ?? packages[peer];
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return undefined;
  const spec = entry[0];
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(at + 1) : undefined;
}

/**
 * Every violation: a non-optional declared peer that is unresolved or whose
 * resolved version does not satisfy the declared range.
 */
export function findPeerViolations(repoRoot) {
  const lock = readBunLock(repoRoot);
  const violations = [];
  for (const { name, path, pkg } of workspacePackages(repoRoot, lock)) {
    const peers = pkg.peerDependencies ?? {};
    const meta = pkg.peerDependenciesMeta ?? {};
    for (const [peer, range] of Object.entries(peers)) {
      if (meta[peer]?.optional === true) continue; // optional — skipped
      const version = resolvedPeerVersion(lock, name, peer);
      if (version === undefined) {
        violations.push({ from: name, path, peer, range, version: null });
        continue;
      }
      let satisfied;
      try {
        satisfied = semver.satisfies(version, range);
      } catch {
        satisfied = false; // an invalid range/spec is a failure, not a pass
      }
      if (!satisfied) {
        violations.push({ from: name, path, peer, range, version });
      }
    }
  }
  return violations;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  let violations;
  try {
    violations = findPeerViolations(root);
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (violations.length === 0) {
    console.log("✓ Every workspace package's non-optional peer satisfies its declared range in bun.lock.");
    process.exit(0);
  }

  console.error("");
  console.error("❌ Peer-dependency drift — bun.lock does not satisfy a declared peer range:");
  console.error("");
  for (const v of violations) {
    const held =
      v.version === null
        ? "bun.lock resolves it NOWHERE"
        : `bun.lock resolves ${v.peer}@${v.version}`;
    console.error(
      `  ${v.from} declares peer "${v.peer}": "${v.range}", but ${held} — refresh bun.lock so ${v.peer} satisfies ${v.range}.`,
    );
    console.error(`    in ${v.path}`);
  }
  console.error("");
  console.error(
    "A workspace package's non-optional peer must be installed at a version the package declares it supports.",
  );
  console.error(
    "Refresh bun.lock so the resolved peer satisfies the range (or widen the declared range if the floor is wrong).",
  );
  process.exit(1);
}

// Run only when invoked directly (tests import the functions above).
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
