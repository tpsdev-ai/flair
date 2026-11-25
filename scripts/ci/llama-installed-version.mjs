#!/usr/bin/env node
// Select the first resolvable native package, then the family package, using
// these roots for each: install root, installed Flair, nested embeddings,
// hoisted embeddings (flair#3133).
// Installed trees can resolve a different version from the checkout lockfile.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
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
 * The package.json of `packageName` as loaded from `root`: resolve the entry
 * point, then walk up to the manifest without leaving the package directory.
 * (`exports` may hide `./package.json`, so it is not resolvable directly.)
 */
function manifestOf(root, packageName) {
  const entry = createRequire(join(root, "noop.cjs")).resolve(packageName);
  for (let dir = dirname(entry); basename(dir) !== "node_modules"; dir = dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, "utf8"));
      if (manifest.name === packageName) return { manifest, source: candidate };
      break;
    }
    if (dirname(dir) === dir) break;
  }
  throw new Error(`llama-installed-version: could not read ${packageName}'s package.json from ${root}`);
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
