#!/usr/bin/env node
// Read embeddings' declared platform native version from bun.lock (flair#3133, #3153).
// The benchmark's node-llama-cpp can drift from harper-fabric-embeddings' native.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The repository lockfile the version is read from. */
export const LOCKFILE = resolve(ROOT, "bun.lock");

/** Accepted version shape for native installs. */
export const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** The embeddings package that declares platform native versions. */
export const EMBEDDINGS_PACKAGE = "harper-fabric-embeddings";

/** The native package a linux CI lane installs. */
export const PLATFORM_PACKAGE = "@node-llama-cpp/linux-x64";

function stripTrailingCommas(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === ",") {
      let next = i + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    result += char;
  }
  return result;
}

/** Return the platform native version harper-fabric-embeddings declares. */
export function readLlamaNativeVersion(lockText, packageName = PLATFORM_PACKAGE) {
  let lock;
  try {
    lock = JSON.parse(stripTrailingCommas(lockText));
  } catch (error) {
    throw new Error(`llama-native-version: invalid bun.lock: ${error.message}`);
  }
  // Workspace declarations and nested package keys do not select the root resolution.
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("llama-native-version: missing or malformed packages map in bun.lock");
  }
  if (!Object.hasOwn(packages, EMBEDDINGS_PACKAGE)) {
    throw new Error(`llama-native-version: missing packages["${EMBEDDINGS_PACKAGE}"] in bun.lock`);
  }
  const entry = packages[EMBEDDINGS_PACKAGE];
  const shape = /^harper-fabric-embeddings@([0-9]+\.[0-9]+\.[0-9]+)$/;
  const match = Array.isArray(entry) && typeof entry[0] === "string" ? shape.exec(entry[0]) : null;
  if (!match || entry[0] !== match[0] || !entry[2] || typeof entry[2] !== "object" || Array.isArray(entry[2])) {
    throw new Error(`llama-native-version: malformed packages["${EMBEDDINGS_PACKAGE}"] in bun.lock: expected ["${EMBEDDINGS_PACKAGE}@x.y.z", ...]`);
  }
  const declared =
    entry[2].dependencies?.[packageName] ?? entry[2].optionalDependencies?.[packageName];
  if (typeof declared !== "string") {
    throw new Error(`llama-native-version: packages["${EMBEDDINGS_PACKAGE}"] does not declare ${packageName} in bun.lock`);
  }
  if (!SEMVER.test(declared)) {
    throw new Error(`llama-native-version: declared ${packageName} "${declared}" in bun.lock is not x.y.z`);
  }
  return declared;
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
    const lockfile = process.argv[2] ? resolve(process.argv[2]) : LOCKFILE;
    const version = readLlamaNativeVersion(readFileSync(lockfile, "utf8"));
    if (!SEMVER.test(version)) {
      throw new Error(`llama-native-version: resolved version "${version}" is not x.y.z`);
    }
    process.stdout.write(`${version}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
