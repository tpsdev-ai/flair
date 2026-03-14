/**
 * OrgEventMaintenance.ts — Maintenance worker for expired OrgEvents.
 *
 * POST /OrgEventMaintenance/ — deletes all records where expiresAt < now.
 * Auth: admin only.
 */

import { Resource, tables } from "@harperfast/harper";

export class OrgEventMaintenance extends Resource {
  async post(_data: any, context?: any) {
    // Admin-only
    if (!context?.request?.tpsAgentIsAdmin) {
      return new Response(
        JSON.stringify({ error: "forbidden: admin only" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const now = new Date().toISOString();
    const toDelete: string[] = [];

    for await (const event of (tables as any).OrgEvent.search()) {
      if (event.expiresAt && event.expiresAt < now) {
        toDelete.push(event.id);
      }
    }

    for (const id of toDelete) {
      try {
        await (tables as any).OrgEvent.delete(id);
      } catch {}
    }

    return { deleted: toDelete.length };
  }
}
