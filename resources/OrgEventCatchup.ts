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

import { Resource, databases } from "@harperfast/harper";

export class OrgEventCatchup extends Resource {
  // HarperDB calls get(pathInfo, context) where pathInfo is the URL segment after /OrgEventCatchup/
  async get(pathInfo?: any) {
    const request = (this as any).request;
    const callerAgent = request?.tpsAgent;
    const callerIsAdmin = request?.tpsAgentIsAdmin === true;

    // Harper routes /OrgEventCatchup/{id} with pathInfo.id as the path segment
    const participantId: string | null =
      (typeof pathInfo === "object" && pathInfo !== null ? (pathInfo as any).id : null) ??
      (typeof pathInfo === "string" ? pathInfo : null) ??
      (this as any).getId?.() ??
      null;

    if (!participantId) {
      return new Response(
        JSON.stringify({ error: "participantId required in path: GET /OrgEventCatchup/{participantId}" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Auth: requesting agent must match participantId (or admin)
    if (callerAgent && !callerIsAdmin && callerAgent !== participantId) {
      return new Response(
        JSON.stringify({ error: "forbidden: can only fetch events for yourself" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    // Harper parses query params into pathInfo.conditions array:
    // e.g. ?since=value → conditions: [{attribute:"since", value:"...", comparator:"equals"}]
    // pathInfo.id is the URL path segment (participantId).
    const since: string | null =
      (typeof pathInfo === "object" && pathInfo !== null
        ? (pathInfo as any).conditions?.find((c: any) => c.attribute === "since")?.value ?? null
        : null);
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
    const results: any[] = [];
    for await (const event of (databases as any).flair.OrgEvent.search()) {
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
