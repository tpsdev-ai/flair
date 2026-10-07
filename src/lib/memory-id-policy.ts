/**
 * memory-id-policy.ts — the Memory record-id rule for the `.content` selector
 * (flair#2199). PURE: string logic only.
 */

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
