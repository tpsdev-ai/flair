/**
 * CLI copy of resources/embeddings-provider.ts getModelId().
 *
 * src/ and resources/ are separate build targets, so this file cannot import
 * the provider. test/unit/embeddings-flair-stamp.test.ts locks the two
 * together. Unset / hfe stays `gguf:<base>[+searchprefix]`.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EMBEDDING_PREFIXES_ENABLED = true;
const EMBEDDING_VARIANT = "searchprefix";
const EMBEDDING_ENGINE = "gguf";
const REGISTRY_ID = "nomic-embed-text-v1.5-Q4_K_M";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

export interface CliEmbeddingStamp {
  currentModel: string;
  /** Set only for the gguf engine, where the bare name is the same space. */
  bareCurrentModel: string | null;
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
    const version = readNodeLlamaCppVersion();
    return {
      currentModel: `node-llama-cpp@${version}:${REGISTRY_ID}${suffix}`,
      bareCurrentModel: null,
    };
  }
  const baseModel = env.FLAIR_EMBEDDING_MODEL ?? REGISTRY_ID;
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

export function isCliCurrentSpace(
  stamp: string | undefined | null,
  parsed: CliEmbeddingStamp,
): boolean {
  if (stamp == null) return false;
  if (stamp === parsed.currentModel) return true;
  return parsed.bareCurrentModel != null && stamp === parsed.bareCurrentModel;
}

const PLATFORM_PACKAGES = [
  "@node-llama-cpp/linux-x64",
  "@node-llama-cpp/mac-arm64-metal",
  "@node-llama-cpp/mac-x64",
  "@node-llama-cpp/linux-arm64",
  "@node-llama-cpp/linux-armv7l",
  "@node-llama-cpp/win-x64",
  "@node-llama-cpp/win-arm64",
] as const;

function readNodeLlamaCppVersion(): string {
  const req = createRequire(import.meta.url);
  let entry: string;
  try {
    entry = req.resolve("node-llama-cpp");
  } catch {
    entry = resolvePlatformPackage(req);
  }
  const pkgPath = findPackageJson(entry);
  let text: string;
  try {
    text = readFileSync(pkgPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[embeddings] node-llama-cpp package.json at ${pkgPath} is unreadable. ` +
        `Remedy: reinstall node-llama-cpp. Refusing to stamp. (${detail})`,
    );
  }
  if (text.trim() === "") {
    throw new Error(
      `[embeddings] node-llama-cpp package.json at ${pkgPath} is empty. Remedy: reinstall it. Refusing to stamp.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[embeddings] node-llama-cpp package.json at ${pkgPath} is not JSON. Remedy: reinstall it. Refusing to stamp. (${detail})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, "version")) {
    throw new Error(
      `[embeddings] node-llama-cpp package.json has no version. Remedy: reinstall the pinned release. Refusing to stamp.`,
    );
  }
  const version = Reflect.get(parsed, "version");
  if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
    throw new Error(
      `[embeddings] node-llama-cpp package.json has no exact x.y.z version. Remedy: reinstall the pinned release. Refusing to stamp.`,
    );
  }
  return version;
}

function resolvePlatformPackage(req: NodeJS.Require): string {
  let anchor: string;
  try {
    anchor = req.resolve("harper-fabric-embeddings");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[embeddings] node-llama-cpp is not installed, and harper-fabric-embeddings is not either, ` +
        `so the flair embedding stamp cannot be formed. ` +
        `Remedy: install the optional node-llama-cpp@3.18.1 peer, or harper-fabric-embeddings. ` +
        `Refusing to stamp. (${detail})`,
    );
  }
  const fromAnchor = createRequire(anchor);
  for (const name of PLATFORM_PACKAGES) {
    try {
      return fromAnchor.resolve(name);
    } catch {
      // try the next platform package
    }
  }
  throw new Error(
    `[embeddings] node-llama-cpp is not installed and no platform prebuilt resolved. ` +
      `Remedy: install node-llama-cpp@3.18.1 or the matching @node-llama-cpp prebuilt. Refusing to stamp.`,
  );
}

function findPackageJson(entry: string): string {
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const text = readFileSync(candidate, "utf8");
      const name = packageName(text);
      if (name === "node-llama-cpp" || (name != null && name.startsWith("@node-llama-cpp/"))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `[embeddings] could not find node-llama-cpp package.json above ${entry}. ` +
      `Remedy: reinstall node-llama-cpp. Refusing to stamp.`,
  );
}

function packageName(text: string): string | undefined {
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
