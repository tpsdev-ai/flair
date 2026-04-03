import { Resource, databases } from "@harperfast/harper";

const db = databases as any;

export class Health extends Resource {
  async get() {
    const stats: Record<string, any> = { ok: true };

    // ── Memory stats ──
    try {
      const list: any[] = [];
      for await (const m of db.flair.Memory.search({})) {
        list.push(m);
      }
      stats.memories = {
        total: list.length,
        withEmbeddings: list.filter((m: any) => m.embeddingModel && m.embeddingModel !== "hash-512d").length,
        hashFallback: list.filter((m: any) => !m.embeddingModel || m.embeddingModel === "hash-512d").length,
      };
      if (list.length > 0) {
        const sorted = list.filter((m: any) => m.createdAt).sort((a: any, b: any) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        if (sorted[0]) stats.lastWrite = sorted[0].createdAt;
      }
    } catch { stats.memories = null; }

    // ── Agent stats ──
    try {
      const agents: any[] = [];
      for await (const a of db.flair.Agent.search({})) {
        agents.push(a);
      }
      stats.agents = {
        count: agents.length,
        names: agents.map((a: any) => a.id).filter(Boolean),
      };
    } catch { stats.agents = null; }

    // ── Soul stats ──
    try {
      let count = 0;
      for await (const _ of db.flair.Soul.search({})) {
        count++;
      }
      stats.soulEntries = count;
    } catch { stats.soulEntries = null; }

    // ── Process info ──
    stats.pid = process.pid;
    stats.uptimeSeconds = Math.floor(process.uptime());

    return stats;
  }
}
