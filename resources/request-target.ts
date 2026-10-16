/**
 * request-target.ts — the raw request target the auth middleware decides on.
 *
 * Harper routes on the request target exactly as the client sent it: its
 * Request.url is the raw target, Request.pathname is everything before the
 * first `?`, and resource matching splits that raw path on `/`. A record id is
 * decoded only after the path has been split, so a percent-encoded `/` (`%2F`)
 * or `\` (`%5C`) inside a segment is part of that one segment — which is how an
 * id containing a reserved character addresses its record.
 *
 * The auth middleware (resources/auth-middleware.ts) reads the same raw path:
 * it splits on `/` FIRST and only then decodes a segment, so what it decides
 * about is exactly what Harper routes.
 *
 * And before any other request processing, it answers a target that is not in
 * canonical form with a named 400 (`non_canonical_request_target`). A raw
 * target is canonical unless its path (the part before the first `?`) has:
 *
 *   - a `.` or `..` segment, raw or percent-encoded as a whole segment
 *     (`%2e`, `%2E%2e`, `.%2e`, …);
 *   - an empty segment: `//` anywhere in the path;
 *   - a raw backslash.
 *
 * Everything else is canonical, including `%2F` and `%5C` inside a segment, a
 * dot inside a segment (`a.b`), and any query string.
 *
 * PURE: string logic only, imports nothing.
 */

/** The named error a non-canonical request target is refused with. */
export const NON_CANONICAL_REQUEST_TARGET_ERROR = "non_canonical_request_target";

/** A whole segment that is `.` or `..`, each dot raw or percent-encoded. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * The path part of a raw request target: everything before the first `?`,
 * exactly as Harper's own Request.pathname reads it.
 */
export function requestPath(rawTarget: string): string {
  const q = rawTarget.indexOf("?");
  return q === -1 ? rawTarget : rawTarget.slice(0, q);
}

/** True when a raw request target is in canonical form (see the module header). */
export function isCanonicalRequestTarget(rawTarget: string): boolean {
  const path = requestPath(rawTarget);
  if (path.includes("\\")) return false;
  if (path.includes("//")) return false;
  return !path.split("/").some((segment) => DOT_SEGMENT.test(segment));
}

/** The named 400 for a non-canonical request target. HEAD gets no body. */
export function nonCanonicalRequestTargetRefusal(method?: string): Response {
  const body = JSON.stringify({
    error: NON_CANONICAL_REQUEST_TARGET_ERROR,
    message: "the request target must be in canonical form: no '.' or '..' path segment, no empty path segment, and no backslash",
  });
  return new Response(method === "HEAD" ? null : body, {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The raw path's segments, split on `/` FIRST and still percent-encoded.
 * Empty segments are dropped (a canonical path has none but the leading one).
 */
export function rawPathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** The last raw segment of a path (still percent-encoded). */
export function lastRawPathSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Decode one raw path segment; null when it is not valid percent-encoding. */
export function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The resource name and still-encoded remainder Harper's routing hands a
 * RequestTarget: the first path segment, and everything after it with the one
 * leading slash removed. A collection path (`/<resource>` or `/<resource>/`)
 * has an empty or trailing-slash remainder. Mirrors `Resources.getMatch`'s
 * `relativeURL` for a one-level resource and `RequestTarget`'s leading-slash
 * removal.
 */
export function routedResourceAndRemainder(path: string): { resource: string; remainder: string } {
  const p = path.startsWith("/") ? path.slice(1) : path;
  const slash = p.indexOf("/");
  if (slash === -1) return { resource: p, remainder: "" };
  return { resource: p.slice(0, slash), remainder: p.slice(slash + 1) };
}

/**
 * The record id Harper routes a `/<resource>/<remainder>` path to: the FULL
 * decoded remainder, exactly as `RequestTarget` sets
 * `id = decodeURIComponent(path)` — NOT just the first sub-segment. So an id
 * that itself contains `/` (sent raw or as `%2F`) resolves to the whole id, the
 * same row Harper operates on.
 *
 * Null for a collection path (empty or trailing-slash remainder) and for a
 * remainder that is not valid percent-encoding (Harper answers that itself).
 */
export function routedRecordId(path: string): { resource: string; id: string } | null {
  const { resource, remainder } = routedResourceAndRemainder(path);
  if (remainder === "" || remainder.endsWith("/")) return null;
  let id: string;
  try {
    id = decodeURIComponent(remainder);
  } catch {
    return null;
  }
  if (id === "") return null;
  return { resource, id };
}

/**
 * Harper's first-dot property rule (`Resource.parsePath`): when the text after
 * the id's FIRST dot is a declared attribute of the resource, that suffix is a
 * property selector and the row is addressed by the id BEFORE the dot. Returns
 * the id Harper reads, given the resource's declared attribute names. A suffix
 * that is not a declared attribute is left as part of the id, exactly as Harper
 * leaves it.
 */
export function routedIdAfterPropertyRule(id: string, declaredAttributes: ReadonlySet<string>): string {
  const dot = id.indexOf(".");
  if (dot > -1 && declaredAttributes.has(id.slice(dot + 1))) return id.slice(0, dot);
  return id;
}

/**
 * The resource name Harper routes the path's FIRST segment to, honoring the
 * file-type-suffix fallback in `Resources.getMatch`: when the whole first
 * segment is not a known resource but its text before the first `.` is, the
 * request routes to that shorter name (e.g. `OAuthToken.json` → `OAuthToken`).
 * `isKnown` answers whether a name is one of the resources the calling decision
 * distinguishes; an unknown first segment is returned unchanged, so no
 * unrelated path is rewritten.
 */
export function routedFirstResourceName(path: string, isKnown: (name: string) => boolean): string {
  const seg = rawPathSegments(path)[0] ?? "";
  if (isKnown(seg)) return seg;
  const dot = seg.indexOf(".");
  if (dot > -1 && isKnown(seg.slice(0, dot))) return seg.slice(0, dot);
  return seg;
}

/**
 * `path` with its first segment replaced by the resource Harper routes it to
 * (see `routedFirstResourceName`), so a decision that compares the first
 * segment against `known` sees the routed resource for a suffix form. The rest
 * of the path is preserved. Unchanged when the first segment is already a known
 * resource or resolves to none.
 */
export function routedResourcePath(path: string, known: ReadonlySet<string>): string {
  const segs = rawPathSegments(path);
  const first = segs[0];
  if (first === undefined) return path;
  const name = routedFirstResourceName(path, (n) => known.has(n));
  if (name === first) return path;
  return `/${name}${path.slice(1 + first.length)}`;
}
