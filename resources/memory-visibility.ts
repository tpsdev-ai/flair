/**
 * ─── The single "is this Memory private" predicate (federation-edge-hardening
 * slice 2: one rule, one place) ───────────────────────────────────
 *
 * Shared by BOTH:
 *   - resources/memory-read-scope.ts's resolveReadScope() — the cross-agent
 *     READ scope every read path (Memory.search/get, SemanticSearch,
 *     MemoryBootstrap, the by-id auth-middleware guard) resolves through.
 *   - src/cli.ts's runFederationSyncOnce() — the federation-sync PUSH filter
 *     that must not replicate `private` memories to peer instances.
 *
 * Deliberately has ZERO imports — not even "@harperfast/harper". That is
 * intentional and load-bearing: src/cli.ts is a standalone CLI entrypoint
 * that runs OUTSIDE any running Harper instance (e.g. `flair federation
 * sync` invoked from a cron/launchd job). resources/memory-read-scope.ts
 * imports `databases` from "@harperfast/harper", and that package's
 * top-level init eagerly resolves storage paths and THROWS when there is no
 * live Harper runtime backing it (confirmed empirically — it takes down
 * even `flair --help`). So src/cli.ts must never import
 * resources/memory-read-scope.ts (or anything else that drags that
 * side-effecting import in) directly. This module is the safe seam: a pure
 * function + constant that both sides can import without dragging in
 * "@harperfast/harper".
 *
 * ── The migration invariant (non-negotiable, mirrors memory-read-scope.ts) ──
 * A record with NO `visibility` field (written before the field existed) is
 * NOT private — it must keep syncing/reading exactly as before. This is why
 * the predicate is "is this exactly 'private'", never "is this not 'shared'":
 * missing/null/anything-other-than-'private' all count as non-private.
 */

export const PRIVATE_VISIBILITY = "private";

/** True only when visibility is the literal string "private". Null, undefined,
 *  "shared", or any other value are all non-private (see migration invariant
 *  above) — never invert this to an allowlist of "shared". */
export function isPrivateVisibility(visibility: string | null | undefined): boolean {
  return visibility === PRIVATE_VISIBILITY;
}
