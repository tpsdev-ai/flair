#!/usr/bin/env node
// The single source of truth for the `@node-llama-cpp/<platform>` native
// binaries CI installs: the version `node-llama-cpp` resolves to in `bun.lock`
// (flair#3133). A floating `@3` resolves to the newest 3.x at run time, which
// can be newer than the lockfile's `node-llama-cpp` and can even be a tarball
// npm is not serving yet.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The repository lockfile the version is read from. */
export const LOCKFILE = resolve(ROOT, "bun.lock");

// A resolved package entry in bun.lock's `packages` map:
//   "node-llama-cpp": ["node-llama-cpp@3.22.3", ...],
// A workspace dependency declaration (`"node-llama-cpp": "3.22.3",`) is not a
// resolution and does not match; neither does a nested key such as
// `node-llama-cpp/chalk` or `harper-fabric-embeddings/node-llama-cpp`.
const RESOLVED = /^[ \t]*"node-llama-cpp"[ \t]*:[ \t]*\[[ \t]*"node-llama-cpp@([^"]+)"/gm;

/**
 * The version `node-llama-cpp` resolves to in `lockText`.
 *
 * Throws a named error unless there is exactly one such resolution: a stale or
 * split lockfile must stop CI with a diagnosis, never silently pick one.
 */
export function readLlamaNativeVersion(lockText) {
  const versions = [...lockText.matchAll(RESOLVED)].map(match => match[1]);
  if (versions.length !== 1) {
    throw new Error(
      `llama-native-version: expected exactly one resolved "node-llama-cpp" entry in bun.lock, found ${versions.length}`,
    );
  }
  return versions[0];
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
    process.stdout.write(`${readLlamaNativeVersion(readFileSync(lockfile, "utf8"))}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
