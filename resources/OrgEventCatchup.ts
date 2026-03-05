/**
 * OrgEventCatchup.ts — Custom resource for filtered event retrieval.
 *
 * GET /OrgEventCatchup/{participantId}?since=<ISO timestamp>
 *
 * Returns events where:
 *   - targetIds includes participantId OR targetIds is empty/null
 *   - createdAt >= since
 * Sorted by createdAt ascending (oldest first for in-order processing).
 * Limit 50 events max.
 */

import { Resource, tables } from "harperdb";

export class OrgEventCatchup extends Resource {
  async get(query: any, context?: any) {
    const agentId = context?.request?.tpsAgent;
    const url = new URL(context?.request?.url ?? "", "http://localhost");
    const pathParts = url.pathname.split("/").filter(Boolean);

    // Extract participantId from URL path: /OrgEventCatchup/{participantId}
    const participantId = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
    if (!participantId) {
      return new Response(
        JSON.stringify({ error: "participantId required in path" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Auth: requesting agent must match participantId (or admin)
    if (agentId && !context?.request?.tpsAgentIsAdmin && agentId !== participantId) {
      return new Response(
        JSON.stringify({ error: "forbidden: can only fetch events for yourself" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const since = url.searchParams.get("since");
    if (!since) {
      return new Response(
        JSON.stringify({ error: "since query parameter required (ISO timestamp)" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      return new Response(
        JSON.stringify({ error: "invalid since timestamp" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Query all OrgEvents and filter in-memory
    // Harper search doesn't support complex compound filters, so we scan + filter
    const results: any[] = [];
    for await (const event of (tables as any).OrgEvent.search()) {
      // Filter by createdAt >= since
      if (!event.createdAt || event.createdAt < since) continue;

      // Filter by targetIds: includes participantId OR empty/null
      const targets = event.targetIds;
      const isTargeted = !targets || targets.length === 0 || targets.includes(participantId);
      if (!isTargeted) continue;

      // Skip expired events
      if (event.expiresAt && new Date(event.expiresAt) < new Date()) continue;

      results.push(event);
    }

    // Sort ascending by createdAt (oldest first)
    results.sort((a: any, b: any) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    // Limit to 50
    return results.slice(0, 50);
  }
}
