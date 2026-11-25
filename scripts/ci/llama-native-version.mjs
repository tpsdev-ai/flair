#!/usr/bin/env node
// Validate the node-llama-cpp packages entry in bun.lock (flair#3133).
// Floating versions can drift from the checkout resolution.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The repository lockfile the version is read from. */
export const LOCKFILE = resolve(ROOT, "bun.lock");

/** Accepted version shape for native installs. */
export const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

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

/** Validate the packages entry and return its x.y.z version. */
export function readLlamaNativeVersion(lockText) {
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
  if (!Object.hasOwn(packages, "node-llama-cpp")) {
    throw new Error('llama-native-version: missing packages["node-llama-cpp"] in bun.lock');
  }
  const entry = packages["node-llama-cpp"];
  const match = Array.isArray(entry) && typeof entry[0] === "string"
    ? /^node-llama-cpp@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(entry[0])
    : null;
  if (!match || entry[0] !== match[0]) {
    throw new Error('llama-native-version: malformed packages["node-llama-cpp"] in bun.lock: expected ["node-llama-cpp@x.y.z", ...]');
  }
  return match[1];
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
