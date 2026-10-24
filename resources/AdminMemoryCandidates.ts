/**
 * AdminMemoryCandidates.ts — an operator listing of one agent's MemoryCandidate
 * rows, served on the HTTP endpoint restore writes to.
 *
 * GET /AdminMemoryCandidates/{agentId}?limit=N[&after=<id>]
 *
 * Returns `{ candidates: [{ id }], hasMore }`: each candidate object carries
 * only its id, which restore uses to delete the row through the same endpoint.
 * Rows come in id order; with `after`, only rows whose id sorts after it.
 * `limit` defaults to 200 and is capped at 500. A 200 reply with `hasMore`
 * false lists every remaining row; `hasMore` true means more rows follow the
 * last one it carries, which the next page reads with `after` set to that id.
 * An empty or repeated `after` is refused (400, `invalid_after`). A row it
 * reads whose id is not a non-empty string fails the request (500,
 * `candidate_id_unusable`) instead of being left out.
 *
 * Admin-only: allowRead() is allowAdmin(), so a request with no Authorization
 * header is refused by the `/Admin*` path gate (401) and a verified non-admin
 * agent is refused with Harper's AccessViolation (403). The handler is read-only.
 */
import { Resource, databases } from "harper";
import { allowAdmin } from "./agent-auth.js";

export const ADMIN_MEMORY_CANDIDATES_DEFAULT_LIMIT = 200;
export const ADMIN_MEMORY_CANDIDATES_MAX_LIMIT = 500;

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function badRequest(error: string): Response {
  return new Response(JSON.stringify({ error }), { status: 400, headers: JSON_HEADERS });
}

function invalidAfter(): Response {
  return new Response(
    JSON.stringify({ error: "invalid_after", message: "after must be given at most once, as a non-empty candidate id" }),
    { status: 400, headers: JSON_HEADERS },
  );
}

/** A listing that would leave out a row without a usable id fails instead. */
function candidateIdUnusable(): Response {
  return new Response(
    JSON.stringify({ error: "candidate_id_unusable", message: "a MemoryCandidate row for this agent has no usable id, so the listing would be incomplete" }),
    { status: 500, headers: JSON_HEADERS },
  );
}

function requestUrl(self: any): URL | null {
  const ctx = self.getContext?.();
  const request = ctx?.request ?? ctx;
  if (!request?.url) return null;
  try {
    return new URL(request.url, "http://localhost");
  } catch {
    return null;
  }
}

function pathAgentId(pathInfo: any, resource: { getId?: () => string }): string | null {
  const fromPath =
    typeof pathInfo === "object" && pathInfo !== null
      ? (pathInfo as any).id
      : typeof pathInfo === "string"
        ? pathInfo
        : null;
  const id = fromPath ?? resource.getId?.() ?? null;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export class AdminMemoryCandidates extends Resource {
  async allowRead(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async get(pathInfo?: any) {
    const agentId = pathAgentId(pathInfo, this as any);
    if (!agentId) {
      return badRequest("agentId required in path: GET /AdminMemoryCandidates/{agentId}");
    }

    const params = requestUrl(this)?.searchParams;
    const rawLimit = params?.get("limit") ?? null;
    const parsedLimit = rawLimit === null ? ADMIN_MEMORY_CANDIDATES_DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      return badRequest(`limit must be a positive integer; a value above ${ADMIN_MEMORY_CANDIDATES_MAX_LIMIT} is capped at ${ADMIN_MEMORY_CANDIDATES_MAX_LIMIT}`);
    }
    const limit = Math.min(parsedLimit, ADMIN_MEMORY_CANDIDATES_MAX_LIMIT);
    const afterValues = params?.getAll("after") ?? [];
    if (afterValues.length > 1 || afterValues[0] === "") return invalidAfter();
    const after = afterValues[0];

    const conditions: any[] = [{ attribute: "agentId", comparator: "equals", value: agentId }];
    if (after !== undefined) conditions.push({ attribute: "id", comparator: "greater_than", value: after });

    const candidates: Array<{ id: string }> = [];
    let hasMore = false;
    try {
      for await (const row of (databases as any).flair.MemoryCandidate.search({
        conditions,
        sort: { attribute: "id" },
        limit: limit + 1,
      })) {
        if (typeof row?.id !== "string" || row.id.length === 0) return candidateIdUnusable();
        if (candidates.length === limit) {
          hasMore = true;
          break;
        }
        candidates.push({ id: row.id });
      }
    } catch (err: any) {
      console.error("AdminMemoryCandidates: MemoryCandidate query failed", err);
      return new Response(
        JSON.stringify({ error: "memory_candidate_query_failed", message: "the MemoryCandidate query failed" }),
        { status: 500, headers: JSON_HEADERS },
      );
    }

    return new Response(JSON.stringify({ candidates, hasMore }), { status: 200, headers: JSON_HEADERS });
  }
}
