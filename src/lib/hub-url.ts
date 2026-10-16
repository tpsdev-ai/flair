/**
 * hub-url.ts — the one form of a federation hub URL the CLI uses and stores.
 *
 * `flair federation pair <hub-url>` appends routes to the hub URL
 * (`<hub>/FederationPair`, and later `<hub>/FederationSync` from the stored
 * hub peer's `endpoint`). Trailing slashes are stripped once, before the URL is
 * used or stored, so a hub URL typed or stored with a trailing slash does not
 * produce an empty path segment in the appended route. This normalises the
 * trailing slash only; it does not otherwise validate the hub URL's path.
 */
export function normalizeHubUrl(hubUrl: string): string {
  // A non-string (a peer row without an endpoint or id) is passed through
  // unchanged, exactly as it was used before.
  return typeof hubUrl === "string" ? hubUrl.replace(/\/+$/, "") : hubUrl;
}
