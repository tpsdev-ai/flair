/**
 * OrgEventMaintenance.ts — Maintenance worker for expired OrgEvents.
 *
 * POST /OrgEventMaintenance/ — deletes all records where expiresAt < now.
 * Auth: admin only.
 */

import { Resource, databases } from "@harperfast/harper";
import { allowAdmin } from "./agent-auth.js";

export class OrgEventMaintenance extends Resource {
  // Admin-only: permit verified ADMIN agents (Basic-admin is super_user and
  // bypasses allow*); non-admin agents denied. Real authorization now that the
  // gate no longer elevates agents to admin.
  async allowCreate(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

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

    for await (const event of (databases as any).flair.OrgEvent.search()) {
      if (event.expiresAt && event.expiresAt < now) {
        toDelete.push(event.id);
      }
    }

    for (const id of toDelete) {
      try {
        await (databases as any).flair.OrgEvent.delete(id);
      } catch {}
    }

    return { deleted: toDelete.length };
  }
}
