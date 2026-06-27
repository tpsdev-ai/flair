/**
 * mcp-curation.ts — the native-MCP curation boundary (FLAIR-NATIVE-MCP, slice 1).
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Harper 5.1.14's native MCP "application" profile (components/mcp/tools/
 * application.js → buildApplicationTools) auto-exposes EVERY exported Resource
 * that (a) has `exportTypes.mcp !== false` and (b) is not `static hidden`, as a
 * full set of verb tools (`get_* / search_* / create_* / update_* / delete_*`).
 * In a flair boot that is **147 tools, including create_/update_/delete_ mutators
 * on Agent, Credential, OAuth*, Federation*, etc.** — i.e. raw write/delete of
 * the entire datastore to any connected MCP client.
 *
 * ── Why the config allow-list does NOT save us (key finding) ─────────────────
 * `mcp.application.allow` / `deny` ARE accepted by Harper's config validator
 * (validation/configValidator.js — mcpApplicationSchema inherits allow/deny) and
 * the param keys exist (hdbTerms: MCP_APPLICATION_ALLOW/DENY), BUT in 5.1.14
 * NOTHING READS THEM for the application profile — only the *operations* profile
 * honors allow/deny (tools/operations.js:isOperationAllowed). Verified by grep:
 * MCP_APPLICATION_ALLOW/DENY appear only in their own definition, never at a read
 * site. So a config allow-list is a silent no-op and would expose all 147.
 *
 * ── The actual security boundary (resource-level, not config-level) ─────────
 * buildApplicationTools filters by exactly two resource-level signals:
 *   1. `entry.exportTypes.mcp === false`  → schema `@export(mcp: false)`
 *   2. `ResourceClass.hidden === true`    → `static hidden = MCP_HIDDEN`
 * jsResource registration (resources/jsResource.js:89,109) re-registers a path
 * with `exportTypes = undefined`, so a flair override class (e.g. `Memory extends
 * databases.flair.Memory`) LOSES any schema-level `@export(mcp:false)`. Therefore
 * `static hidden` on the class is the reliable, override-proof suppressor, and
 * schema `@export(mcp:false)` is defense-in-depth on the auto-generated tables.
 *
 * Every flair Resource class is marked `static hidden = MCP_HIDDEN` EXCEPT the
 * single curated `FlairMcp` surface. The curated 9 tools are authored on
 * `FlairMcp` via `static mcpTools` and wrap the existing handlers. The
 * integration test (`test/integration/mcp-surface.test.ts`) is the backstop: it
 * boots with the flag ON and asserts `tools/list` is EXACTLY the 9 — so a future
 * resource added without `static hidden` fails CI instead of silently leaking.
 */

/**
 * Marker value for `static hidden` on every non-curated flair Resource. A named
 * constant (vs a bare `true`) so the suppression is greppable and self-documenting
 * at each call site, and so the audit (`grep "static hidden = MCP_HIDDEN"`) maps
 * 1:1 to suppressed resources.
 *
 * Harper only checks `ResourceClass.hidden === true`, so the value IS `true`.
 */
export const MCP_HIDDEN = true as const;

/**
 * Is the native /mcp surface enabled? Default-OFF feature flag (STANDARDS:
 * feature-flag risky changes; byte-identical when off). The /mcp surface stays
 * off in prod until the Bearer verifier (slice 2/3, HarperFast/oauth#86) lands
 * and Sherlock signs off on live enablement.
 *
 * Read from `FLAIR_MCP_ENABLED` — truthy values: "1", "true", "yes", "on"
 * (case-insensitive). Anything else (incl. unset) → OFF.
 */
export function mcpEnabled(): boolean {
  const raw = (process.env.FLAIR_MCP_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
