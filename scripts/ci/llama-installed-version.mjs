#!/usr/bin/env node
// Installed mode reports a native package found inside the install tree by its own
// version; otherwise the platform version harper-fabric-embeddings declares; when
// harper-fabric-embeddings is absent too, the script refuses. Checkout mode reads
// harper-fabric-embeddings' declared platform version (flair#3133, #3153).

import { readFileSync, realpathSync } from "node:fs";
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
    // Containment is decided on real paths: a manifest that resolves outside the
    // install tree, directly or through a symlink, is not part of that tree.
    const real = realOrNull(candidate);
    if (real !== null && !insideReal(installDir, real)) return null;
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8"));
      if (manifest.name === packageName) return { manifest, source: candidate };
    } catch (error) {
      throw new Error(`llama-installed-version: could not read ${packageName}'s own manifest ${candidate}: ${error.message}`);
    }
  }
  throw new Error(`llama-installed-version: could not read ${packageName}'s own package.json from ${root}`);
}

/** True when the real path `target` is `dir`'s real path or below it. */
function insideReal(dir, target) {
  const root = realOrNull(dir);
  return root !== null && (target === root || target.startsWith(root + sep));
}

function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
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
