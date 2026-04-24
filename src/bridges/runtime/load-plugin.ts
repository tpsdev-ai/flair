/**
 * Dynamic loader for Shape B code-plugin bridges.
 *
 * Given a discovered `npm-package` source, dynamic-import the package,
 * validate that it exports a `MemoryBridge`, and return the loaded module.
 * The import is done via `createRequire` relative to the package root so
 * scoped packages and deep nested deps resolve correctly.
 *
 * Validation is deliberately minimal: `name`, `version`, `kind`, and at
 * least one of `import` / `export` must be present and look right. The
 * spec §6 contract is "duck-type at runtime, strict error messages."
 */

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
  // Package root path — the entry point is resolved by Node's package.json
  // "main"/"exports" fields. Use a file:// URL so Node resolves it as a
  // filesystem path rather than a bare specifier.
  const spec = pathToFileURL(discovered.path + "/").href;

  let mod: unknown;
  try {
    mod = await importer(spec);
  } catch (err: any) {
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
      hint: `flair-bridge-<name> packages must export \`bridge\` (or default-export) a MemoryBridge. See specs/FLAIR-BRIDGES.md §6`,
    });
  }

  // Validate the shape. Keep this minimal — we trust the plugin author
  // to build a working MemoryBridge; we just need enough to route calls.
  validateBridge(discovered, candidate);
  return candidate;
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
