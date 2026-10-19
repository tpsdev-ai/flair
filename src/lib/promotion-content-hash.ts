/**
 * promotion-content-hash.ts — the one promotion content-binding hash
 * (flair#2478), shared by the server and the CLI.
 *
 * resources/promotion-binding.ts (the read accessor), resources/promotion-
 * stamp.ts (the trusted stamp) and src/lib/restore-archive.ts (restore
 * admission, flair#2664) all bind a verdict through this function, so a stamped
 * hash and an admitted hash are computed the same way.
 *
 * Dependency-free apart from node:crypto, so both `src/` and `resources/`
 * import it: `src/` must not import `resources/`, because those imports do not
 * survive npm packaging.
 */
import { createHash } from "node:crypto";

/** SHA-256 over the exact stored, post-redaction content as UTF-8. */
export function promotionContentHash(content: unknown): string {
  const text = typeof content === "string" ? content : content == null ? "" : String(content);
  return createHash("sha256").update(text, "utf8").digest("hex");
}
