/**
 * MemoryMaintenance.ts — Maintenance worker for memory hygiene.
 *
 * POST /MemoryMaintenance — runs cleanup tasks:
 *   1. Delete expired ephemeral memories (expiresAt < now)
 *   2. Archive old session memories (> 30 days, standard durability)
 *   3. Report stats
 *
 * Designed to run periodically (daily cron, scheduler, or REM nightly cycle).
 * Authenticated via Ed25519 (agent acts on own memories) or admin (system-wide).
 *
 * History: prior to slice-2 PR-3, this class used a static-ROUTE pattern
 * (`export default class MemoryMaintenance` with `static ROUTE`/`METHOD`)
 * that Harper 5.x does not auto-register. Both `flair rem light` and the
 * REM nightly runner were returning "Not found" against the endpoint.
 * Migrated to the standard `extends Resource` shape with `allowCreate()`
 * to gate auth correctly.
 */

import { Resource, databases } from "@harperfast/harper";
import { isAdmin } from "./agent-auth.js";
import { MCP_HIDDEN } from "./mcp-curation.js";

export class MemoryMaintenance extends Resource {
  // Suppress from the native MCP application profile (only FlairMcp is exposed). See mcp-curation.ts.
  static hidden = MCP_HIDDEN;
  /** POST requires auth — either an agent acting on its own memories, or admin. */
  allowCreate(): boolean {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    return !!(request?.tpsAgent || request?.tpsAgentIsAdmin);
  }

  async post(data: any) {
    const { dryRun = false, agentId: bodyAgentId } = data || {};

    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const actorId: string | undefined = request?.tpsAgent;
    const callerIsAdmin: boolean = request?.tpsAgentIsAdmin === true
      || (actorId ? await isAdmin(actorId) : false);

    // Scope rules:
    //   - Admin can pass agentId to maintain a specific agent (or omit it
    //     for fleet-wide maintenance).
    //   - Non-admin agents are scoped to their own memories — bodyAgentId
    //     either matches the authenticated agent or is ignored.
    const targetAgent: string | undefined = callerIsAdmin
      ? bodyAgentId
      : actorId;

    if (!targetAgent && !callerIsAdmin) {
      return new Response(JSON.stringify({ error: "agentId required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const now = new Date();
    const stats = { expired: 0, archived: 0, total: 0, errors: 0, agent: targetAgent || "all" };

    try {
      for await (const record of (databases as any).flair.Memory.search()) {
        // Skip records not belonging to target agent (unless admin running fleet-wide).
        if (targetAgent && record.agentId !== targetAgent) continue;
        stats.total++;

        // 1. Delete expired memories
        if (record.expiresAt && new Date(record.expiresAt) < now) {
          if (!dryRun) {
            try {
              await (databases as any).flair.Memory.delete(record.id);
              stats.expired++;
            } catch {
              stats.errors++;
            }
          } else {
            stats.expired++;
          }
          continue;
        }

        // 2. Archive old standard session memories (> 30 days). These are
        // low-value session notes that weren't promoted to persistent.
        // Soft-archive removes them from search results but keeps the data.
        if (
          record.durability === "standard" &&
          record.type === "session" &&
          !record.archived &&
          record.createdAt
        ) {
          const ageMs = now.getTime() - new Date(record.createdAt).getTime();
          const ageDays = ageMs / (24 * 3600_000);
          if (ageDays > 30) {
            if (!dryRun) {
              try {
                await (databases as any).flair.Memory.update(record.id, {
                  ...record,
                  archived: true,
                  archivedAt: now.toISOString(),
                });
                stats.archived++;
              } catch {
                stats.errors++;
              }
            } else {
              stats.archived++;
            }
          }
        }
      }
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message, stats }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    // Flatten the historical { stats } wrapper into the top level so callers
    // can read `.expired` / `.archived` directly. The wrapper shape is kept
    // for backward compatibility with `flair rem light`.
    return {
      message: dryRun ? "Dry run complete" : "Maintenance complete",
      stats,
      expired: stats.expired,
      archived: stats.archived,
      total: stats.total,
      errors: stats.errors,
    };
  }
}
