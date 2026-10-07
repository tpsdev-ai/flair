export const DURABILITY_TIER_GUARANTEES: readonly string[] = [
  "permanent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it); it never decays; bootstrap considers the bootstrapping agent's own permanent memories before recent rows, subject to scope, expiry/closure and the token budget.",
  "persistent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it).",
  "standard — routine maintenance archives it once its validTo passes or, as a session note, after 30 days.",
  "ephemeral — routine maintenance reaps it once its TTL (24h by default) passes.",
];

/** The one-sentence limit every durability tier shares. */
export const DURABILITY_CAVEAT =
  "No tier adds a flush, fsync, backup or replica acknowledgement: an explicit delete (owner or admin) or a store failure can end any of them.";

/**
 * ─── The single "is this a valid durability" writer-intent guard ────────────
 *
 * Mirror of resources/memory-visibility.ts's assertValidVisibility, for the
 * durability enum. Same asymmetry, same reason:
 *
 *   - READING an unknown durability must be permissive. A row written before a
 *     tier existed (or by a non-Python adapter) may hold anything, and the read
 *     side must keep resolving it exactly as before — defaultVisibilityForDurability
 *     treats any non-permanent/persistent string as the private branch, and that
 *     fail-safe must not change.
 *   - WRITING an unknown durability must be refused. Today an unknown value via
 *     raw REST (or a future non-Python adapter) is silently accepted and lands on
 *     the narrower private branch by accident — fail-safe, but unvalidated by
 *     contract. Refusing at the schema boundary makes it safe by construction and
 *     makes adk-flair's "validated server-side" claim true as written (flair#1238,
 *     from Sherlock's #1237 review).
 *
 * Deliberately has ZERO imports — same load-bearing reason as memory-visibility.ts:
 * this module is a pure function + constant that any caller can import without
 * dragging in "harper".
 */

/** The only values a WRITER may supply. */
export const WRITABLE_DURABILITIES = ["permanent", "persistent", "standard", "ephemeral"] as const;

/**
 * Reject a durability a writer supplied that is not one of the four valid values.
 * Returns an error message, or null when the value is acceptable.
 *
 * `undefined`/`null` are accepted: omitting the field is how a caller asks for
 * the default ("standard"), and that is a documented, intentional path.
 */
export function assertValidDurability(durability: unknown): string | null {
  if (durability === undefined || durability === null) return null;
  if (typeof durability === "string" && (WRITABLE_DURABILITIES as readonly string[]).includes(durability)) {
    return null;
  }
  return (
    `durability must be ${WRITABLE_DURABILITIES.map((v) => `"${v}"`).join(" or ")} ` +
    `(got: ${JSON.stringify(durability)}). Omit it to use the default "standard".`
  );
}

/** Milliseconds in one hour — the unit FLAIR_EPHEMERAL_TTL_HOURS is expressed in. */
const MS_PER_HOUR = 3600_000;

/**
 * ─── The one rule that stamps an ephemeral write's tier expiry ────────────
 *
 * MemoryMaintenance reaps a Memory row only when its durability is "ephemeral"
 * AND its expiresAt is in the past (resources/MemoryMaintenance.ts). An
 * ephemeral row stored without an expiresAt is therefore never reaped, so the
 * 24-hour ephemeral tier silently stops expiring. Every writer that
 * can land an ephemeral row gives it that expiry through this one rule:
 * Memory.post()/put()/patch(), the feed ingest, the agent seed and the
 * federation merge.
 *
 * Sets expiresAt on `content` IN PLACE when the EFFECTIVE durability is
 * "ephemeral" and no expiry is present:
 *
 *   - effective durability is the write's own `durability`, else the stored
 *     row's (`PUT`/`PATCH` may omit it; the tier is then the pre-existing row's);
 *   - a caller-supplied expiresAt is never overwritten;
 *   - a pre-existing row's expiresAt is carried forward, never re-stamped —
 *     an update of an already-expiring row must not extend its window;
 *   - otherwise the tier default applies: now + FLAIR_EPHEMERAL_TTL_HOURS
 *     (default 24), read at write time.
 *
 * Deliberately has ZERO imports (same load-bearing reason as
 * assertValidDurability above): any caller — a resource, a raw table writer, a
 * migration — can import it without dragging in "harper".
 */
export function stampEphemeralExpiry(
  content: Record<string, any>,
  preExisting?: { durability?: unknown; expiresAt?: unknown } | null,
): void {
  const effectiveDurability = content.durability ?? preExisting?.durability;
  if (effectiveDurability !== "ephemeral") return;
  if (content.expiresAt) return;
  if (preExisting?.expiresAt) {
    content.expiresAt = preExisting.expiresAt;
    return;
  }
  const ttlHours = Number(process.env.FLAIR_EPHEMERAL_TTL_HOURS || 24);
  content.expiresAt = new Date(Date.now() + ttlHours * MS_PER_HOUR).toISOString();
}
