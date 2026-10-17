/**
 * harper-routing.ts — ask Harper's OWN routing code what a request target
 * resolves to, so the middleware's by-name and by-id decisions use the resource,
 * record id and property the REST dispatcher will.
 *
 * The middleware runs inside Harper, so the live route registry
 * (`server.resources`) and Harper's `RequestTarget` / `Resource.parsePath` are
 * reachable at runtime. Re-implementing those rules in the middleware drifts
 * from the matcher (content-type suffixes, a suffixed resource name dispatching
 * to the bare resource, the first-dot property rule); calling them does not.
 *
 * `routeWithHarper` is SYNCHRONOUS and must be called before the middleware
 * awaits anything: `getMatch` mutates the matched entry's `relativeURL` in
 * place, so its result is read into locals immediately, with no interleaving
 * request able to overwrite it.
 *
 * `getMatch` is asked for the `rest` match, which is how Harper's REST layer
 * dispatches. A request Harper dispatches through another chain — e.g. an `sse`
 * match for `Accept: text/event-stream` — is not resolved here, and falls back to
 * the pure mirror.
 *
 * When the registry is not present (a unit test driving the middleware with a
 * mocked `harper`), the target matches no route, or the matcher throws, it returns
 * null and the caller falls back to the pure mirror in request-target.ts.
 */
// Namespace import, not named: a unit test that mocks `harper` may not export
// `RequestTarget`, and a named import of a missing export fails to LINK (before
// any code runs). The namespace binds whatever the module exports; a missing
// member is simply undefined, and routeWithHarper returns null in that case
// (the registry is absent too), so the pure fallback is used.
import * as harper from "harper";

export interface HarperRoute {
  /** The registered resource Harper dispatches to (its route key). */
  resource: string;
  /** The final record id, after content-type-suffix and property parsing; null for a collection. */
  recordId: string | null;
  /** The property selector Harper parsed from a `.<declared attribute>` suffix, if any. */
  property: string | null;
  /** True when the target addresses a collection rather than one record. */
  isCollection: boolean;
  /** The routed path (`/<resource><remainder>`), for a by-name classification. */
  decisionPath: string;
}

/**
 * Resolve a raw request target through Harper's own matcher and parser, or null
 * when the live registry is unavailable. `headers` enables Harper's
 * content-type-suffix rule (it only fires when a request context carries
 * headers), so the resolved id matches what Harper addresses.
 */
export function routeWithHarper(rawTarget: string, headers: unknown): HarperRoute | null {
  const server = (harper as any).server;
  const RequestTarget = (harper as any).RequestTarget;
  const resources = (server as { resources?: { getMatch?: Function } } | undefined)?.resources;
  if (!resources || typeof resources.getMatch !== "function") return null;

  // REST dispatches on the target with its single leading slash removed.
  const routeInput = rawTarget.startsWith("/") ? rawTarget.slice(1) : rawTarget;
  let entry: any;
  try {
    entry = resources.getMatch(routeInput, "rest");
  } catch {
    return null;
  }
  if (!entry || typeof entry.path !== "string") return null;

  // Read the mutable match result into locals NOW, before any await elsewhere.
  const resource: string = entry.path;
  const relativeURL: string = typeof entry.relativeURL === "string" ? entry.relativeURL : "";
  const ResourceClass: any = entry.Resource;

  // The path part of the routed remainder (drop any query).
  const relPath = relativeURL.includes("?") ? relativeURL.slice(0, relativeURL.indexOf("?")) : relativeURL;
  const decisionPath = `/${resource}${relPath}`;

  // RequestTarget resolves the id (decodeURIComponent of the whole remainder)
  // and flags a collection, exactly as Harper does for dispatch.
  if (typeof RequestTarget !== "function") return { resource, recordId: null, property: null, isCollection: false, decisionPath };
  let target: any;
  try {
    target = new (RequestTarget as any)(relativeURL);
  } catch {
    return { resource, recordId: null, property: null, isCollection: false, decisionPath };
  }
  const isCollection = target.isCollection === true;
  let recordId: string | null = typeof target.id === "string" ? target.id : (target.id == null ? null : String(target.id));
  let property: string | null = null;

  // Apply the SAME first-dot property / content-type-suffix rule Harper applies
  // (Resource.parsePath), using the request's headers so a content-type suffix
  // is recognised. A throwaway context keeps the real request unmutated.
  if (recordId !== null && typeof ResourceClass?.parsePath === "function") {
    try {
      const parsed = ResourceClass.parsePath(recordId, { headers }, undefined);
      if (parsed && typeof parsed === "object") {
        recordId = typeof parsed.id === "string" ? parsed.id : recordId;
        property = typeof parsed.property === "string" ? parsed.property : null;
      } else if (typeof parsed === "string") {
        // A content-type suffix is stripped in place and returns the bare id
        // string (no property); a plain id returns unchanged.
        recordId = parsed;
      }
    } catch {
      /* leave recordId as the decoded remainder */
    }
  }

  return { resource, recordId, property, isCollection, decisionPath };
}
