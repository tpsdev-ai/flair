/**
 * Provenance for the flair engine, recorded beside the space key.
 * Reads the installed platform prebuilt (`@node-llama-cpp/<platform>`),
 * not the umbrella `node-llama-cpp` package and not harper-fabric-embeddings.
 * An empty or unreadable package body refuses; it is not stamped as absent.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostLabel, PINNED_PREBUILT_VERSION, prebuiltForPlatform } from "./platforms.js";
import { EMBEDDING_PIPELINE_VERSION } from "./stamp-key.js";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

export interface EmbeddingProvenance {
  prebuiltPackage: string;
  prebuiltVersion: string;
  llamaCppBuild: string;
  pipelineVersion: string;
}

export function readEmbeddingProvenance(
  platform: string = process.platform,
  arch: string = process.arch,
  resolvePackage: (name: string) => string = (name) => createRequire(import.meta.url).resolve(name),
): EmbeddingProvenance {
  const match = prebuiltForPlatform(platform, arch);
  if (!match) {
    throw new Error(
      `[embeddings] platform ${hostLabel(platform, arch)} has no supported prebuilt ` +
        `(supported: @node-llama-cpp/linux-x64, @node-llama-cpp/linux-arm64, @node-llama-cpp/mac-arm64-metal). ` +
        `Remedy: run on a supported platform. Refusing to record provenance.`,
    );
  }
  let entry: string;
  try {
    entry = resolvePackage(match.packageName);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[embeddings] prebuilt ${match.packageName} for platform ${hostLabel(platform, arch)} is not installed. ` +
        `Remedy: install the optional dependency ${match.packageName}@3.18.1. ` +
        `Refusing to record provenance. (${detail})`,
    );
  }
  const pkgPath = findNamedPackageJson(entry, match.packageName);
  const version = versionFromPackageJson(readText(pkgPath), pkgPath);
  const llamaCppBuild = readLlamaCppBuild(dirname(pkgPath));
  return {
    prebuiltPackage: match.packageName,
    prebuiltVersion: version,
    llamaCppBuild,
    pipelineVersion: EMBEDDING_PIPELINE_VERSION,
  };
}

/**
 * Fail closed: empty, unreadable JSON, a non-x.y.z version, or any version
 * other than the tested pin is not provenance.
 */
export function versionFromPackageJson(text: string, pkgPath = "package.json"): string {
  if (text.trim() === "") {
    throw new Error(
      `[embeddings] prebuilt package.json at ${pkgPath} is empty. Remedy: reinstall the platform prebuilt. Refusing to record provenance.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[embeddings] prebuilt package.json at ${pkgPath} is not JSON. Remedy: reinstall the platform prebuilt. Refusing to record provenance. (${detail})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, "version")) {
    throw new Error(
      `[embeddings] prebuilt package.json at ${pkgPath} has no exact x.y.z version. Remedy: reinstall the pinned release. Refusing to record provenance.`,
    );
  }
  const version = Reflect.get(parsed, "version");
  if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
    throw new Error(
      `[embeddings] prebuilt package.json at ${pkgPath} has no exact x.y.z version. Remedy: reinstall the pinned release. Refusing to record provenance.`,
    );
  }
  if (version.includes(":")) {
    throw new Error(
      `[embeddings] prebuilt version must not contain ':'. Remedy: install a release whose version is x.y.z. Refusing to record provenance.`,
    );
  }
  if (version !== PINNED_PREBUILT_VERSION) {
    throw new Error(
      `[embeddings] prebuilt package.json at ${pkgPath} is version ${version}; ${PINNED_PREBUILT_VERSION} is the tested pin. Remedy: install the pinned release. That version was not tested. Refusing to record provenance.`,
    );
  }
  return version;
}

/**
 * HealthDetail uses this when a provenance read fails and registration did
 * not record a degrade. The backend stays registered. This is not keyword
 * search and not an activation failure.
 */
export function provenanceUnavailableMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `[embeddings] embedding provenance is unavailable. The registered embedding backend is unchanged. ${detail}`;
}

function readLlamaCppBuild(packageDir: string): string {
  const bins = join(packageDir, "bins");
  let names: string[];
  try {
    names = readdirSync(bins);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[embeddings] prebuilt bins directory ${bins} is unreadable. Remedy: reinstall the platform prebuilt. Refusing to record a llama.cpp build. (${detail})`,
    );
  }
  for (const name of names) {
    const metaPath = join(bins, name, "_nlcBuildMetadata.json");
    if (!existsSync(metaPath)) continue;
    const text = readText(metaPath);
    if (text.trim() === "") {
      throw new Error(
        `[embeddings] ${metaPath} is empty. Remedy: reinstall the platform prebuilt. Refusing to record a llama.cpp build.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[embeddings] ${metaPath} is not JSON. Remedy: reinstall the platform prebuilt. Refusing to record a llama.cpp build. (${detail})`,
      );
    }
    const release = llamaRelease(parsed);
    if (release == null) {
      throw new Error(
        `[embeddings] ${metaPath} has no llama.cpp release. Remedy: reinstall the platform prebuilt. Refusing to record a llama.cpp build.`,
      );
    }
    return release;
  }
  throw new Error(
    `[embeddings] no _nlcBuildMetadata.json under ${bins}. Remedy: reinstall the platform prebuilt. Refusing to record a llama.cpp build.`,
  );
}

function llamaRelease(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, "buildOptions")) return undefined;
  const buildOptions = Reflect.get(parsed, "buildOptions");
  if (typeof buildOptions !== "object" || buildOptions === null || !Object.hasOwn(buildOptions, "llamaCpp")) return undefined;
  const llamaCpp = Reflect.get(buildOptions, "llamaCpp");
  if (typeof llamaCpp !== "object" || llamaCpp === null || !Object.hasOwn(llamaCpp, "release")) return undefined;
  const release = Reflect.get(llamaCpp, "release");
  if (typeof release !== "string" || release.length === 0 || release.includes(":")) return undefined;
  return release;
}

function findNamedPackageJson(entry: string, packageName: string): string {
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const text = readText(candidate);
      if (packageNameOf(text) === packageName) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `[embeddings] could not find ${packageName} package.json above ${entry}. Remedy: reinstall that optional dependency. Refusing to record provenance.`,
  );
}

function packageNameOf(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, "name")) return undefined;
  const name = Reflect.get(parsed, "name");
  return typeof name === "string" ? name : undefined;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[embeddings] ${path} is unreadable. Remedy: reinstall the platform prebuilt. Refusing to record provenance. (${detail})`,
    );
  }
}
