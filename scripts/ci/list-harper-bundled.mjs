#!/usr/bin/env node
/**
 * list-harper-bundled.mjs — print the packages harper ships in its own tree.
 *
 * Since 5.3.2 harper bundles some of its production dependencies
 * (`bundleDependencies`; 70 of 83 in 5.3.3) instead of shipping an
 * `npm-shrinkwrap.json`. Those copies sit
 * under `node_modules/harper/node_modules`, where they resolve ahead of the
 * root tree: root overrides do not replace them in a bun install either, and
 * `bun audit` reads only `bun.lock`, so it does not report them. This prints
 * the copies installed in harper's tree and available for harper to resolve,
 * so a reviewer can see them.
 *
 * Usage:
 *   node scripts/ci/list-harper-bundled.mjs [node_modules dir]
 *
 * Default dir: <repo>/node_modules. Prints one line per installed copy
 * (`<name>@<version>  <path under harper/node_modules>`), then the count.
 *
 * Exit codes:
 *   0 — harper is installed, declares a bundle, and every declared copy was read.
 *   2 — DID NOT RUN: harper or its manifest is unreadable, it declares no
 *       bundleDependencies, `bundleDependencies: true` (only an explicit list
 *       is read) or an empty bundle, a declared entry is not a plain
 *       package name (see PACKAGE_NAME_RE) or has no directory, or an installed package's
 *       manifest is missing, unreadable or malformed (including an empty name
 *       or version). Every defect is named on stderr.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A plain package name: `name` or `@scope/name`, made of lowercase letters, digits, `-`, `.`, `_` and `~`, with no
// other path separator, not starting with `.` or `_`, at most 214 characters. This is narrower than "any string" and
// broader than npm's full rule for new names (which also refuses names such as `-foo` or `node_modules`): its job is
// that each entry names exactly one directory under harper's node_modules, never a path into another package's tree.
// Every entry harper 5.3.3 bundles satisfies it.
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function isPackageName(value) {
  return typeof value === "string" && value.length <= 214 && PACKAGE_NAME_RE.test(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function readManifest(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new Error(`cannot parse ${file}: ${e.message}`);
  }
  if (!isNonEmptyString(manifest?.name) || !isNonEmptyString(manifest?.version)) {
    throw new Error(`${file} has no non-empty string name and version`);
  }
  return manifest;
}

/** Installed packages under one node_modules directory, including nested copies. */
function walk(nodeModules, dir, seen, copies, problems) {
  let real;
  try {
    real = realpathSync(dir);
  } catch (e) {
    // A package with no nested node_modules is normal, not a skipped copy.
    if (e?.code === "ENOENT") return;
    problems.push(`cannot resolve ${dir}: ${e.message}`);
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    problems.push(`cannot read ${dir}: ${e.message}`);
    return;
  }
  const visit = (packageDir) => {
    let isDir = false;
    try {
      isDir = statSync(packageDir).isDirectory();
    } catch (e) {
      problems.push(`cannot stat ${packageDir}: ${e.message}`);
      return;
    }
    if (!isDir) return;
    const manifestPath = join(packageDir, "package.json");
    if (!existsSync(manifestPath)) {
      problems.push(`package directory ${packageDir} has no package.json`);
      return;
    }
    let manifest;
    try {
      manifest = readManifest(manifestPath);
    } catch (e) {
      problems.push(e.message);
      return;
    }
    copies.push({ name: manifest.name, version: manifest.version, path: relative(nodeModules, packageDir) });
    walk(nodeModules, join(packageDir, "node_modules"), seen, copies, problems);
  };
  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith("@")) {
      let children;
      try {
        children = readdirSync(full, { withFileTypes: true });
      } catch (e) {
        problems.push(`cannot read scope directory ${full}: ${e.message}`);
        continue;
      }
      for (const child of children) visit(join(full, child.name));
      continue;
    }
    visit(full);
  }
}

/**
 * Read harper's installed package.json and the copies under its node_modules.
 * Throws when either is missing or unreadable; callers turn that into exit 2.
 */
export function listBundledCopies(nodeModulesDir) {
  const harperDir = join(nodeModulesDir, "harper");
  const manifest = readManifest(join(harperDir, "package.json"));
  const declared = manifest.bundleDependencies ?? manifest.bundledDependencies;
  let declaredNames;
  if (declared === true) {
    // `true` bundles every dependency, and under npm's bundling rules the
    // optional ones too; this script reads only an explicit list (the form
    // harper ships), so it refuses `true` rather than guess the set.
    throw new Error(
      `harper ${manifest.version} declares bundleDependencies: true; this lister reads only an explicit list of bundled package names`,
    );
  } else if (Array.isArray(declared)) {
    // Every entry must be a plain package name (PACKAGE_NAME_RE): an entry this
    // script cannot read, or a path into another package's tree, is a copy it
    // cannot measure, so it is refused, never filtered out.
    const invalid = declared
      .map((name, index) => ({ name, index }))
      .filter(({ name }) => !isPackageName(name));
    if (invalid.length > 0) {
      throw new Error(
        `harper ${manifest.version} declares bundleDependencies entries that are not package names: ` +
          invalid.map(({ name, index }) => `[${index}] ${JSON.stringify(name)}`).join(", "),
      );
    }
    declaredNames = declared;
  } else {
    throw new Error(`harper ${manifest.version} declares no bundleDependencies`);
  }
  if (declaredNames.length === 0) {
    throw new Error(`harper ${manifest.version} declares an empty bundle (no bundled package names)`);
  }
  const bundledDir = join(harperDir, "node_modules");
  let hasBundledDir = false;
  try {
    hasBundledDir = statSync(bundledDir).isDirectory();
  } catch {
    hasBundledDir = false;
  }
  if (!hasBundledDir) throw new Error(`harper ${manifest.version} has no ${bundledDir}`);
  const copies = [];
  const problems = [];
  walk(bundledDir, bundledDir, new Set(), copies, problems);
  for (const name of declaredNames) {
    if (!copies.some((copy) => copy.path === name)) {
      problems.push(`declared bundled package ${name} has no directory at ${join(bundledDir, name)}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }
  if (copies.length === 0) throw new Error(`no installed packages under ${bundledDir}`);
  copies.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { harperVersion: manifest.version, declared: declaredNames, copies, bundledDir };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) {
    console.error("usage: list-harper-bundled.mjs [node_modules dir]");
    return 2;
  }
  const nodeModulesDir = resolve(argv[0] ?? join(REPO_ROOT, "node_modules"));
  try {
    const { harperVersion, declared, copies, bundledDir } = listBundledCopies(nodeModulesDir);
    console.log(`harper ${harperVersion} declares ${declared.length} bundled package names; ${copies.length} copies installed under ${bundledDir}:`);
    for (const copy of copies) console.log(`  ${copy.name}@${copy.version}  ${copy.path}`);
    console.log(`${copies.length} bundled copies.`);
    return 0;
  } catch (e) {
    console.error(`harper bundled copies: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
