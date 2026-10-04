/**
 * memory-id-policy.ts — the Memory record-id rule for the `.content` selector
 * (flair#2199). PURE: string logic only, so it is unit-testable and callable
 * from every Memory write path and from the auth middleware.
 *
 * Harper reads a trailing `.<declared attribute>` on a by-id Memory request as a
 * property selector, so `/Memory/<id>.content` addresses the record `<id>`. A
 * record whose id itself ends in `.content` may therefore be read as the base
 * id's record instead of itself. Such an id is refused at every client write
 * path.
 *
 * Pre-existing ids that end in `.content` are NOT migrated: an update through a
 * client write path is refused like a create.
 */

/** The property suffix that a Memory id ending in `.content` collides with. */
export const MEMORY_CONTENT_SELECTOR_SUFFIX = ".content";

/**
 * True when `id` is a Memory record id ending in the `.content` property
 * suffix. Only a string can carry the suffix; a non-string id (Harper allows
 * numeric ids) returns false.
 */
export function endsWithContentSelectorSuffix(id: unknown): boolean {
  return typeof id === "string" && id.endsWith(MEMORY_CONTENT_SELECTOR_SUFFIX);
}

/**
 * True when an id segment (the raw, still-percent-encoded last path segment of
 * a Memory request) contains an encoded `/`, in any case (`%2F` / `%2f`).
 */
export function idSegmentHasEncodedSlash(segment: string): boolean {
  return /%2f/i.test(segment);
}
