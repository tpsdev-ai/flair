/**
 * Compound tag helpers for adk-flair.
 *
 * Builds the `adk:<app_name>:<user_id>` compound tag used for per-user
 * scoping in Flair. Reserved characters in segments are percent-encoded so
 * distinct inputs never collide and the `:` delimiter stays unambiguous.
 */

const TAG_PREFIX = "adk";

/**
 * Percent-encode the reserved characters in a tag segment so distinct inputs
 * never collide and the compound-tag delimiter ':' stays unambiguous.
 *
 * The old scheme replaced ':' -> '_', which COLLIDED: userId="alice:admin"
 * and userId="alice_admin" both sanitized to "alice_admin" — one tag for two
 * distinct identities. Because the compound tag is the per-user access-control
 * boundary (ADK session distillation, #1205), that collision is a cross-user
 * contamination bug. Mirrors the Python fix in
 * packages/adk-flair/src/adk_flair/memory_service.py.
 *
 * This encoding is reversible and collision-free. '%' is escaped FIRST so it
 * can introduce escapes, then ':' (the delimiter) and '_' (the old escape
 * char). Because every escape starts with an already-escaped '%', no input can
 * forge another input's encoding — see desanitizeTagSegment for the inverse.
 */
export function sanitizeTagSegment(segment: string): string {
  return segment
    .replace(/%/g, "%25")
    .replace(/:/g, "%3A")
    .replace(/_/g, "%5F");
}

/**
 * Inverse of sanitizeTagSegment. '%25' is decoded LAST so a literal '%3A' in
 * the original input (which encoded to '%253A') is not mistaken for an encoded
 * ':'. Round-trips exactly: desanitizeTagSegment(sanitizeTagSegment(x)) === x.
 */
export function desanitizeTagSegment(segment: string): string {
  return segment
    .replace(/%3A/g, ":")
    .replace(/%5F/g, "_")
    .replace(/%25/g, "%");
}

/**
 * Build the compound tag `adk:<app_name>:<user_id>`.
 * Both segments are sanitized to prevent delimiter breakage.
 */
export function compoundTag(appName: string, userId: string): string {
  return `${TAG_PREFIX}:${sanitizeTagSegment(appName)}:${sanitizeTagSegment(userId)}`;
}
