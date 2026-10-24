/**
 * path-id-rewrite.ts — refuse a path agent id that Harper's path parsing
 * changed before the route received it (flair#2845).
 *
 * Harper decodes the path after a resource's name into the request's id, and
 * `Resource.parsePath` (harper `dist/resources/Resource.js`) can then change
 * that id: when the text after its first dot is `json`, `csv`, `cbor` or
 * `msgpack`, the dot and that text are removed as a content-type request, so
 * `agent.json` reaches the route as `agent`. A route calls
 * `refuseRewrittenAgentId` with the id it received and returns the 400 it
 * gives back, instead of answering for the changed id.
 *
 * Imports only the pure path helpers in request-target.js.
 */
import { routedResourceAndRemainder } from "./request-target.js";

/** The named error a rewritten path agent id is refused with. */
export const AGENT_ID_REWRITTEN_ERROR = "agent_id_rewritten";

export interface RewrittenPathId {
  /** The id the request's path names, percent-decoded. */
  requested: string;
  /** The id the route received. */
  received: string;
}

/**
 * Compare the id a route received with the id its request URL's path names:
 * the path after its first segment, percent-decoded the way Harper's
 * RequestTarget decodes it. `rawUrl` is a path (with any query) or an absolute
 * URL. Returns both ids when they differ. A remainder that is not valid
 * percent-encoding is returned undecoded as the requested id, and a URL that
 * does not parse is returned whole. Returns null when the ids are equal, when
 * `rawUrl` is not a non-empty string (no request path was parsed), or when the
 * path has nothing after its first segment (the received id did not come from
 * the path).
 */
export function rewrittenPathId(rawUrl: unknown, received: string): RewrittenPathId | null {
  if (typeof rawUrl !== "string" || rawUrl === "") return null;
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return { requested: rawUrl, received };
  }
  const { remainder } = routedResourceAndRemainder(pathname);
  if (remainder === "") return null;
  let requested: string;
  try {
    requested = decodeURIComponent(remainder);
  } catch {
    return { requested: remainder, received };
  }
  return requested === received ? null : { requested, received };
}

/** The named 400 for a rewritten path agent id, naming both ids. */
export function agentIdRewrittenRefusal(rewritten: RewrittenPathId): Response {
  return new Response(
    JSON.stringify({
      error: AGENT_ID_REWRITTEN_ERROR,
      message: `the request path names agent id ${JSON.stringify(rewritten.requested)}, but Harper's path parsing passed ${JSON.stringify(rewritten.received)} to this route, so the request is refused instead of answered for ${JSON.stringify(rewritten.received)}`,
      requestedAgentId: rewritten.requested,
      receivedAgentId: rewritten.received,
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * The 400 for a request whose path agent id Harper changed, or null. `context`
 * is the resource's `getContext()`; its request URL is the path compared.
 */
export function refuseRewrittenAgentId(context: any, received: unknown): Response | null {
  const request = context?.request ?? context;
  const rewritten = rewrittenPathId(request?.url, String(received));
  return rewritten ? agentIdRewrittenRefusal(rewritten) : null;
}
