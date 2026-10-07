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
 * Tier expiry for Memory POST/PUT/PATCH, feed ingest, AgentSeed and federation.
 * Omitted durability carries the stored tier. Leaving ephemeral clears an
 * inherited expiry; entering it stamps a default. Local same-tier updates keep the
 * stored expiry unless explicitly changed. Valid explicit UTC dates are kept.
 * Feed ingest defaults omitted durability to standard before calling this rule.
 * AgentSeed accepts no explicit expiry. Raw re-writers do not call this rule.
 */
export function stampEphemeralExpiry(
  content: Record<string, any>,
  preExisting?: { durability?: unknown; expiresAt?: unknown } | null,
  options: { incoming?: boolean } = {},
): string | null {
  if (content.durability == null && preExisting?.durability != null) {
    content.durability = preExisting.durability;
  }
  const explicitExpiry = content.expiresAt !== undefined;
  if (content.durability !== "ephemeral") {
    if (preExisting?.durability === "ephemeral" && !explicitExpiry) content.expiresAt = null;
    return null;
  }
  const now = Date.now();
  if (explicitExpiry && (options.incoming || content.expiresAt !== null)) {
    const value = content.expiresAt;
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
      return "expiresAt must be a valid UTC ISO date";
    }
    if (options.incoming && (parsed < 0 || parsed > now + 365 * 24 * MS_PER_HOUR)) {
      return "incoming expiresAt must be between the Unix epoch and receiver time plus 365 days";
    }
    return null;
  }
  if (!options.incoming && !explicitExpiry && preExisting?.durability === "ephemeral" && preExisting.expiresAt != null) {
    content.expiresAt = preExisting.expiresAt;
    return null;
  }
  const ttlHours = Number(process.env.FLAIR_EPHEMERAL_TTL_HOURS || 24);
  content.expiresAt = new Date(now + ttlHours * MS_PER_HOUR).toISOString();
  return null;
}
