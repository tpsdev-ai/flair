/**
 * WorkspaceLatest.ts — Custom resource returning the most recent WorkspaceState for an agent.
 *
 * GET /WorkspaceLatest/{agentId} — returns most recent WorkspaceState record.
 * Auth: requesting agent must match agentId in path (or be admin).
 */

import { Resource, databases } from "@harperfast/harper";

export class WorkspaceLatest extends Resource {
  async get(pathInfo?: any) {
    const request = (this as any).context?.request ?? (this as any).request;
    const callerAgent = request?.tpsAgent;
    const callerIsAdmin = request?.tpsAgentIsAdmin === true;

    // Extract agentId from path: /WorkspaceLatest/{agentId}
    const agentId =
      (typeof pathInfo === "string" ? pathInfo : null) ??
      (this as any).getId?.() ??
      null;

    if (!agentId) {
      return new Response(
        JSON.stringify({ error: "agentId required in path: GET /WorkspaceLatest/{agentId}" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Auth: requesting agent must match path agentId (or admin)
    if (callerAgent && !callerIsAdmin && callerAgent !== agentId) {
      return new Response(
        JSON.stringify({ error: "forbidden: cannot read workspace state for another agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    // Query WorkspaceState table for this agent, sorted by timestamp desc
    let latest: any = null;
    try {
      const results = (databases as any).flair.WorkspaceState.search({
        conditions: [{ attribute: "agentId", comparator: "equals", value: agentId }],
        sort: { attribute: "timestamp", descending: true },
        limit: 1,
      });

      for await (const row of results) {
        latest = row;
        break;
      }
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: "workspace_state_query_failed", detail: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!latest) {
      return new Response(
        JSON.stringify({ error: "no_workspace_state_found", agentId }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    return latest;
  }
}
