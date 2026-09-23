#!/usr/bin/env node
/**
 * lockstep-packages.mjs — the ONE source for the release lockstep package list
 * (flair#1781).
 *
 * WHY. The release stages nine workspace packages in lockstep (one tag, one run,
 * one 2FA approval) — but the promote step moved only `@tpsdev-ai/flair`, so
 * `latest` skewed across the set on every release. The promote must cover the
 * SAME set the staging job publishes, and that set must not be a second
 * hand-maintained list. So it is DERIVED here, from the manifests the staging
 * job publishes from: the root `package.json` plus each `packages/<dir>/package.json`,
 * keeping every package that is not `private`. `packages/flair-tool-descriptors`
 * is `private` and is never staged, so it is correctly excluded.
 *
 * ORDER. `@tpsdev-ai/flair` is emitted LAST so a partial paste never leaves the
 * CLI ahead of its client library (flair#1383's mismatch class).
 *
 * Usage:
 *   node scripts/ci/lockstep-packages.mjs          # one package name per line
 *   node scripts/ci/lockstep-packages.mjs --json    # JSON array
 *
 * Exit codes:
 *   0 — printed (one or more packages)
 *   2 — DID NOT RUN (no readable manifests, or none publishable) — never green
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (scripts/ci/ -> scripts/ -> repo). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The CLI package, ordered last in every emitted list. */
export const FLAIR_ROOT_PACKAGE = "@tpsdev-ai/flair";

/**
 * Raised when a manifest that EXISTS cannot be read or parsed. A silently
 * skipped manifest would yield a partial set that the canary then hashed,
 * promoted and deprecated as if complete (flair#1781 R2), so this is fatal.
 */
export class LockstepManifestError extends Error {}

/**
 * The lockstep package names, derived from the manifests and ordered with
 * `@tpsdev-ai/flair` last. Deterministic (sorted by name within the rest).
 *
 * A MISSING `packages/<dir>/package.json` is skipped (a directory that is not a
 * package). An EXISTING one that cannot be read/parsed throws
 * {@link LockstepManifestError} — never a silent partial set.
 */
export function lockstepPackages(root = ROOT) {
  const names = [];
  const add = (manifestPath) => {
    if (!existsSync(manifestPath)) return;
    let raw;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch (err) {
      throw new LockstepManifestError(`cannot read ${manifestPath}: ${err instanceof Error ? err.message : err}`);
    }
    let pkg;
    try {
      pkg = JSON.parse(raw);
    } catch (err) {
      throw new LockstepManifestError(`cannot parse ${manifestPath}: ${err instanceof Error ? err.message : err}`);
    }
    if (typeof pkg?.name === "string" && pkg.name.length > 0 && pkg.private !== true) {
      names.push(pkg.name);
    }
  };

  add(join(root, "package.json"));
  const packagesDir = join(root, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) add(join(packagesDir, entry.name, "package.json"));
    }
  }

  const unique = [...new Set(names)].sort();
  const rest = unique.filter((n) => n !== FLAIR_ROOT_PACKAGE);
  return unique.includes(FLAIR_ROOT_PACKAGE) ? [...rest, FLAIR_ROOT_PACKAGE] : rest;
}

// flair#1856 R2: the SAME realpath comparison as registry-tarball-sha256.mjs.
// `resolve()` does not follow symlinks, so a checkout reached through a symlink
// made this false: the script printed NOTHING and exited 0, and an empty list
// reads as "nothing to promote" rather than "the derivation did not run".
function sameFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
const invokedDirectly = process.argv[1] !== undefined && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (invokedDirectly) {
  let packages;
  try {
    packages = lockstepPackages();
  } catch (err) {
    console.error(`lockstep-packages: DID NOT RUN — ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  if (packages.length === 0) {
    console.error("lockstep-packages: DID NOT RUN — no publishable package manifests found");
    process.exit(2);
  }
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(packages, null, 2) + "\n");
  } else {
    process.stdout.write(packages.join("\n") + "\n");
  }
}
