import { databases } from "@harperfast/harper";
import { resolveAgentAuth } from "./agent-auth.js";

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });

/**
 * Integration records are agent-owned. Auth: the non-rejecting gate annotates the
 * request; this resource self-enforces (resolveAgentAuth → internal/agent/anonymous).
 * Anonymous HTTP is denied on every path; non-admin agents are scoped to their own
 * agentId. Mirrors the WorkspaceState pattern.
 */
export class Integration extends (databases as any).flair.Integration {
  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
  }

  async search(query?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.search(query);
    }
    const agentIdCondition = { attribute: "agentId", comparator: "equals", value: auth.agentId };
    if (query && typeof query === "object" && !Array.isArray(query)) {
      const existing = query.conditions ?? [];
      query.conditions = Array.isArray(existing) ? [agentIdCondition, ...existing] : [agentIdCondition, existing];
      return super.search(query);
    }
    const conditions = Array.isArray(query) && query.length > 0 ? [agentIdCondition, ...query] : [agentIdCondition];
    return super.search(conditions);
  }

  async post(content: any, context?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot write integration for another agent");
    }
    // S31-A: API never accepts plaintext credentials.
    if (typeof content?.credential === "string" || typeof content?.token === "string") {
      return new Response(JSON.stringify({ error: "plaintext_credentials_forbidden" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return super.post(content, context);
  }

  async put(content: any, context?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot write integration for another agent");
    }
    if (typeof content?.credential === "string" || typeof content?.token === "string") {
      return new Response(JSON.stringify({ error: "plaintext_credentials_forbidden" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return super.put(content, context);
  }

  async delete(id: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.delete(id);
    }
    const record = await this.get(id);
    if (!record) return super.delete(id);
    if (record.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot delete integration for another agent");
    }
    return super.delete(id);
  }
}
