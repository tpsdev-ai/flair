/**
 * The Basic `Authorization` header check the auth middleware uses
 * (flair#2764), in one place so the CLI's copy in src/lib/auth-resolve.ts can
 * be tested against it. It is a prefix test only: `Basic` in any case (scheme
 * names are case-insensitive, RFC 9110) followed by a space. Nothing after
 * that space is validated: parseBasicAuthHeader decodes all of it with
 * `Buffer.from(..., "base64")`, which does not reject characters outside the
 * base64 alphabet, so further spaces or any other text pass the check.
 */
export const BASIC_AUTH_HEADER_RE = /^Basic /i;

/** The user and password a Basic header carries, or null for any other header. */
export function parseBasicAuthHeader(header: string): { user: string; pass: string } | null {
  if (!BASIC_AUTH_HEADER_RE.test(header)) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  const colonIdx = decoded.indexOf(":");
  return {
    user: colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded,
    pass: colonIdx >= 0 ? decoded.slice(colonIdx + 1) : "",
  };
}
