#!/usr/bin/env node
// The node-llama-cpp version an npm-installed flair actually uses, read from
// the directory it was installed into (flair#3133). CI installs the matching
// @node-llama-cpp/<platform> native binary there; that directory resolves its
// own tree, which can differ from this checkout's bun.lock (the migration
// baseline is an older release).
//
// The lookup resolves from the install root, the installed flair package, and
// that package's harper-fabric-embeddings (hoisted or nested) — the places the
// installed tree loads its modules from. A directory with no node-llama-cpp
// install fails with a named error instead of installing a floating version.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SEMVER } from "./llama-native-version.mjs";
/** The native package a linux CI lane installs, and the fallback family name. */
export const DEFAULT_PACKAGE = "@node-llama-cpp/linux-x64";
export const FAMILY_PACKAGE = "node-llama-cpp";

/** The directories a resolved module is loaded from, nearest first. */
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
      if (manifest.name === packageName) return manifest;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  throw new Error(`llama-installed-version: could not read ${packageName}'s package.json from ${root}`);
}

/**
 * The installed version of `packageName` under `dir`.
 *
 * Returns null when no root resolves it; rethrows any other failure (an
 * unreadable or malformed package is not an absent one).
 */
export function findInstalledVersion(dir, packageName) {
  for (const root of resolutionRoots(dir)) {
    let manifest;
    try {
      manifest = manifestOf(root, packageName);
    } catch (error) {
      if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND") continue;
      throw error;
    }
    if (typeof manifest.version !== "string") {
      throw new Error(`llama-installed-version: ${packageName} in ${root} has no version`);
    }
    return manifest.version;
  }
  return null;
}

/**
 * The native version an npm-installed flair under `dir` uses: the installed
 * platform package, else the installed `node-llama-cpp` package.
 *
 * Throws a named error when neither is installed: an unknown version stops the
 * step instead of installing a floating one.
 */
export function readLlamaInstalledVersion(dir, packageName = DEFAULT_PACKAGE) {
  const version = findInstalledVersion(dir, packageName) ?? findInstalledVersion(dir, FAMILY_PACKAGE);
  if (version === null) {
    throw new Error(
      `llama-installed-version: ${packageName} and ${FAMILY_PACKAGE} are not installed under ${resolve(dir)}`,
    );
  }
  if (!SEMVER.test(version)) {
    throw new Error(`llama-installed-version: installed ${packageName} version "${version}" is not x.y.z`);
  }
  return version;
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
