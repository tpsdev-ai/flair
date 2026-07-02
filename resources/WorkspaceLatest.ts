/**
 * WorkspaceLatest.ts — Custom resource returning the most recent WorkspaceState for an agent.
 *
 * GET /WorkspaceLatest/{agentId} — returns most recent WorkspaceState record.
 * Auth: requesting agent must match agentId in path (or be admin).
 */

import { Resource, databases } from "@harperfast/harper";
import { allowVerified, resolveAgentAuth } from "./agent-auth.js";

export class WorkspaceLatest extends Resource {
  // Self-authorize via the Ed25519 agent verify (auth reshape removes the gate's
  // admin elevation). Any verified agent may read; the path-vs-agent ownership
  // check stays in get().
  async allowRead(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async get(pathInfo?: any) {
    // Harper v5 does not populate this.context / this.request on Resource
    // subclasses — getContext() is the only reliable path to the gate's
    // tpsAgent/tpsAgentIsAdmin annotations (ops-sal4: the previous
    // `(this as any).context?.request ?? (this as any).request` read was always
    // undefined, so the ownership check below never ran — fail-open cross-agent
    // read).
    const auth = await resolveAgentAuth((this as any).getContext?.());

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

    // Auth: internal calls and admins pass unfiltered; a verified agent may only
    // read its own workspace state; anonymous is denied. allowRead() already
    // blocks anonymous HTTP, but this handler must fail closed on its own too.
    if (auth.kind === "anonymous") {
      return new Response(
        JSON.stringify({ error: "forbidden: cannot read workspace state for another agent" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    if (auth.kind === "agent" && !auth.isAdmin && auth.agentId !== agentId) {
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
