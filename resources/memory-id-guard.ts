/**
 * memory-id-guard.ts — the resource-layer refusal for a Memory id that ends in
 * the `.content` property suffix (flair#2199).
 *
 */
import { MEMORY_CONTENT_SELECTOR_SUFFIX, endsWithContentSelectorSuffix, decodeMemoryIdSegment } from "../src/lib/memory-id-policy.js";
import { DECLARED_MEMORY_ATTRIBUTES } from "./memory-declared-attributes.js";

const DECLARED = new Set<string>(DECLARED_MEMORY_ATTRIBUTES as readonly string[]);

/** The named error for a Memory write naming an id that ends in `.content`. */
export const CONTENT_SUFFIX_ID_ERROR = "memory_id_content_suffix";

/** The named 400 for one offending id. */
export function contentSuffixIdDenial(id: string): Response {
  return new Response(
    JSON.stringify({
      error: CONTENT_SUFFIX_ID_ERROR,
      message: `Memory ids must not end in "${MEMORY_CONTENT_SELECTOR_SUFFIX}".`,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/**
 * Refuse a write when any of its named ids (the URL-bound id and/or a body id)
 * ends in the `.content` suffix.
 */
export function refuseContentSuffixId(ids: unknown[], target?: { pathname?: unknown }): Response | null {
  const rawId = typeof target?.pathname === "string"
    ? decodeMemoryIdSegment(target.pathname.split("/").at(-1) ?? "")
    : undefined;
  const bad = [...ids, rawId].find((id) => endsWithContentSelectorSuffix(id));
  return bad === undefined ? null : contentSuffixIdDenial(String(bad));
}

/**
 * The record id a Memory reference resolves to, the way Harper resolves a
 * by-id path: decode it, then drop a trailing `.<declared attribute>` selector
 * (Harper splits at the FIRST dot and treats the remainder as a property ONLY
 * when it names a declared attribute). A reference that carries no such
 * selector resolves to its decoded form; a non-string resolves to undefined.
 * Memory.ts resolves a `supersedes` reference with this once, before anything
 * reads it, and uses the result for the reserved-id check, the authorization
 * read (non-admin agents only), the stored reference and the close
 * (flair#2307).
 */
export function resolveMemoryReferenceId(ref: unknown): string | undefined {
  if (typeof ref !== "string") return undefined;
  const decoded = decodeMemoryIdSegment(ref);
  const dot = decoded.indexOf(".");
  if (dot > -1 && DECLARED.has(decoded.slice(dot + 1))) return decoded.slice(0, dot);
  return decoded;
}

/** The named error for a `supersedes` target whose read failed (flair#2307). */
export const SUPERSEDES_TARGET_UNREADABLE_ERROR = "supersedes_target_unreadable";
/** The named error for a `supersedes` target that does not exist (flair#2307). */
export const SUPERSEDES_TARGET_MISSING_ERROR = "supersedes_target_missing";

/**
 * Refuse a write whose `supersedes` target could not be read: the predecessor
 * read every write with a `supersedes` makes (prepareSkillBody in
 * resources/skill-version-write.ts), or, for a non-admin agent, the
 * authorization read. A client error from the read (an id Harper cannot look
 * up) answers 400; anything else 503, since a retry can succeed. Nothing has
 * been written when this is returned.
 */
export function supersedesTargetUnreadable(err: unknown): Response {
  const code = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  const status = typeof code === "number" && code >= 400 && code < 500 ? 400 : 503;
  return new Response(
    JSON.stringify({
      error: SUPERSEDES_TARGET_UNREADABLE_ERROR,
      message: "the record named by `supersedes` could not be read; nothing was written",
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** Refuse a write whose `supersedes` names a record that does not exist. */
export function supersedesTargetMissing(): Response {
  return new Response(
    JSON.stringify({
      error: SUPERSEDES_TARGET_MISSING_ERROR,
      message: "the record named by `supersedes` does not exist; nothing was written",
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}
