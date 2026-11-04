/**
 * harper-routing.ts — read Harper's `rest` match and parse its remainder.
 *
 * `routeWithHarper` is SYNCHRONOUS and must be called before the middleware
 * awaits anything: `getMatch` mutates the matched entry's `relativeURL` in
 * place, so its result is read into locals immediately, with no interleaving
 * request able to overwrite it.
 *
 * `getMatch` is asked for the `rest` match. Harper's REST dispatcher asks for an
 * `sse` match for a request with `Accept: text/event-stream`, and the two matches
 * may differ; such a request is decided on the `rest` match, and on the helpers
 * only when no `rest` match is returned.
 *
 * When the registry or `RequestTarget` is not present (a unit test driving the
 * middleware with a mocked `harper`) or the target matches no route, it returns
 * null and the caller falls back to the helpers in request-target.ts. When the
 * matcher throws, the error propagates to the caller.
 */
// Namespace import, not named: a unit test that mocks `harper` may not export
// `RequestTarget`, and a named import of a missing export fails to LINK (before
// any code runs). The namespace binds whatever the module exports; a missing
// member is simply undefined, and routeWithHarper returns null in that case
// so the fallback is used.
import * as harper from "harper";

export interface HarperRoute {
  /** The matched entry's route key. */
  resource: string;
  /** The final record id, after content-type-suffix and property parsing. Null for
   *  a collection route (`isCollection`) and when `recordIdUnresolved`. */
  recordId: string | null;
  /** The property selector Harper parsed from a `.<declared attribute>` suffix, if any. */
  property: string | null;
  /** True when the target addresses a collection rather than one record. */
  isCollection: boolean;
  /** The routed path (`/<resource><remainder>`), for a by-name classification. */
  decisionPath: string;
  /** True when Harper's request-target parsing (`RequestTarget`) or path parsing
   *  (`parsePath`) threw on the routed remainder: `recordId` is then null without
   *  meaning a collection. */
  recordIdUnresolved: boolean;
}

/**
 * Resolve a raw request target through Harper's own matcher and parser, or null
 * when the live registry is unavailable. Throws when Harper's matcher throws.
 */
export function routeWithHarper(rawTarget: string, headers: unknown): HarperRoute | null {
  const server = (harper as any).server;
  const RequestTarget = (harper as any).RequestTarget;
  const resources = (server as { resources?: { getMatch?: Function } } | undefined)?.resources;
  if (!resources || typeof resources.getMatch !== "function") return null;
  if (typeof RequestTarget !== "function") return null;

  // REST dispatches on the target with its single leading slash removed.
  const routeInput = rawTarget.startsWith("/") ? rawTarget.slice(1) : rawTarget;
  const entry: any = resources.getMatch(routeInput, "rest");
  if (!entry || typeof entry.path !== "string") return null;

  // Read the mutable match result into locals NOW, before any await elsewhere.
  const resource: string = entry.path;
  const relativeURL: string = typeof entry.relativeURL === "string" ? entry.relativeURL : "";
  const ResourceClass: any = entry.Resource;

  // The path part of the routed remainder (drop any query).
  const relPath = relativeURL.includes("?") ? relativeURL.slice(0, relativeURL.indexOf("?")) : relativeURL;
  const decisionPath = `/${resource}${relPath}`;

  let target: any;
  try {
    target = new (RequestTarget as any)(relativeURL);
  } catch {
    return { resource, recordId: null, property: null, isCollection: false, decisionPath, recordIdUnresolved: true };
  }
  const isCollection = target.isCollection === true;
  // A collection route addresses no single record, so it carries no record id,
  // whatever id RequestTarget reports for the remainder (`x/` reports `x/`).
  if (isCollection) return { resource, recordId: null, property: null, isCollection, decisionPath, recordIdUnresolved: false };
  let recordId: string | null = typeof target.id === "string" ? target.id : (target.id == null ? null : String(target.id));
  let property: string | null = null;

  // Parse with the request headers in a throwaway context.
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
      // The id Harper addresses is unknown, so the remainder is not used as one.
      return { resource, recordId: null, property: null, isCollection: false, decisionPath, recordIdUnresolved: true };
    }
  }

  return { resource, recordId, property, isCollection, decisionPath, recordIdUnresolved: false };
}
