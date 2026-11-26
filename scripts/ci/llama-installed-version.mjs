#!/usr/bin/env node
// Read the first resolvable native package's own manifest, then the family's, using
// these roots for each: install root, installed Flair, nested embeddings,
// hoisted embeddings (flair#3133).
// Installed trees can resolve a different version from the checkout lockfile.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SEMVER } from "./llama-native-version.mjs";
/** The native package a linux CI lane installs, and the fallback family name. */
export const DEFAULT_PACKAGE = "@node-llama-cpp/linux-x64";
export const FAMILY_PACKAGE = "node-llama-cpp";

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
function manifestOf(root, packageName) {
  const entry = createRequire(join(root, "noop.cjs")).resolve(packageName);
  const parts = entry.split(sep);
  const modules = parts.lastIndexOf("node_modules");
  const name = parts[modules + 1];
  const end = modules + (name?.startsWith("@") ? 3 : 2);
  if (modules !== -1 && name && end < parts.length) {
    const candidate = join(parts.slice(0, end).join(sep), "package.json");
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8"));
      if (manifest.name === packageName) return { manifest, source: candidate };
    } catch (error) {
      throw new Error(`llama-installed-version: could not read ${packageName}'s own manifest ${candidate}: ${error.message}`);
    }
  }
  throw new Error(`llama-installed-version: could not read ${packageName}'s own package.json from ${root}`);
}

/** First resolvable manifest for this package, or null when absent. */
export function findInstalledPackage(dir, packageName) {
  for (const root of resolutionRoots(dir)) {
    let found;
    try {
      found = manifestOf(root, packageName);
    } catch (error) {
      if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND") continue;
      throw error;
    }
    if (typeof found.manifest.version !== "string") {
      throw new Error(`llama-installed-version: ${packageName} in ${root} has no version`);
    }
    return { version: found.manifest.version, source: found.source };
  }
  return null;
}

export function findInstalledVersion(dir, packageName) {
  return findInstalledPackage(dir, packageName)?.version ?? null;
}

/** Native package across the fixed roots, then family across the same roots. */
export function readLlamaInstalledPackage(dir, packageName = DEFAULT_PACKAGE) {
  const found = findInstalledPackage(dir, packageName) ?? findInstalledPackage(dir, FAMILY_PACKAGE);
  if (found === null) {
    throw new Error(
      `llama-installed-version: ${packageName} and ${FAMILY_PACKAGE} are not installed under ${resolve(dir)}`,
    );
  }
  if (!SEMVER.test(found.version)) {
    throw new Error(`llama-installed-version: installed version "${found.version}" in ${found.source} is not x.y.z`);
  }
  return found;
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
