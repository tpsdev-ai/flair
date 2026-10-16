/**
 * hub-url.ts — the one form of a federation hub URL the CLI uses and stores.
 *
 * `flair federation pair <hub-url>` appends routes to the hub URL
 * (`<hub>/FederationPair`, and later `<hub>/FederationSync` from the stored
 * hub peer's `endpoint`). Trailing slashes are stripped once, before the URL is
 * used or stored, so every request built from it carries a canonical path with
 * no empty segment. A hub served under a path prefix keeps its prefix.
 */
export function normalizeHubUrl(hubUrl: string): string {
  // A non-string (a peer row without an endpoint or id) is passed through
  // unchanged, exactly as it was used before.
  return typeof hubUrl === "string" ? hubUrl.replace(/\/+$/, "") : hubUrl;
}
