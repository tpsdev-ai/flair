/**
 * MemoryMaintenance.ts — Maintenance worker for memory hygiene.
 *
 * POST /MemoryMaintenance/ — runs cleanup tasks:
 *   1. Delete expired ephemeral memories (expiresAt < now)
 *   2. Archive old session memories (> 30 days, standard durability)
 *   3. Report stats
 *
 * Designed to run periodically (daily cron or heartbeat).
 * Requires admin auth.
 */

export default class MemoryMaintenance {
  static ROUTE = "MemoryMaintenance";
  static METHOD = "POST";

  async post(data: any) {
    const { databases }: any = this;
    const request = (this as any).request;
    const { dryRun = false, agentId } = data || {};

    // Scope to authenticated agent. Admin can pass agentId for system-wide
    // maintenance; non-admin always scoped to their own agent.
    const authAgent = request?.headers?.get?.("x-tps-agent");
    const isAdmin = (request as any)?.tpsAgentIsAdmin === true;
    const targetAgent = isAdmin && agentId ? agentId : authAgent;

    if (!targetAgent && !isAdmin) {
      return { error: "agentId required" };
    }

    const now = new Date();
    const stats = { expired: 0, archived: 0, total: 0, errors: 0, agent: targetAgent || "all" };

    try {
      for await (const record of (databases as any).flair.Memory.search()) {
        // Skip records not belonging to target agent (unless admin running system-wide)
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

        // 2. Archive old standard session memories (> 30 days)
        // These are low-value session notes that weren't promoted to persistent.
        // Archiving removes them from search results but keeps the data.
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
                // Soft archive — set archived flag, keep data
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
      return { error: err.message, stats };
    }

    return {
      message: dryRun ? "Dry run complete" : "Maintenance complete",
      stats,
    };
  }
}
