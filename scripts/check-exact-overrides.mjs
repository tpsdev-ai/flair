#!/usr/bin/env node
/**
 * Check declared direct root override keys against workspace dependency names.
 * dependencies, devDependencies and optionalDependencies are checked;
 * peerDependencies and workspace packages' own ranges are out of scope.
 * workspace: values are exempt.
 * Alias names use npm's URL-friendly legacy grammar, except unscoped archive
 * names (.tgz/.tar.gz); versions use strict SemVer. No npm-parser comparison.
 *
 * Usage: node scripts/check-exact-overrides.mjs [--root <dir>] [--staged]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEP_KINDS = ["dependencies", "devDependencies", "optionalDependencies"];

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  let staged = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1] !== undefined) root = argv[++i];
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
    else if (arg === "--staged") staged = true;
  }
  return { root, staged };
}

function readText(root, rel, staged) {
  return staged
    ? execFileSync("git", ["show", `:${rel}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    : readFileSync(join(root, rel), "utf8");
}

function readJson(root, rel, staged) {
  const path = join(root, rel);
  let text;
  try {
    text = readText(root, rel, staged);
  } catch (err) {
    throw new Error(
      `cannot read ${path} (${err instanceof Error ? err.message : String(err)}). ` +
        "Maintainer: restore this manifest, then rerun the override check.",
    );
  }
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} is not parsable (${err instanceof Error ? err.message : String(err)}). ` +
        "Maintainer: repair package.json to valid JSON, then rerun the override check.",
    );
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new Error(
      `${path} is not a package object. Maintainer: repair package.json, then rerun the override check.`,
    );
  }
  for (const kind of DEP_KINDS) objectField(pkg, kind, path);
  return pkg;
}

function isPlainObject(value) {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function objectField(object, field, path) {
  if (!Object.hasOwn(object, field)) return {};
  if (!isPlainObject(object[field])) {
    throw new Error(
      `${path} ${field} must be a plain object. Maintainer: repair ${field}, then rerun the override check.`,
    );
  }
  return object[field];
}

function isExempt(value) {
  return typeof value === "string" && value.startsWith("workspace:");
}

const CORE_PART = /^(?:0|[1-9]\d*)$/;
const PRERELEASE_ID = /^(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)$/;
const BUILD_ID = /^[\dA-Za-z-]+$/;

function matchesWhole(value, pattern) {
  return value.match(pattern)?.[0] === value;
}

function isExactSemver(value) {
  const plus = value.indexOf("+");
  if (plus !== -1) {
    const build = value.slice(plus + 1).split(".");
    if (!build.every((id) => matchesWhole(id, BUILD_ID))) return false;
    value = value.slice(0, plus);
  }
  const dash = value.indexOf("-");
  if (dash !== -1) {
    const prerelease = value.slice(dash + 1).split(".");
    if (!prerelease.every((id) => matchesWhole(id, PRERELEASE_ID))) return false;
    value = value.slice(0, dash);
  }
  const core = value.split(".");
  return core.length === 3 && core.every((part) => matchesWhole(part, CORE_PART));
}

function isPackageName(name) {
  if (!name || /^[._-]/.test(name)) return false;
  if (["node_modules", "favicon.ico"].includes(name.toLowerCase())) return false;
  if (name.startsWith("@")) {
    const parts = name.slice(1).split("/");
    return (
      parts.length === 2 && parts.every((part) => matchesWhole(part, /^[A-Za-z0-9._~!'()*-]+$/)) &&
      !parts[1].startsWith(".")
    );
  }
  return matchesWhole(name, /^[A-Za-z0-9._~!'()*-]+$/);
}

function isExactVersion(value) {
  if (typeof value !== "string") return false;
  if (isExactSemver(value)) return true;
  if (value.startsWith("npm:")) {
    const at = value.lastIndexOf("@");
    const name = value.slice("npm:".length, at);
    return isPackageName(name) &&
      (name.startsWith("@") || !/[.](?:tgz|tar[.]gz)$/i.test(name)) &&
      isExactSemver(value.slice(at + 1));
  }
  return false;
}

function isNonExact(value) {
  if (typeof value !== "string") return false;
  if (isExempt(value)) return false;
  return !isExactVersion(value);
}

function workspaceManifests(root, rootPkg, staged) {
  if (!Array.isArray(rootPkg.workspaces)) {
    throw new Error(
      `${join(root, "package.json")} workspaces must be an array. Maintainer: restore the workspace declaration.`,
    );
  }
  const manifests = [];
  const indexed = staged
    ? execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: root, encoding: "utf8" })
        .split("\0")
        .filter(Boolean)
    : null;
  for (const glob of rootPkg.workspaces) {
    if (typeof glob !== "string" || !glob.endsWith("/*") || glob.slice(0, -2).includes("*")) {
      throw new Error(
        `${join(root, "package.json")} has an unsupported workspaces glob ${JSON.stringify(glob)}. ` +
          "Maintainer: use '<dir>/*' globs or update the check.",
      );
    }
    const relParent = glob.slice(0, -2);
    let paths;
    if (indexed) {
      const prefix = `${relParent}/`;
      paths = indexed.filter(
        (path) => path.startsWith(prefix) && /^[^/]+\/package\.json$/.test(path.slice(prefix.length)),
      );
    } else {
      const parent = join(root, relParent);
      let entries;
      try {
        entries = readdirSync(parent, { withFileTypes: true });
      } catch (err) {
        throw new Error(
          `cannot read ${parent} (${err instanceof Error ? err.message : String(err)}). ` +
            "Maintainer: restore this workspace directory.",
        );
      }
      paths = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const rel = `${relParent}/${entry.name}/package.json`;
        try {
          readText(root, rel, false);
        } catch (err) {
          if (err?.code === "ENOENT") continue;
          throw new Error(
            `cannot read ${join(root, rel)}. Maintainer: restore this workspace manifest.`,
          );
        }
        paths.push(rel);
      }
    }
    for (const rel of paths) manifests.push(readJson(root, rel, staged));
  }
  if (manifests.length === 0) {
    throw new Error(
      `${join(root, "package.json")} workspaces yielded no manifests. Maintainer: restore a declared workspace manifest.`,
    );
  }
  return manifests;
}

function makeResolver(root, staged) {
  const path = join(root, "bun.lock");
  let raw;
  try {
    if (staged && !execFileSync("git", ["ls-files", "--cached", "-z", "--", "bun.lock"], {
      cwd: root, encoding: "utf8",
    })) return () => null;
    raw = readText(root, "bun.lock", staged);
  } catch (err) {
    if (!staged && err?.code === "ENOENT" && !readdirSync(root).includes("bun.lock")) {
      return () => null;
    }
    throw new Error(
      `cannot read ${path} (${err instanceof Error ? err.message : String(err)}). Maintainer: restore bun.lock.`,
    );
  }
  let lock;
  try {
    lock = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
  } catch (err) {
    throw new Error(
      `${path} is not parsable (${err instanceof Error ? err.message : String(err)}). Maintainer: regenerate bun.lock.`,
    );
  }
  if (!isPlainObject(lock)) {
    throw new Error(`${path} must be a plain object. Maintainer: regenerate bun.lock.`);
  }
  const packages = objectField(lock, "packages", path);
  const map = new Map();
  for (const [name, entry] of Object.entries(packages)) {
    if (map.has(name)) continue;
    const spec = Array.isArray(entry) ? entry[0] : entry;
    if (typeof spec !== "string") continue;
    const at = spec.lastIndexOf("@");
    if (at > 0 && isPackageName(spec.slice(0, at)) && isExactSemver(spec.slice(at + 1))) {
      map.set(name, spec.slice(at + 1));
    }
  }
  return (name) => map.get(name) ?? null;
}

export function findExactOverrideViolations(repoRoot, { staged = false } = {}) {
  const rootPkg = readJson(repoRoot, "package.json", staged);

  const overrides = objectField(rootPkg, "overrides", join(repoRoot, "package.json"));
  const reachable = new Set();
  for (const pkg of workspaceManifests(repoRoot, rootPkg, staged)) {
    for (const kind of DEP_KINDS) {
      for (const name of Object.keys(pkg[kind] ?? {})) reachable.add(name);
    }
  }

  const resolve = makeResolver(repoRoot, staged);
  const violations = [];
  for (const [name, declared] of Object.entries(overrides)) {
    if (!reachable.has(name)) continue;
    if (typeof declared !== "string") {
      throw new Error(
        `${join(repoRoot, "package.json")} override "${name}" is not a version string (${JSON.stringify(declared)}). ` +
          "Maintainer: use an exact semver, an npm: alias with an exact target version, or a workspace: specifier.",
      );
    }
    if (isNonExact(declared)) {
      violations.push({ name, declared, exact: resolve(name) });
    }
  }
  return violations;
}

function main() {
  const { root, staged } = parseArgs(process.argv.slice(2));
  let violations;
  try {
    violations = findExactOverrideViolations(root, { staged });
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (violations.length === 0) {
    console.log(
      "✓ Declared direct override keys matching workspace dependencies passed the exact-version check.",
    );
    process.exit(0);
  }

  console.error("");
  console.error(
    "❌ Non-exact specifiers for declared direct override keys matching workspace dependencies:",
  );
  console.error("");
  for (const v of violations) {
    const advice = v.exact ? `pin "${v.exact}"` : "choose an exact version or a workspace: specifier";
    console.error(`  overrides["${v.name}"] = "${v.declared}" — ${advice}.`);
  }
  console.error("");
  process.exit(1);
}

// Run only when invoked directly (tests import the function above).
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
