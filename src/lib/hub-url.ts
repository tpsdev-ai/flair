/**
 * hub-url.ts — normalize a federation hub URL.
 *
 * New pairings store the normalized hub URL; sync normalizes previously stored
 * endpoints when sending. This strips trailing slashes only; it does not
 * otherwise validate the hub URL's path.
 */
export function normalizeHubUrl(hubUrl: string): string {
  // A non-string (a peer row without an endpoint or id) is passed through
  // unchanged, exactly as it was used before.
  return typeof hubUrl === "string" ? hubUrl.replace(/\/+$/, "") : hubUrl;
}
