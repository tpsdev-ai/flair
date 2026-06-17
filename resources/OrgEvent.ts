/**
 * OrgEvent.ts — Harper table resource for org-wide activity events.
 *
 * Auth (self-enforced now that the global gate is non-rejecting):
 *   Read  — any verified agent/admin (org-scoped); anonymous denied.
 *   Write — authorId must match the authenticated agent (or admin); anonymous denied.
 *
 * The previous version read context.request.tpsAgent and treated a MISSING agent
 * as trusted (`if (agentId && …)` / `if (!agentId) super.delete`), so anonymous
 * requests slipped through once the gate stopped rejecting. resolveAgentAuth
 * distinguishes internal/agent/anonymous explicitly.
 */

import { databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });

export class OrgEvent extends (databases as any).flair.OrgEvent {
  allowRead() { return allowVerified((this as any).getContext?.()); }

  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
  }

  async post(content: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content.authorId !== auth.agentId) {
      return FORBIDDEN("forbidden: authorId must match authenticated agent");
    }
    if (!content.id) content.id = `${content.authorId}-${new Date().toISOString()}`;
    content.createdAt = new Date().toISOString();
    // Harper 5: table resources use put() for create/upsert (post() removed).
    return (databases as any).flair.OrgEvent.put(content);
  }

  async put(content: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content.authorId !== auth.agentId) {
      return FORBIDDEN("forbidden: authorId must match authenticated agent");
    }
    return (databases as any).flair.OrgEvent.put(content);
  }

  async delete(id: any, context?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.delete(id, context);
    }
    const record = await this.get(id);
    if (!record) return super.delete(id, context);
    if (record.authorId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot delete events authored by another agent");
    }
    return super.delete(id, context);
  }
}
