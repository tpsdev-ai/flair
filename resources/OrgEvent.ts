/**
 * OrgEvent.ts — Harper table resource for org-wide activity events.
 *
 * Auth: Ed25519 middleware sets request.tpsAgent.
 * Write: authorId must match authenticated agent (or admin).
 * Read: any authenticated participant can read (org-scoped).
 */

import { tables } from "harperdb";

export class OrgEvent extends (tables as any).OrgEvent {
  async post(content: any, context?: any) {
    const agentId = context?.request?.tpsAgent;

    // authorId must match authenticated agent (unless admin)
    if (agentId && !context?.request?.tpsAgentIsAdmin && content.authorId !== agentId) {
      return new Response(
        JSON.stringify({ error: "forbidden: authorId must match authenticated agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    // Generate composite ID if not provided
    if (!content.id) {
      content.id = `${content.authorId}-${Date.now()}`;
    }

    content.createdAt = new Date().toISOString();

    // Harper 5: table resources use put() for create/upsert (post() removed)
    return (tables as any).OrgEvent.put(content);
  }

  async put(content: any, context?: any) {
    const agentId = context?.request?.tpsAgent;

    if (agentId && !context?.request?.tpsAgentIsAdmin && content.authorId !== agentId) {
      return new Response(
        JSON.stringify({ error: "forbidden: authorId must match authenticated agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    return (tables as any).OrgEvent.put(content);
  }

  async delete(id: any, context?: any) {
    const agentId = context?.request?.tpsAgent;
    if (!agentId) return super.delete(id, context);

    const record = await this.get(id);
    if (!record) return super.delete(id, context);

    if (!context?.request?.tpsAgentIsAdmin && record.authorId !== agentId) {
      return new Response(
        JSON.stringify({ error: "forbidden: cannot delete events authored by another agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    return super.delete(id, context);
  }
}
