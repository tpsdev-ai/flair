/**
 * CLI copy of the embedding space key.
 *
 * src/ and resources/ are separate build targets, so this file cannot import
 * the provider. test/unit/embeddings-flair-stamp.test.ts compares the flag
 * cases it names (unset and `flair`) with getModelId(). It does not lock
 * every version-resolution path. Unset / hfe stays `gguf:<base>[+searchprefix]`.
 * `flair` is `flair:<registry-entry-digest>[+variant]`. Provenance (prebuilt
 * version, llama.cpp build, pipeline version) is not part of the key.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const EMBEDDING_PREFIXES_ENABLED = true;
const EMBEDDING_VARIANT = "searchprefix";
const EMBEDDING_ENGINE = "gguf";
const PIPELINE_VERSION = "1";

/** Same fields resources/embeddings/models.ts freezes into the built-in entry. */
const FLAIR_ENTRY = {
  id: "nomic-embed-text-v1.5-Q4_K_M",
  sha256: "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac",
  revision: "0188c9bf409793f810680a5a431e7b899c46104c",
  dims: 768,
  pooling: "mean",
  document: "search_document: {text}",
  query: "search_query: {text}",
} as const;

const SUPPORTED = [
  { platform: "linux", arch: "x64", packageName: "@node-llama-cpp/linux-x64" },
  { platform: "linux", arch: "arm64", packageName: "@node-llama-cpp/linux-arm64" },
  { platform: "darwin", arch: "arm64", packageName: "@node-llama-cpp/mac-arm64-metal" },
] as const;

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
/** Same pin as resources/embeddings/platforms.ts PINNED_PREBUILT_VERSION. */
const PINNED_PREBUILT_VERSION = "3.18.1";

export interface CliEmbeddingStamp {
  currentModel: string;
  /** Set only for the gguf engine, where the bare name is the same space. */
  bareCurrentModel: string | null;
}

export interface CliEmbeddingProvenance {
  prebuiltPackage: string;
  prebuiltVersion: string;
  llamaCppBuild: string;
  pipelineVersion: string;
}

export function cliEmbeddingStamp(env: NodeJS.ProcessEnv = process.env): CliEmbeddingStamp {
  const suffix = EMBEDDING_PREFIXES_ENABLED ? `+${EMBEDDING_VARIANT}` : "";
  const flag = env.FLAIR_EMBEDDINGS_ENGINE;
  if (flag != null && flag.trim() !== "" && flag.trim() !== "hfe") {
    if (flag.trim() !== "flair") {
      throw new Error(
        `[embeddings] FLAIR_EMBEDDINGS_ENGINE=${JSON.stringify(flag)} is not a known engine. ` +
          `Expected "hfe" or "flair". Remedy: unset it or set hfe or flair.`,
      );
    }
    return {
      currentModel: `flair:${flairRegistryDigest()}${suffix}`,
      bareCurrentModel: null,
    };
  }
  const baseModel = env.FLAIR_EMBEDDING_MODEL ?? FLAIR_ENTRY.id;
  if (baseModel.includes(":")) {
    throw new Error(
      `[embeddings] FLAIR_EMBEDDING_MODEL must not contain ':' — it is reserved for the ` +
        `<engine>:<model> embedding stamp (embedding-space-guard slice 1); got ${JSON.stringify(baseModel)}`,
    );
  }
  const bareCurrentModel = `${baseModel}${suffix}`;
  return {
    currentModel: `${EMBEDDING_ENGINE}:${bareCurrentModel}`,
    bareCurrentModel,
  };
}

export function flairRegistryDigest(): string {
  const body = [
    FLAIR_ENTRY.id,
    FLAIR_ENTRY.sha256,
    FLAIR_ENTRY.revision,
    String(FLAIR_ENTRY.dims),
    FLAIR_ENTRY.pooling,
    FLAIR_ENTRY.document,
    FLAIR_ENTRY.query,
  ].join("\n");
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Provenance for HealthDetail's CLI rendering. Reads the host platform
 * package only. Does not read `node-llama-cpp` or harper-fabric-embeddings.
 */
export function cliEmbeddingProvenance(
  platform: string = process.platform,
  arch: string = process.arch,
  resolvePackage: (name: string) => string = (name) => createRequire(import.meta.url).resolve(name),
): CliEmbeddingProvenance {
  const match = SUPPORTED.find((entry) => entry.platform === platform && entry.arch === arch);
  const label = `${platform}/${arch}`;
  if (!match) {
    throw new Error(
      `[embeddings] platform ${label} has no supported prebuilt ` +
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
      `[embeddings] prebuilt ${match.packageName} for platform ${label} is not installed. ` +
        `Remedy: install the optional dependency ${match.packageName}@3.18.1. ` +
        `Embeddings stay on keyword search. Refusing to record provenance. (${detail})`,
    );
  }
  const pkgPath = findNamedPackageJson(entry, match.packageName);
  const version = versionFromPackageJson(readText(pkgPath), pkgPath);
  return {
    prebuiltPackage: match.packageName,
    prebuiltVersion: version,
    llamaCppBuild: readLlamaCppBuild(dirname(pkgPath)),
    pipelineVersion: PIPELINE_VERSION,
  };
}

export function formatEmbeddingProvenance(provenance: CliEmbeddingProvenance): string {
  return `${provenance.prebuiltPackage}@${provenance.prebuiltVersion} llama.cpp ${provenance.llamaCppBuild} pipeline ${provenance.pipelineVersion}`;
}

export function isCliCurrentSpace(
  stamp: string | undefined | null,
  parsed: CliEmbeddingStamp,
): boolean {
  if (stamp == null) return false;
  if (stamp === parsed.currentModel) return true;
  return parsed.bareCurrentModel != null && stamp === parsed.bareCurrentModel;
}

function versionFromPackageJson(text: string, pkgPath: string): string {
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
  if (typeof version !== "string" || !EXACT_VERSION.test(version) || version.includes(":")) {
    throw new Error(
      `[embeddings] prebuilt package.json at ${pkgPath} has no exact x.y.z version. Remedy: reinstall the pinned release. Refusing to record provenance.`,
    );
  }
  if (version !== PINNED_PREBUILT_VERSION) {
    throw new Error(
      `[embeddings] prebuilt package.json at ${pkgPath} is version ${version}; ${PINNED_PREBUILT_VERSION} is the tested pin. Remedy: install the pinned release. That version was not tested. Refusing to record provenance.`,
    );
  }
  return version;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[embeddings] ${metaPath} is not JSON. Remedy: reinstall the platform prebuilt. Refusing to record a llama.cpp build. (${detail})`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, "buildOptions")) continue;
    const buildOptions = Reflect.get(parsed, "buildOptions");
    if (typeof buildOptions !== "object" || buildOptions === null || !Object.hasOwn(buildOptions, "llamaCpp")) continue;
    const llamaCpp = Reflect.get(buildOptions, "llamaCpp");
    if (typeof llamaCpp !== "object" || llamaCpp === null || !Object.hasOwn(llamaCpp, "release")) continue;
    const release = Reflect.get(llamaCpp, "release");
    if (typeof release === "string" && release.length > 0 && !release.includes(":")) return release;
  }
  throw new Error(
    `[embeddings] no llama.cpp release under ${bins}. Remedy: reinstall the platform prebuilt. Refusing to record a llama.cpp build.`,
  );
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
