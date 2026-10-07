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
 * when it names a declared attribute). A reference that is not a string, or
 * that carries no such selector, resolves to its decoded form. Used so a
 * `supersedes` reference is authorized against the record it actually
 * addresses, whatever suffix or encoding it carries (flair#2199 follow-up).
 */
export function resolveMemoryReferenceId(ref: unknown): string | undefined {
  if (typeof ref !== "string") return undefined;
  const decoded = decodeMemoryIdSegment(ref);
  const dot = decoded.indexOf(".");
  if (dot > -1 && DECLARED.has(decoded.slice(dot + 1))) return decoded.slice(0, dot);
  return decoded;
}
