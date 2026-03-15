/**
 * WorkspaceState.ts — Harper table resource for workspace state records (OPS-47 Phase 2)
 *
 * Auth: Ed25519 middleware sets request.tpsAgent. Agent can only read/write own records.
 * Pattern follows Memory.ts — extends Harper auto-generated table class.
 */

import { tables } from "@harperfast/harper";
import { isAdmin } from "./auth-middleware.js";

export class WorkspaceState extends (tables as any).WorkspaceState {
  /**
   * Override search() to scope collection GETs to the authenticated agent's
   * own workspace state records. Admin agents see all records.
   */
  async search(query?: any, context?: any) {
    const authAgent: string | undefined = context?.request?.tpsAgent;
    const isAdminAgent: boolean = context?.request?.tpsAgentIsAdmin ?? false;

    if (!authAgent || isAdminAgent) {
      return super.search(query, context);
    }

    const agentIdCondition = { attribute: "agentId", comparator: "equals", value: authAgent };

    let scopedQuery: any;
    if (!query || (Array.isArray(query) && query.length === 0)) {
      scopedQuery = [agentIdCondition];
    } else {
      scopedQuery = { conditions: [agentIdCondition], and: query };
    }

    return super.search(scopedQuery, context);
  }

  async post(content: any, context?: any) {
    const agentId = context?.request?.tpsAgent;

    // Agent-scoped: agentId in body must match authenticated agent
    if (agentId && !context?.request?.tpsAgentIsAdmin && content.agentId !== agentId) {
      return new Response(
        JSON.stringify({ error: "forbidden: cannot write workspace state for another agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    content.createdAt = new Date().toISOString();
    content.timestamp ||= content.createdAt;

    return super.post(content, context);
  }

  async put(content: any, context?: any) {
    const agentId = context?.request?.tpsAgent;

    if (agentId && !context?.request?.tpsAgentIsAdmin && content.agentId !== agentId) {
      return new Response(
        JSON.stringify({ error: "forbidden: cannot write workspace state for another agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    return super.put(content, context);
  }

  async delete(id: any, context?: any) {
    const agentId = context?.request?.tpsAgent;
    if (!agentId) return super.delete(id, context);

    const record = await this.get(id);
    if (!record) return super.delete(id, context);

    if (!context?.request?.tpsAgentIsAdmin && record.agentId !== agentId) {
      return new Response(
        JSON.stringify({ error: "forbidden: cannot delete workspace state for another agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    return super.delete(id, context);
  }
}
