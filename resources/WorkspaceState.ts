/**
 * WorkspaceState.ts — Harper table resource for workspace state records (OPS-47 Phase 2)
 *
 * Auth: Ed25519 middleware sets request.tpsAgent. Agent can only read/write own records.
 * Pattern follows Memory.ts — extends Harper auto-generated table class.
 *
 * Note: Harper's static methods call instance methods with positional args only.
 * Use this.getContext() to access request context (tpsAgent, tpsAgentIsAdmin).
 */

import { databases } from "@harperfast/harper";
import { resolveAgentAuth } from "./agent-auth.js";

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });

export class WorkspaceState extends (databases as any).flair.WorkspaceState {
  /** Auth verdict from the request context. internal = trusted in-process call;
   *  agent = verified Ed25519; anonymous = HTTP with no valid agent → deny. */
  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
  }

  /**
   * Override search() to scope collection GETs to the authenticated agent's own
   * records. Internal calls + admin agents see all; anonymous is denied
   * (previously `!authAgent` was treated as unfiltered — the anonymous-read leak).
   */
  async search(query?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.search(query);
    }

    const agentIdCondition = { attribute: "agentId", comparator: "equals", value: auth.agentId };

    // Harper passes `query` as a request target object (pathname, id, isCollection…).
    // Inject the scope condition into its `.conditions` array.
    if (query && typeof query === "object" && !Array.isArray(query)) {
      const existing = query.conditions ?? [];
      query.conditions = Array.isArray(existing)
        ? [agentIdCondition, ...existing]
        : [agentIdCondition, existing];
      return super.search(query);
    }

    const conditions = Array.isArray(query) && query.length > 0
      ? [agentIdCondition, ...query]
      : [agentIdCondition];
    return super.search(conditions);
  }

  async post(content: any) {
    const auth = await this._auth();
    // Anonymous must NOT write (previously the agentId check was skipped when
    // there was no authenticated agent, so anonymous could write any record).
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot write workspace state for another agent");
    }

    content.createdAt = new Date().toISOString();
    content.timestamp ||= content.createdAt;

    return super.post(content);
  }

  async put(content: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot write workspace state for another agent");
    }

    return super.put(content);
  }

  async delete(id: any) {
    const auth = await this._auth();
    // Anonymous must NOT delete (previously `!agentId → super.delete` let anonymous
    // delete any record).
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.delete(id);
    }

    const record = await this.get(id);
    if (!record) return super.delete(id);
    if (record.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot delete workspace state for another agent");
    }
    return super.delete(id);
  }
}
