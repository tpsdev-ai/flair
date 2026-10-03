/**
 * memory-id-guard.ts — the resource-layer refusal for a Memory id that ends in
 * the `.content` property suffix (flair#2199).
 *
 * Harper reads a trailing `.<declared attribute>` on a by-id Memory request as a
 * property selector. A Memory id ending in `.content` may therefore be read as
 * the base id's record instead of itself, so it is refused at every client write
 * path: POST/PUT/PATCH on the Memory resource and the memory feed return the
 * named 400 below, and the bridge importer refuses it before the write.
 *
 * The decision is the pure `endsWithContentSelectorSuffix`
 * (src/lib/memory-id-policy.ts), so it is unit-tested without a Harper instance.
 * Pre-existing ids ending in `.content` are not migrated: an update through a
 * client write path is refused exactly as a create is.
 */
import { MEMORY_CONTENT_SELECTOR_SUFFIX, endsWithContentSelectorSuffix } from "../src/lib/memory-id-policy.js";

/** The named error for a Memory write naming an id that ends in `.content`. */
export const CONTENT_SUFFIX_ID_ERROR = "memory_id_content_suffix";

/** The named 400 for one offending id. */
export function contentSuffixIdDenial(id: string): Response {
  return new Response(
    JSON.stringify({
      error: CONTENT_SUFFIX_ID_ERROR,
      message: `Memory ids must not end in "${MEMORY_CONTENT_SELECTOR_SUFFIX}": the suffix collides with the Memory property selector.`,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/**
 * Refuse a write when any of its named ids (the URL-bound id and/or a body id)
 * ends in the `.content` suffix; null when none does.
 */
export function refuseContentSuffixId(ids: unknown[]): Response | null {
  const bad = ids.find((id) => endsWithContentSelectorSuffix(id));
  return bad === undefined ? null : contentSuffixIdDenial(String(bad));
}
