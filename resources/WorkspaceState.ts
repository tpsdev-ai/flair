/**
 * WorkspaceState.ts — Harper table resource for workspace state records (OPS-47 Phase 2)
 *
 * Auth: Ed25519 middleware sets request.tpsAgent. Agent can only read/write own records.
 * Pattern follows Memory.ts — extends Harper auto-generated table class.
 */

import { tables } from "harperdb";
import { isAdmin } from "./auth-middleware.js";

export class WorkspaceState extends (tables as any).WorkspaceState {
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
