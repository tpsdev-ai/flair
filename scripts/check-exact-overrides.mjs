#!/usr/bin/env node
/**
 * check-exact-overrides.mjs — fail CI if a root `overrides` entry that reaches
 * a workspace dependency declares a version RANGE instead of an exact version.
 *
 * Why: bun 1.3.10 re-checks the registry manifest for a ranged dependency of a
 * workspace on every warm install once its cached copy is older than its
 * 300 s max-age. CI restores a cache that is always older than that, so a
 * range costs one manifest request per install; through Socket Firewall that
 * request took about 300 s on the run that fixed the MCP SDK range (flair#2301).
 *
 * Scope — an override is checked only when its package name is declared by a
 * workspace package (packages/*) under `dependencies`, `devDependencies` or
 * `optionalDependencies`. Everything else is out of scope:
 *   - a workspace package's own dependency ranges: those packages are
 *     published, and an exact pin there would force consumers to install a
 *     duplicate copy of the pinned package;
 *   - `peerDependencies`: resolved by the consumer's install, so an override
 *     does not describe what a peer resolves to;
 *   - a root override whose key no workspace package declares.
 *
 * Exempt: `workspace:` specifiers (workspace-internal resolution sentinels).
 *
 * Usage:
 *   node scripts/check-exact-overrides.mjs
 *   node scripts/check-exact-overrides.mjs --root <dir>   # fixture seam
 *
 * Exit codes:
 *   0 — every reaching override is an exact version (or exempt)
 *   1 — at least one reaching override is a range (printed to stderr)
 *   2 — a required input could not be read or parsed
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A workspace package's own deps that make a root override "reach" it. Peers are
// excluded: an override does not describe what a consumer's peer resolves to.
const DEP_KINDS = ["dependencies", "devDependencies", "optionalDependencies"];

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1] !== undefined) root = argv[++i];
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
  }
  return { root };
}

// Read one required JSON input. A missing, unreadable or malformed manifest is
// a hard error: silently skipping it would shrink the reachable set and let a
// range through as a pass.
function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${path} (${err instanceof Error ? err.message : String(err)}). ` +
        `Maintainer: restore a readable ${what} from version control, then rerun the override check.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} is not parsable (${err instanceof Error ? err.message : String(err)}). ` +
        `Maintainer: repair ${what} to valid JSON, then rerun the override check.`,
    );
  }
}

function isExempt(value) {
  return typeof value === "string" && value.startsWith("workspace:");
}

// An exact pin: starts with a digit. Everything else (`^`, `~`, `>=`, `*`, `x`,
// git/file URLs, tags) is a range.
function isExactVersion(value) {
  if (typeof value !== "string") return false;
  if (/^\d/.test(value)) return true;
  // A `npm:` alias pinned to an exact version (e.g. `npm:foo@1.0.0`) resolves
  // to one version, so it is not a range. A range tail is.
  if (value.startsWith("npm:")) {
    const at = value.lastIndexOf("@");
    return at > "npm:".length && /^\d/.test(value.slice(at + 1));
  }
  return false;
}

function isNonExact(value) {
  if (typeof value !== "string") return false;
  if (isExempt(value)) return false;
  return !isExactVersion(value);
}

/**
 * Every workspace manifest declared by the root `workspaces` globs. A directory
 * with no package.json (a Python/plugin package) is skipped; a manifest that
 * exists but cannot be read or parsed is a hard error.
 */
function workspaceManifests(root, rootPkg) {
  const globs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
  const manifests = [];
  for (const glob of globs) {
    if (typeof glob !== "string" || !glob.endsWith("/*")) {
      throw new Error(
        `${join(root, "package.json")} has an unsupported workspaces glob ${JSON.stringify(glob)}. ` +
          "Maintainer: this check only understands '<dir>/*' globs; update the check or the glob, then rerun the override check.",
      );
    }
    const relParent = glob.slice(0, -2);
    const parent = join(root, relParent);
    let entries;
    try {
      entries = readdirSync(parent, { withFileTypes: true });
    } catch (err) {
      throw new Error(
        `cannot read ${parent} (${err instanceof Error ? err.message : String(err)}). ` +
          `Maintainer: restore the ${relParent}/ directory and its read permissions, then rerun the override check.`,
      );
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const rel = `${relParent}/${entry.name}/package.json`;
      const path = join(parent, entry.name, "package.json");
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        if (err?.code === "ENOENT") continue; // not a JS package directory
        throw new Error(
          `cannot read ${path} (${err instanceof Error ? err.message : String(err)}). ` +
            `Maintainer: restore this workspace's readable package.json from version control, then rerun the override check.`,
        );
      }
      let pkg;
      try {
        pkg = JSON.parse(text);
      } catch (err) {
        throw new Error(
          `${path} is not parsable (${err instanceof Error ? err.message : String(err)}). ` +
            `Maintainer: repair package.json to valid JSON, then rerun the override check.`,
        );
      }
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
        throw new Error(
          `${path} is not a package object. ` +
            `Maintainer: repair package.json, then rerun the override check.`,
        );
      }
      manifests.push({ name: typeof pkg.name === "string" ? pkg.name : rel, path, pkg });
    }
  }
  return manifests;
}

/** Resolve the version bun.lock pins for `name` (top-level entry), or null. */
function makeResolver(root) {
  let packages;
  try {
    const raw = readFileSync(join(root, "bun.lock"), "utf8");
    packages = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1")).packages ?? {};
  } catch {
    // The lock is only used to name the exact version in the remedy; a missing
    // or unreadable lock never turns a failure into a pass.
    return () => null;
  }
  const map = new Map();
  for (const [name, entry] of Object.entries(packages)) {
    if (map.has(name)) continue;
    const spec = Array.isArray(entry) ? entry[0] : entry;
    if (typeof spec !== "string") continue;
    const at = spec.lastIndexOf("@");
    if (at > 0) map.set(name, spec.slice(at + 1));
  }
  return (name) => map.get(name) ?? null;
}

/**
 * Every root `overrides` entry whose key a workspace package declares under a
 * checked dep kind and whose value is not an exact version (or `workspace:`).
 */
export function findExactOverrideViolations(repoRoot) {
  const rootPkg = readJson(join(repoRoot, "package.json"), "package.json");
  if (!rootPkg || typeof rootPkg !== "object" || Array.isArray(rootPkg)) {
    throw new Error(
      `${join(repoRoot, "package.json")} is not a package object. ` +
        "Maintainer: repair package.json, then rerun the override check.",
    );
  }

  const reachable = new Set();
  for (const { pkg } of workspaceManifests(repoRoot, rootPkg)) {
    for (const kind of DEP_KINDS) {
      for (const name of Object.keys(pkg[kind] ?? {})) reachable.add(name);
    }
  }

  const resolve = makeResolver(repoRoot);
  const violations = [];
  for (const [name, declared] of Object.entries(rootPkg.overrides ?? {})) {
    if (!reachable.has(name)) continue;
    if (typeof declared !== "string") {
      throw new Error(
        `${join(repoRoot, "package.json")} override "${name}" is not a version string (${JSON.stringify(declared)}). ` +
          "Maintainer: an override reaching a workspace dependency must be a plain exact-version string; rewrite it, then rerun the override check.",
      );
    }
    if (isNonExact(declared)) {
      violations.push({ name, declared, exact: resolve(name) });
    }
  }
  return violations;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  let violations;
  try {
    violations = findExactOverrideViolations(root);
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (violations.length === 0) {
    console.log(
      "✓ Every root override that reaches a workspace dependency declares an exact version.",
    );
    process.exit(0);
  }

  console.error("");
  console.error("❌ Root overrides that reach a workspace dependency must be exact versions:");
  console.error("");
  for (const v of violations) {
    const pin = v.exact ? `"${v.exact}"` : "the exact version the registry resolves";
    console.error(`  overrides["${v.name}"] = "${v.declared}" — pin ${pin}.`);
  }
  console.error("");
  console.error(
    "A range makes bun re-check the registry manifest on every warm install; pin the exact version.",
  );
  process.exit(1);
}

// Run only when invoked directly (tests import the function above).
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
