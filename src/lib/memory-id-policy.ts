/**
 * memory-id-policy.ts — the Memory record-id rule for the `.content` selector
 * (flair#2199). PURE: string/decoding logic only. Deliberately imports nothing
 * (resources importing this compiled helper require it to be load-free).
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
  // Match an encoded slash in the segment as sent, and in its DECODED form — so
  // a `%2f`/`%2F` in any case, and a slash encoded one level deeper
  // (`%252F`, whose decoded form still carries `%2f`), both count. Deciding on
  // the decoded segment is the same decode-then-scan the property-suffix rule
  // uses, so the two agree on how a segment is read.
  return /%2f/i.test(segment) || /%2f/i.test(decodeMemoryIdSegment(segment));
}

/**
 * Decode one path segment the way Harper decodes a request path before its
 * property parse (`RequestTarget` decodes the path). Returns the raw segment
 * when it is not valid percent-encoding, so a caller here never throws on it.
 * Such a Memory request whose last segment ends in `.content` is refused by
 * the auth middleware with the named 400 (`memory_id_content_suffix`) before
 * any auth branch; another malformed segment is left to Harper's own path
 * handling.
 *
 * Shared so the resource-layer guard and the auth middleware decode a URL-bound
 * id the SAME way (flair#2199 follow-up).
 */
export function decodeMemoryIdSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
