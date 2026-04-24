/**
 * Unified loader for all bridge sources (replaces load-descriptor.ts).
 *
 * Returns a `LoadedBridge` discriminated union. Runners dispatch on
 * `.kind`:
 *   - "yaml": use the existing YAML runtime (applyMap, parseRecords, etc.)
 *   - "code": call the plugin's bridge.import() / bridge.export() directly
 *
 * For code-plugin sources (npm packages), the allow-list gate runs first:
 * if not allowed, throw a BridgeRuntimeError pointing the operator at
 * `flair bridge allow <name>`.
 */

import type {
  DiscoveredBridge,
  YamlBridgeDescriptor,
  MemoryBridge,
} from "../types.js";
import { BridgeRuntimeError } from "../types.js";
import { loadYamlDescriptor } from "./yaml-loader.js";
import { BUILTIN_BY_NAME } from "../builtins/index.js";
import { loadCodePlugin } from "./load-plugin.js";
import { verifyAllow } from "./allow-list.js";
import type { VerifyResult } from "./allow-list.js";

export type LoadedBridge =
  | { kind: "yaml"; descriptor: YamlBridgeDescriptor; source: DiscoveredBridge }
  | { kind: "code"; plugin: MemoryBridge; source: DiscoveredBridge };

export interface LoadOptions {
  /**
   * If true, skip the allow-list check on npm code plugins.
   * Used by `flair bridge list` which only wants to inspect, not execute.
   * Import/export/test always leave this false.
   */
  skipAllowCheck?: boolean;
  /** For unit tests — pluggable dynamic import. */
  importer?: (spec: string) => Promise<unknown>;
  /** For unit tests — override allow-list path. */
  allowListPath?: string;
}

export async function loadBridge(
  discovered: DiscoveredBridge,
  opts: LoadOptions = {},
): Promise<LoadedBridge> {
  switch (discovered.source) {
    case "builtin": {
      const builtin = BUILTIN_BY_NAME.get(discovered.name);
      if (!builtin) {
        throw new BridgeRuntimeError({
          bridge: discovered.name,
          op: "import",
          field: "(builtin)",
          expected: "registered built-in name",
          got: discovered.name,
          hint: `built-in "${discovered.name}" not in the registry — likely code drift between discover.ts and builtins/index.ts`,
        });
      }
      return { kind: "yaml", descriptor: builtin.descriptor, source: discovered };
    }
    case "project-yaml":
    case "user-yaml": {
      const descriptor = await loadYamlDescriptor(discovered.path);
      return { kind: "yaml", descriptor, source: discovered };
    }
    case "npm-package": {
      if (!opts.skipAllowCheck) {
        const verdict = await verifyAllow(discovered, { path: opts.allowListPath });
        if (!verdict.ok) {
          throw new BridgeRuntimeError({
            bridge: discovered.name,
            op: "import",
            path: discovered.path,
            field: "(trust)",
            expected: verdict.reason === "not-allowed" ? "allow-listed code plugin" : "approved package at recorded location/digest",
            got: verdict.reason,
            hint: trustHint(discovered.name, verdict),
          });
        }
      }
      const plugin = await loadCodePlugin(discovered, { importer: opts.importer });
      return { kind: "code", plugin, source: discovered };
    }
  }
}

function trustHint(name: string, verdict: Exclude<VerifyResult, { ok: true }>): string {
  const reapprove = `flair bridge allow ${name}`;
  switch (verdict.reason) {
    case "not-allowed":
      return `npm code plugins run arbitrary JavaScript. First-use approval required. Run: ${reapprove}`;
    case "path-mismatch":
      return `approved package lives at ${verdict.entry.packageDir}, but a different package with the same name was discovered at ${verdict.observedPath}. This is how local squatting attacks present. If the new location is intentional, re-run: ${reapprove}`;
    case "digest-mismatch":
      return `package.json contents changed since approval (recorded sha ${verdict.entry.packageJsonSha256.slice(0, 12)}…, observed ${verdict.observedDigest.slice(0, 12)}…). Re-run if the update is intentional: ${reapprove}`;
    case "entry-incomplete":
      return `allow-list entry for "${name}" is missing a location/digest (likely from a pre-fix Flair version). Re-run: ${reapprove}`;
    case "package-missing":
      return `package at ${verdict.entry?.packageDir ?? "(unknown)"} could not be read; allow-list verification cannot proceed`;
  }
}

/**
 * Kept as a shim for code paths that still call the old name. Remove once
 * all call sites move to loadBridge directly.
 *
 * Returns the YAML descriptor when the source produces one; throws for
 * code plugins (they don't have a YamlBridgeDescriptor representation).
 */
export async function loadDescriptor(
  discovered: DiscoveredBridge,
): Promise<YamlBridgeDescriptor> {
  const loaded = await loadBridge(discovered);
  if (loaded.kind === "yaml") return loaded.descriptor;
  throw new BridgeRuntimeError({
    bridge: discovered.name,
    op: "import",
    path: discovered.path,
    field: "(kind)",
    expected: "yaml descriptor",
    got: "code plugin",
    hint: "this code path expected a YAML descriptor; the bridge is a code plugin — caller should dispatch on loadBridge().kind instead",
  });
}
