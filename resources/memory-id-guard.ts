/**
 * memory-id-guard.ts — the resource-layer refusal for a Memory id that ends in
 * the `.content` property suffix (flair#2199).
 *
 */
import { MEMORY_CONTENT_SELECTOR_SUFFIX, endsWithContentSelectorSuffix } from "../src/lib/memory-id-policy.js";

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
    ? decodeURIComponent(target.pathname.split("/").at(-1) ?? "")
    : undefined;
  const bad = [...ids, rawId].find((id) => endsWithContentSelectorSuffix(id));
  return bad === undefined ? null : contentSuffixIdDenial(String(bad));
}
