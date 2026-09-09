/**
 * adapter-surface.ts — the stdio adapter's declared tool set (flair#1575).
 *
 * `@tpsdev-ai/flair-mcp` hand-wires each tool via `server.tool(...)` in
 * index.ts. The native `/mcp` handler ships a separate `TOOLS` registry in
 * resources/mcp-tools.ts. Those two surfaces drifted: skill_* landed in
 * TOOLS for 0.52.0 and never reached this package — the surface Claude Code
 * and Cursor actually use.
 *
 * This module is the reviewed chokepoint for that seam:
 *
 *   1. `ADAPTER_TOOL_NAMES` is the adapter's declared tool set.
 *   2. `parseAdapterToolNames` reads the names actually passed to
 *      `server.tool(...)` in index.ts, so the declaration cannot outrun
 *      registration (or vice versa).
 *   3. `STDIO_ADAPTER_EXEMPTIONS` is the explicit, reviewed list of names
 *      that exist on one surface but not the other. A TOOLS name that is
 *      neither registered here nor exempted is a CI failure — silent drift
 *      of the class that hid skill_*.
 *
 * Deriving the adapter's handlers from TOOLS (so a new registry tool appears
 * here for free) is the durable structural fix; it does not fit this chip
 * because TOOLS is Harper-linked server code and this package talks HTTP via
 * FlairClient. Detection + exemption list ships now; derive is a follow-on.
 */

/** Tools registered on the stdio adapter via `server.tool(...)` in index.ts. */
export const ADAPTER_TOOL_NAMES = [
  "bootstrap",
  "flair_orgevent",
  "flair_workspace_set",
  "memory_delete",
  "memory_get",
  "memory_search",
  "memory_store",
  "memory_update",
  "record_usage",
  "relationship_store",
  "skill_get",
  "skill_search",
  "skill_store",
  "soul_get",
  "soul_set",
] as const;

export type AdapterToolName = (typeof ADAPTER_TOOL_NAMES)[number];

/**
 * Reviewed exemptions at the stdio-adapter ↔ server TOOLS seam (flair#1575).
 *
 * A name here is a deliberate, reviewed difference — not silent drift.
 * Adding or removing a name is the control: CI fails if an exemption is
 * unused (the tool appeared on both sides, or vanished from the side it
 * was excused on) or if a non-exempt name exists on only one side.
 */
export const STDIO_ADAPTER_EXEMPTIONS = {
  /**
   * Present in resources/mcp-tools.ts `TOOLS`, not wired on the stdio adapter.
   *
   * - attention: native /mcp only (flair#677). mcp-tools.ts's module doc
   *   explicitly does not mirror it into this package.
   * - memory_basement / memory_restore: archive verbs (flair#1472) landed
   *   on native /mcp; not yet forwarded over FlairClient.
   */
  registryOnly: ["attention", "memory_basement", "memory_restore"],
  /**
   * Wired on the stdio adapter, absent from `TOOLS`.
   *
   * - relationship_store: the adapter predates the record-types mcp
   *   declaration. Relationship has no `RECORD_TYPES.mcp` field, so TOOLS
   *   ships zero relationship_* names. The adapter still exposes the triple
   *   write (FlairClient.relationship.write).
   */
  adapterOnly: ["relationship_store"],
} as const;

/**
 * Collect `server.tool("name", ...)` registrations from adapter source.
 * Plain string scan — the first string literal argument is the tool name.
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
