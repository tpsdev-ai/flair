/**
 * promotion-content-hash.ts — the promotion content-binding hash (flair#2478)
 * for `src/` callers: restore admission (src/lib/restore-archive.ts,
 * flair#2664).
 *
 * The server computes the same binding in resources/promotion-binding.ts,
 * which the read accessor and the trusted stamp use. The two are separate
 * implementations of one algorithm, SHA-256 over the content as UTF-8, because
 * neither side may import the other: `src/` must not import `resources/`
 * (those imports do not survive npm packaging), and a resource may statically
 * import only `src/` helpers that load no modules at all (flair#1775), while
 * this one loads node:crypto. test/unit/restore-archive-2664.test.ts pins
 * their parity and that no resource imports this module.
 */
import { createHash } from "node:crypto";

/** SHA-256 over the exact stored, post-redaction content as UTF-8. */
export function promotionContentHash(content: unknown): string {
  const text = typeof content === "string" ? content : content == null ? "" : String(content);
  return createHash("sha256").update(text, "utf8").digest("hex");
}
