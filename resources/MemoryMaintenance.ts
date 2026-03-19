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
    const { dryRun = false } = data || {};

    const now = new Date();
    const stats = { expired: 0, archived: 0, total: 0, errors: 0 };

    try {
      for await (const record of (databases as any).flair.Memory.search()) {
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
