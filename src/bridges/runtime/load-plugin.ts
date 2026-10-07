/**
 * Dynamic loader for Shape B code-plugin bridges.
 */

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { DiscoveredBridge, MemoryBridge } from "../types.js";
import { BridgeRuntimeError } from "../types.js";

export interface LoadPluginOptions {
  /**
   * Override for dynamic import. Used by tests to inject a fake module
   * without having to `npm link` a plugin. In production this is the
   * real `(spec) => import(spec)`.
   */
  importer?: (spec: string) => Promise<unknown>;
}

const DEFAULT_IMPORTER = (spec: string): Promise<unknown> => import(spec);

export async function loadCodePlugin(
  discovered: DiscoveredBridge,
  opts: LoadPluginOptions = {},
): Promise<MemoryBridge> {
  if (discovered.source !== "npm-package") {
    throw new BridgeRuntimeError({
      bridge: discovered.name,
      op: "import",
      field: "source",
      expected: "npm-package",
      got: discovered.source,
      hint: "loadCodePlugin only handles Shape B (npm code plugin) bridges; YAML descriptors go through the YAML loader",
    });
  }

  const importer = opts.importer ?? DEFAULT_IMPORTER;
  let spec = pathToFileURL(discovered.path).href;

  let mod: unknown;
  try {
    spec = pathToFileURL(await resolveEntry(discovered)).href;
    mod = await importer(spec);
  } catch (err: any) {
    if (err instanceof BridgeRuntimeError) throw err;
    throw new BridgeRuntimeError({
      bridge: discovered.name,
      op: "import",
      path: discovered.path,
      field: "(import)",
      expected: "importable npm package",
      got: err?.code ?? "import error",
      hint: `could not dynamic-import ${spec}: ${err?.message ?? err}`,
    });
  }

  const candidate = pickBridgeExport(mod);
  if (!candidate) {
    throw new BridgeRuntimeError({
      bridge: discovered.name,
      op: "import",
      path: discovered.path,
      field: "exports",
      expected: "named `bridge` export or default export implementing MemoryBridge",
      got: typeof mod === "object" && mod !== null ? `exports=${Object.keys(mod).join(",") || "(empty)"}` : typeof mod,
      hint: `flair-bridge-<name> packages must export \`bridge\` (or default-export) a MemoryBridge. See docs/bridges.md § Shape B`,
    });
  }

  // Validate the shape. Keep this minimal — we trust the plugin author
  // to build a working MemoryBridge; we just need enough to route calls.
  validateBridge(discovered, candidate);
  return candidate;
}

function importTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const conditions = value as Record<string, unknown>;
  return importTarget(conditions.import) ?? importTarget(conditions.default);
}

async function resolveEntry(discovered: DiscoveredBridge): Promise<string> {
  const root = await realpath(discovered.path);
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const exported = importTarget(
    pkg.exports && typeof pkg.exports === "object" && Object.hasOwn(pkg.exports, ".")
      ? pkg.exports["."]
      : pkg.exports,
  );
  const field = exported !== undefined ? "exports" : typeof pkg.main === "string" ? "main" : "index.js";
  const target = exported ?? (typeof pkg.main === "string" ? pkg.main : "index.js");
  const entry = resolve(root, target);
  const assertInside = (path: string): void => {
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new BridgeRuntimeError({
        bridge: discovered.name,
        op: "import",
        path: discovered.path,
        field,
        expected: "entry inside package directory",
        got: target,
        hint: `package.json ${field} resolves outside the package directory`,
      });
    }
  };
  assertInside(entry);
  const resolved = await realpath(entry);
  assertInside(resolved);
  return resolved;
}

function pickBridgeExport(mod: unknown): MemoryBridge | null {
  if (!mod || typeof mod !== "object") return null;
  const m = mod as Record<string, unknown>;
  if (isBridgeLike(m.bridge)) return m.bridge as MemoryBridge;
  if (isBridgeLike(m.default)) return m.default as MemoryBridge;
  if (isBridgeLike(m)) return m as unknown as MemoryBridge;
  return null;
}

function isBridgeLike(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.name === "string" && (typeof o.import === "function" || typeof o.export === "function");
}

function validateBridge(discovered: DiscoveredBridge, b: MemoryBridge): void {
  if (typeof b.name !== "string" || !b.name) {
    throw new BridgeRuntimeError({
      bridge: discovered.name,
      op: "import",
      path: discovered.path,
      field: "name",
      expected: "non-empty string",
      got: JSON.stringify(b.name),
      hint: "MemoryBridge.name must be a non-empty string matching the npm package's flair-bridge-<name>",
    });
  }
  if (b.name !== discovered.name) {
    throw new BridgeRuntimeError({
      bridge: discovered.name,
      op: "import",
      path: discovered.path,
      field: "name",
      expected: `"${discovered.name}" (from package name flair-bridge-${discovered.name})`,
      got: `"${b.name}"`,
      hint: "MemoryBridge.name must match the npm package's public name suffix — mismatch would surprise discovery and allow-list lookups",
    });
  }
  if (b.kind !== "file" && b.kind !== "api") {
    throw new BridgeRuntimeError({
      bridge: discovered.name,
      op: "import",
      path: discovered.path,
      field: "kind",
      expected: `"file" | "api"`,
      got: JSON.stringify(b.kind),
      hint: "MemoryBridge.kind must be 'file' or 'api'",
    });
  }
  if (typeof b.import !== "function" && typeof b.export !== "function") {
    throw new BridgeRuntimeError({
      bridge: discovered.name,
      op: "import",
      path: discovered.path,
      field: "(methods)",
      expected: "at least one of `import` or `export`",
      got: "neither",
      hint: "MemoryBridge needs at least one of import/export implemented. See spec §6",
    });
  }
}
