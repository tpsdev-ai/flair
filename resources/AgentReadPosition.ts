/**
 * AgentReadPosition.ts — HTTP surface for the per-agent read-position primitive.
 *
 * GET  /AgentReadPosition/{agentId}?stream=org-event
 * POST /AgentReadPosition/{agentId}  { stream, position }
 *
 * Owner-scoped: an agent reads/advances only its own watermark. Admins and
 * internal calls may act on any agent. The table itself is not @export.
 */

import { Resource } from "harper";
import { allowVerified, resolveAgentAuth } from "./agent-auth.js";
import { ORG_EVENT_STREAM } from "./agent-read-position-lib.js";
import {
  advanceReadPosition,
  defaultReadPositionTable,
  getReadPosition,
} from "./agent-read-position.js";

function pathAgentId(pathInfo: any, resource?: { getId?: () => string }): string | null {
  return (
    (typeof pathInfo === "object" && pathInfo !== null ? (pathInfo as any).id : null) ??
    (typeof pathInfo === "string" ? pathInfo : null) ??
    resource?.getId?.() ??
    null
  );
}

function queryValue(pathInfo: any, name: string): string | null {
  if (typeof pathInfo !== "object" || pathInfo === null) return null;
  return pathInfo.conditions?.find((c: any) => c.attribute === name)?.value ?? null;
}

function denyOwner(): Response {
  return new Response(
    JSON.stringify({ error: "forbidden: can only read or advance your own watermark" }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

function ownerDenied(auth: { kind: string; isAdmin?: boolean; agentId?: string }, agentId: string): boolean {
  if (auth.kind === "anonymous") return true;
  if (auth.kind === "agent" && !auth.isAdmin && auth.agentId !== agentId) return true;
  return false;
}

export class AgentReadPosition extends Resource {
  async allowRead(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async get(pathInfo?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    const agentId = pathAgentId(pathInfo, this as any);
    if (!agentId) {
      return new Response(
        JSON.stringify({ error: "agentId required in path: GET /AgentReadPosition/{agentId}" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (ownerDenied(auth, agentId)) return denyOwner();

    const stream = queryValue(pathInfo, "stream") || ORG_EVENT_STREAM;
    const ctx = (this as any).getContext?.();
    const position = await getReadPosition(defaultReadPositionTable(), agentId, stream, ctx);
    return { agentId, stream, position };
  }

  async post(content: any, pathInfo?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    const agentId =
      pathAgentId(pathInfo, this as any) ??
      (content && typeof content === "object" ? content.agentId : null) ??
      null;
    if (!agentId) {
      return new Response(
        JSON.stringify({ error: "agentId required in path: POST /AgentReadPosition/{agentId}" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (ownerDenied(auth, agentId)) return denyOwner();

    const stream = (content && typeof content === "object" && content.stream) || ORG_EVENT_STREAM;
    const position = content && typeof content === "object" ? String(content.position ?? "") : "";
    if (!position) {
      return new Response(
        JSON.stringify({ error: "position required to advance watermark" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const ctx = (this as any).getContext?.();
    const result = await advanceReadPosition(defaultReadPositionTable(), agentId, stream, position, ctx);
    return { agentId, stream, ...result };
  }
}
