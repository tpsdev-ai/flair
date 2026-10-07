/**
 * Exact `node-llama-cpp` version for the flair embedding stamp.
 * Reads the installed package.json. An unreadable or non-x.y.z body refuses;
 * it is not stamped as empty.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const PLATFORM_PACKAGES = [
  "@node-llama-cpp/linux-x64",
  "@node-llama-cpp/mac-arm64-metal",
  "@node-llama-cpp/mac-x64",
  "@node-llama-cpp/linux-arm64",
  "@node-llama-cpp/linux-armv7l",
  "@node-llama-cpp/win-x64",
  "@node-llama-cpp/win-arm64",
] as const;

export function readNodeLlamaCppVersion(): string {
  const req = createRequire(import.meta.url);
  let entry: string;
  try {
    // The package does not export ./package.json. Resolve the entry, then
    // walk up to the package.json whose name is node-llama-cpp.
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
  return versionFromPackageJson(text, pkgPath);
}

/** Fail closed: empty, unreadable JSON, or a non-x.y.z version is not a stamp. */
export function versionFromPackageJson(text: string, pkgPath = "node-llama-cpp/package.json"): string {
  if (text.trim() === "") {
    throw new Error(
      `[embeddings] node-llama-cpp package.json at ${pkgPath} is empty. ` +
        `Remedy: reinstall node-llama-cpp. Refusing to stamp.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[embeddings] node-llama-cpp package.json at ${pkgPath} is not JSON. ` +
        `Remedy: reinstall node-llama-cpp. Refusing to stamp. (${detail})`,
    );
  }
  const version = readVersionField(parsed);
  if (version == null) {
    throw new Error(
      `[embeddings] node-llama-cpp package.json has no exact x.y.z version. ` +
        `Remedy: reinstall the pinned release. Refusing to stamp.`,
    );
  }
  if (version.includes(":")) {
    throw new Error(
      `[embeddings] node-llama-cpp version must not contain ':' (reserved for the embedding stamp). ` +
        `Remedy: install a release whose version is x.y.z. Refusing to stamp.`,
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
  const tried: string[] = [];
  for (const name of PLATFORM_PACKAGES) {
    try {
      return fromAnchor.resolve(name);
    } catch {
      tried.push(name);
    }
  }
  throw new Error(
    `[embeddings] node-llama-cpp is not installed and no platform prebuilt resolved (${tried.join(", ")}). ` +
      `Remedy: install node-llama-cpp@3.18.1 or the matching @node-llama-cpp prebuilt. Refusing to stamp.`,
  );
}

function findPackageJson(entry: string): string {
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      let text: string;
      try {
        text = readFileSync(candidate, "utf8");
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[embeddings] node-llama-cpp package.json at ${candidate} is unreadable. ` +
            `Remedy: reinstall node-llama-cpp. Refusing to stamp. (${detail})`,
        );
      }
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

function readVersionField(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (!Object.hasOwn(parsed, "version")) return undefined;
  const version = Reflect.get(parsed, "version");
  if (typeof version !== "string" || !EXACT_VERSION.test(version)) return undefined;
  return version;
}
