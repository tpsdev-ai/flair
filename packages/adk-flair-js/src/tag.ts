/**
 * Compound tag helpers for adk-flair.
 *
 * Builds the `adk:<app_name>:<user_id>` compound tag used for per-user
 * scoping in Flair. Colons in segments are replaced with underscores to
 * prevent delimiter breakage.
 */

const TAG_PREFIX = "adk";

/**
 * Sanitize a tag segment by replacing colons with underscores.
 * A colon in a segment would break the compound tag delimiter.
 */
export function sanitizeTagSegment(segment: string): string {
  return segment.replace(/:/g, "_");
}

/**
 * Build the compound tag `adk:<app_name>:<user_id>`.
 * Both segments are sanitized to prevent delimiter breakage.
 */
export function compoundTag(appName: string, userId: string): string {
  return `${TAG_PREFIX}:${sanitizeTagSegment(appName)}:${sanitizeTagSegment(userId)}`;
}
