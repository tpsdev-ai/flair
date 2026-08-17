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
