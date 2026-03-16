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
import { isAdmin } from "./auth-middleware.js";

export class WorkspaceState extends (databases as any).flair.WorkspaceState {
  /**
   * Helper to extract auth info from Harper's Resource instance context.
   */
  private _authInfo() {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    return {
      agentId: request?.tpsAgent as string | undefined,
      isAdmin: request?.tpsAgentIsAdmin as boolean ?? false,
    };
  }

  /**
   * Override search() to scope collection GETs to the authenticated agent's
   * own workspace state records. Admin agents see all records.
   */
  async search(query?: any) {
    const { agentId: authAgent, isAdmin: isAdminAgent } = this._authInfo();

    if (!authAgent || isAdminAgent) {
      return super.search(query);
    }

    const agentIdCondition = { attribute: "agentId", comparator: "equals", value: authAgent };

    let scopedQuery: any;
    if (!query || (Array.isArray(query) && query.length === 0)) {
      scopedQuery = [agentIdCondition];
    } else {
      scopedQuery = { conditions: [agentIdCondition], and: query };
    }

    return super.search(scopedQuery);
  }

  async post(content: any) {
    const { agentId, isAdmin: isAdminAgent } = this._authInfo();

    // Agent-scoped: agentId in body must match authenticated agent
    if (agentId && !isAdminAgent && content.agentId !== agentId) {
      return new Response(
        JSON.stringify({ error: "forbidden: cannot write workspace state for another agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    content.createdAt = new Date().toISOString();
    content.timestamp ||= content.createdAt;

    return super.post(content);
  }

  async put(content: any) {
    const { agentId, isAdmin: isAdminAgent } = this._authInfo();

    if (agentId && !isAdminAgent && content.agentId !== agentId) {
      return new Response(
        JSON.stringify({ error: "forbidden: cannot write workspace state for another agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    return super.put(content);
  }

  async delete(id: any) {
    const { agentId, isAdmin: isAdminAgent } = this._authInfo();
    if (!agentId) return super.delete(id);

    const record = await this.get(id);
    if (!record) return super.delete(id);

    if (!isAdminAgent && record.agentId !== agentId) {
      return new Response(
        JSON.stringify({ error: "forbidden: cannot delete workspace state for another agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    return super.delete(id);
  }
}
