/**
 * adapter-surface.ts — the stdio adapter's derived tool set (flair#1580).
 *
 * `@tpsdev-ai/flair-mcp` no longer hand-wires per-tool string literals in
 * index.ts. The advertised set is STDIO_TOOL_DESCRIPTORS from the shared
 * `@tpsdev-ai/flair-tool-descriptors` module — the same descriptors the
 * server TOOLS registry binds to Harper impls. Drift is impossible by
 * construction: a new both-surface descriptor appears here once a
 * FlairClient handler is bound.
 *
 * This module remains the reviewed chokepoint for the stdio ↔ TOOLS seam:
 *
 *   1. `ADAPTER_TOOL_NAMES` is DERIVED from STDIO_TOOL_DESCRIPTORS.
 *   2. `parseAdapterToolNames` still scans for leftover string-literal
 *      tool names passed to the MCP SDK — hand-wiring is now a CI failure,
 *      not the registration path.
 *   3. `STDIO_ADAPTER_EXEMPTIONS` is DERIVED from descriptor surface flags
 *      (the #1578 list, now structural rather than hand-synced).
 */

import {
  STDIO_TOOL_DESCRIPTORS,
  SURFACE_EXEMPTIONS,
  descriptorNames,
} from "@tpsdev-ai/flair-tool-descriptors";

/** Tools registered on the stdio adapter — derived from the shared descriptor list. */
export const ADAPTER_TOOL_NAMES = descriptorNames(STDIO_TOOL_DESCRIPTORS);

export type AdapterToolName = (typeof ADAPTER_TOOL_NAMES)[number];

/**
 * Reviewed one-sided tools at the stdio-adapter ↔ server TOOLS seam.
 * Derived from descriptor `native` / `stdio` flags (flair#1580) — the same
 * names #1578 listed by hand (attention, archive verbs, relationship_store).
 */
export const STDIO_ADAPTER_EXEMPTIONS = {
  registryOnly: SURFACE_EXEMPTIONS.registryOnly,
  adapterOnly: SURFACE_EXEMPTIONS.adapterOnly,
} as const;

/**
 * Collect leftover string-literal tool registrations from adapter source.
 * After #1580 the derived registrar uses `server.tool(d.name, ...)`, so this
 * scan should return empty. A new literal is a CI failure.
 * Does not use `new RegExp` built from runtime input (CodeQL js/regex-injection).
 */
export function parseAdapterToolNames(source: string): string[] {
  const names: string[] = [];
  const re = /server\.tool\(\s*"([a-z][a-z0-9_]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) names.push(match[1]);
  return names;
}

export interface AdapterRegistryParity {
  /** TOOLS names the adapter neither registers nor exempts. */
  missingFromAdapter: string[];
  /** Adapter names that are neither in TOOLS nor adapter-only exempted. */
  extraOnAdapter: string[];
  /** Exemption entries that no longer describe a real one-sided difference. */
  staleExemptions: string[];
}

/**
 * Compare the stdio adapter's tool set to the server TOOLS registry.
 * Equal after applying the reviewed exemption list — otherwise drift.
 * Kept from #1578 as the migration tripwire; #1580 also asserts
 * derived set == descriptor set structurally.
 */
export function adapterRegistryParity(
  registryNames: readonly string[],
  adapterNames: readonly string[],
): AdapterRegistryParity {
  const registry = new Set(registryNames);
  const adapter = new Set(adapterNames);
  const registryOnly = new Set<string>(STDIO_ADAPTER_EXEMPTIONS.registryOnly);
  const adapterOnly = new Set<string>(STDIO_ADAPTER_EXEMPTIONS.adapterOnly);

  const missingFromAdapter = [...registry]
    .filter((name) => !adapter.has(name) && !registryOnly.has(name))
    .sort();
  const extraOnAdapter = [...adapter]
    .filter((name) => !registry.has(name) && !adapterOnly.has(name))
    .sort();

  const staleExemptions = [
    ...[...registryOnly].filter((name) => !registry.has(name) || adapter.has(name)),
    ...[...adapterOnly].filter((name) => !adapter.has(name) || registry.has(name)),
  ].sort();

  return { missingFromAdapter, extraOnAdapter, staleExemptions };
}

/**
 * Structural #1580 assert: the bound handler set equals the stdio descriptor set.
 */
export function derivedDescriptorParity(
  handlerNames: readonly string[],
  descriptorNamesList: readonly string[] = ADAPTER_TOOL_NAMES,
): { missingHandlers: string[]; extraHandlers: string[] } {
  const handlers = new Set(handlerNames);
  const descriptors = new Set(descriptorNamesList);
  return {
    missingHandlers: [...descriptors].filter((n) => !handlers.has(n)).sort(),
    extraHandlers: [...handlers].filter((n) => !descriptors.has(n)).sort(),
  };
}
