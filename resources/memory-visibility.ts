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
 * Deliberately has ZERO imports — not even "harper". That is
 * intentional and load-bearing: src/cli.ts is a standalone CLI entrypoint
 * that runs OUTSIDE any running Harper instance (e.g. `flair federation
 * sync` invoked from a cron/launchd job). resources/memory-read-scope.ts
 * imports `databases` from "harper", and that package's
 * top-level init eagerly resolves storage paths and THROWS when there is no
 * live Harper runtime backing it (confirmed empirically — it takes down
 * even `flair --help`). So src/cli.ts must never import
 * resources/memory-read-scope.ts (or anything else that drags that
 * side-effecting import in) directly. This module is the safe seam: a pure
 * function + constant that both sides can import without dragging in
 * "harper".
 *
 * ── The migration invariant (non-negotiable, mirrors memory-read-scope.ts) ──
 * A record with NO `visibility` field (written before the field existed) is
 * NOT private — it must keep syncing/reading exactly as before. This is why
 * the predicate is "is this exactly 'private'", never "is this not 'shared'":
 * missing/null/anything-other-than-'private' all count as non-private.
 */

export const PRIVATE_VISIBILITY = "private";
export const SHARED_VISIBILITY = "shared";

/** The only values a WRITER may supply. Deliberately not derived from the read
 *  predicate below — see the asymmetry note on assertValidVisibility. */
export const WRITABLE_VISIBILITIES = [PRIVATE_VISIBILITY, SHARED_VISIBILITY] as const;

/** True only when visibility is the literal string "private". Null, undefined,
 *  "shared", or any other value are all non-private (see migration invariant
 *  above) — never invert this to an allowlist of "shared". */
export function isPrivateVisibility(visibility: string | null | undefined): boolean {
  return visibility === PRIVATE_VISIBILITY;
}

/**
 * Reject a visibility a writer supplied that is not one of the two valid values.
 * Returns an error message, or null when the value is acceptable.
 *
 * ── Why this is NOT the inverse of isPrivateVisibility (flair#1009) ──────────
 *
 * The read predicate above must stay "is this exactly 'private'", because a row
 * written before the field existed has no visibility and must keep reading as it
 * always did. That is a MIGRATION rule about stored data, and it is correct.
 *
 * The consequence is that on the read side every unrecognised value — a typo, a
 * wrong case, a retired tier — resolves to non-private and is readable by every
 * agent on the instance. #1006 closed that at the two writer-intent boundaries
 * (the CLI flag, the MCP tool argument); REST and the in-process API still
 * accepted anything, so `PUT /Memory/<id> {"visibility":"prvate"}` wrote a
 * memory the caller believed was owner-only and everyone could read.
 *
 * So the two directions need different rules, and conflating them breaks one or
 * the other:
 *   - READING an unknown value must be permissive, or old rows break.
 *   - WRITING an unknown value must be refused, or a typo silently widens who
 *     can read a memory.
 *
 * Refusing is also the only safe option at write time. Silently dropping the key
 * would fall back to the durability-keyed default, which for a permanent or
 * persistent write is `shared` — the same wrong outcome, arrived at quietly.
 *
 * `undefined`/`null` are accepted: omitting the field is how a caller asks for
 * the durability-keyed default, and that is a documented, intentional path.
 */
export function assertValidVisibility(visibility: unknown): string | null {
  if (visibility === undefined || visibility === null) return null;
  if (typeof visibility === "string" && (WRITABLE_VISIBILITIES as readonly string[]).includes(visibility)) {
    return null;
  }
  return (
    `visibility must be ${WRITABLE_VISIBILITIES.map((v) => `"${v}"`).join(" or ")} ` +
    `(got: ${JSON.stringify(visibility)}). Omit it to use the durability-keyed default: ` +
    `permanent/persistent -> shared, standard/ephemeral -> private.`
  );
}
