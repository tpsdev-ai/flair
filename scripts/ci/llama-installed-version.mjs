#!/usr/bin/env node
// Read the first resolvable native package's own manifest, else the version
// harper-fabric-embeddings declares, using these roots for each: install root,
// installed Flair, nested embeddings, hoisted embeddings (flair#3133, #3153).
// Installed trees can resolve a different version from the checkout lockfile.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { EMBEDDINGS_PACKAGE, PLATFORM_PACKAGE, SEMVER } from "./llama-native-version.mjs";
/** The native package a linux CI lane installs. */
export const DEFAULT_PACKAGE = PLATFORM_PACKAGE;

/** Fixed search order within each package name. */
export function resolutionRoots(dir) {
  const root = resolve(dir);
  return [
    root,
    join(root, "node_modules/@tpsdev-ai/flair"),
    join(root, "node_modules/@tpsdev-ai/flair/node_modules/harper-fabric-embeddings"),
    join(root, "node_modules/harper-fabric-embeddings"),
  ];
}

/**
 * Read the resolved package's own manifest.
 * `exports` may hide `./package.json`, so resolve the entry point first.
 */
function manifestOf(installDir, root, packageName) {
  const entry = createRequire(join(root, "noop.cjs")).resolve(packageName);
  const parts = entry.split(sep);
  const modules = parts.lastIndexOf("node_modules");
  const name = parts[modules + 1];
  const end = modules + (name?.startsWith("@") ? 3 : 2);
  if (modules !== -1 && name && end < parts.length) {
    const candidate = join(parts.slice(0, end).join(sep), "package.json");
    // A manifest resolved above the install directory is not part of that tree.
    if (!inside(installDir, candidate)) return null;
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8"));
      if (manifest.name === packageName) return { manifest, source: candidate };
    } catch (error) {
      throw new Error(`llama-installed-version: could not read ${packageName}'s own manifest ${candidate}: ${error.message}`);
    }
  }
  throw new Error(`llama-installed-version: could not read ${packageName}'s own package.json from ${root}`);
}

/** True when `path` is `dir` or below it. */
function inside(dir, path) {
  const root = resolve(dir);
  const target = resolve(path);
  return target === root || target.startsWith(root + sep);
}

/** First resolvable manifest for this package, or null when absent. */
export function findInstalledPackage(dir, packageName) {
  for (const root of resolutionRoots(dir)) {
    let found;
    try {
      found = manifestOf(dir, root, packageName);
    } catch (error) {
      if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND") continue;
      throw error;
    }
    if (found === null) continue;
    if (typeof found.manifest.version !== "string") {
      throw new Error(`llama-installed-version: ${packageName} in ${root} has no version`);
    }
    return { version: found.manifest.version, source: found.source, manifest: found.manifest };
  }
  return null;
}

export function findInstalledVersion(dir, packageName) {
  return findInstalledPackage(dir, packageName)?.version ?? null;
}

/** Native package across the fixed roots, else the version embeddings declares. */
export function readLlamaInstalledPackage(dir, packageName = DEFAULT_PACKAGE) {
  const found = findInstalledPackage(dir, packageName);
  if (found === null) {
    const embeddings = findInstalledPackage(dir, EMBEDDINGS_PACKAGE);
    if (embeddings === null) {
      throw new Error(
        `llama-installed-version: ${packageName} is not installed under ${resolve(dir)} and ${EMBEDDINGS_PACKAGE} is not installed`,
      );
    }
    return declaredNativeVersion(embeddings, packageName);
  }
  if (!SEMVER.test(found.version)) {
    throw new Error(`llama-installed-version: installed version "${found.version}" in ${found.source} is not x.y.z`);
  }
  return { version: found.version, source: found.source };
}

/** The platform native version `embeddings` declares, with its manifest as source. */
function declaredNativeVersion(embeddings, packageName) {
  const { manifest, source } = embeddings;
  const declared = manifest.dependencies?.[packageName] ?? manifest.optionalDependencies?.[packageName];
  if (typeof declared !== "string") {
    throw new Error(`llama-installed-version: ${EMBEDDINGS_PACKAGE} in ${source} does not declare ${packageName}`);
  }
  if (!SEMVER.test(declared)) {
    throw new Error(`llama-installed-version: declared version "${declared}" in ${source} is not x.y.z`);
  }
  return { version: declared, source };
}

export function readLlamaInstalledVersion(dir, packageName = DEFAULT_PACKAGE) {
  return readLlamaInstalledPackage(dir, packageName).version;
}

const isEntryPoint =
  process.argv[1] &&
  (() => {
    try {
      return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();

if (isEntryPoint) {
  try {
    const [dir, packageName] = process.argv.slice(2);
    if (!dir) throw new Error("llama-installed-version: usage: llama-installed-version.mjs <dir> [package]");
    process.stdout.write(`${readLlamaInstalledVersion(dir, packageName)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
