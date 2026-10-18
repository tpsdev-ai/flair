import { createHash } from "node:crypto";

/** The field carrying SHA-256 of the reviewed stored content. Server-only. */
export const PROMOTION_CONTENT_HASH_FIELD = "promotionContentHash";

/** The verdict fields the accessor suppresses together. */
export const PROMOTION_BINDING_FIELDS = [
  "promotionStatus",
  "promotedAt",
  "promotedBy",
  PROMOTION_CONTENT_HASH_FIELD,
] as const;

/** SHA-256 over the exact stored, post-redaction content as UTF-8. */
export function promotionContentHash(content: unknown): string {
  const text = typeof content === "string" ? content : content == null ? "" : String(content);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Does `row` carry a promotion binding that matches its current content? An
 * absent hash (a legacy verdict) does not match.
 */
export function promotionBindingMatches(row: unknown): boolean {
  if (row == null || typeof row !== "object") return false;
  const stored = (row as Record<string, unknown>)[PROMOTION_CONTENT_HASH_FIELD];
  if (typeof stored !== "string" || stored.length === 0) return false;
  return stored === promotionContentHash((row as Record<string, unknown>).content);
}

/**
 * Return `row` with an absent or mismatched promotion binding suppressed. The
 * input is not mutated; a matching binding and a row with none of the four
 * binding fields are returned as-is.
 */
export function applyPromotionBinding<T>(row: T): T {
  if (row == null || typeof row !== "object" || Array.isArray(row)) return row;
  const source = row as Record<string, unknown>;
  const hasVerdict = PROMOTION_BINDING_FIELDS.some((field) => source[field] != null);
  if (!hasVerdict) return row;
  if (promotionBindingMatches(source)) return row;
  return { ...source, promotionStatus: null, promotedAt: null, promotedBy: null, promotionContentHash: null } as T;
}
