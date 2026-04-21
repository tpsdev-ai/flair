import { Resource, databases } from "@harperfast/harper";
import { existsSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const db = databases as any;

/**
 * Health endpoint — unauthenticated, returns only { ok: true }.
 *
 * Rich stats (memory counts, agent names, etc.) are behind /HealthDetail
 * which requires authentication. This prevents information leakage on
 * publicly exposed instances.
 */
export class Health extends Resource {
  async get() {
    return { ok: true };
  }
}

/**
 * Authenticated health detail — returns memory/agent/soul stats + process info.
 * Requires Ed25519 agent auth or admin basic auth.
 *
 * Every optional-subsystem lookup is wrapped so a missing table or absent
 * schema downgrades to "not configured" rather than failing the whole call.
 */
export class HealthDetail extends Resource {
  async get() {
    const stats: Record<string, any> = { ok: true };
    const nowMs = Date.now();
    const warnings: Array<{ level: "warn" | "info"; message: string }> = [];

    let memoriesList: any[] = [];

    // ── Memory stats ──
    try {
      for await (const m of db.flair.Memory.search({})) {
        memoriesList.push(m);
      }
      const withEmbeddings = memoriesList.filter(
        (m: any) => m.embeddingModel && m.embeddingModel !== "hash-512d",
      ).length;
      const hashFallback = memoriesList.filter(
        (m: any) => !m.embeddingModel || m.embeddingModel === "hash-512d",
      ).length;
      const byDurability = { permanent: 0, persistent: 0, standard: 0, ephemeral: 0 } as Record<string, number>;
      let archived = 0;
      let expired = 0;
      for (const m of memoriesList) {
        const d = (m.durability ?? "standard") as string;
        if (d in byDurability) byDurability[d]++;
        if (m.archived) archived++;
        if (!m.archived && m.validTo && new Date(m.validTo).getTime() < nowMs) expired++;
      }
      stats.memories = {
        total: memoriesList.length,
        withEmbeddings,
        hashFallback,
        byDurability,
        archived,
        expired,
      };
      if (memoriesList.length > 0) {
        const sorted = memoriesList
          .filter((m: any) => m.createdAt)
          .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        if (sorted[0]) stats.lastWrite = sorted[0].createdAt;
      }
      if (expired > 0) warnings.push({ level: "warn", message: `${expired} memories have expired validTo but aren't archived` });
      if (withEmbeddings > 0 && hashFallback > withEmbeddings) {
        warnings.push({ level: "warn", message: "embeddings degraded — more hash-fallback writes than embedded" });
      }
    } catch { stats.memories = null; }

    // ── Agent stats ──
    try {
      const agents: any[] = [];
      for await (const a of db.flair.Agent.search({})) agents.push(a);
      const perAgentMap = new Map<string, { id: string; memoryCount: number; lastWriteAt: string | null }>();
      for (const a of agents) {
        if (a.id) perAgentMap.set(a.id, { id: a.id, memoryCount: 0, lastWriteAt: null });
      }
      for (const m of memoriesList) {
        if (!m.agentId) continue;
        const row = perAgentMap.get(m.agentId) ?? { id: m.agentId, memoryCount: 0, lastWriteAt: null };
        row.memoryCount++;
        if (m.createdAt) {
          if (!row.lastWriteAt || new Date(m.createdAt).getTime() > new Date(row.lastWriteAt).getTime()) {
            row.lastWriteAt = m.createdAt;
          }
        }
        perAgentMap.set(m.agentId, row);
      }
      const perAgent = Array.from(perAgentMap.values()).sort((a, b) => b.memoryCount - a.memoryCount);
      stats.agents = {
        count: agents.length,
        names: agents.map((a: any) => a.id).filter(Boolean),
        perAgent,
      };
    } catch { stats.agents = null; }

    // ── Relationships ──
    try {
      const rels: any[] = [];
      for await (const r of db.flair.Relationship.search({})) rels.push(r);
      if (rels.length === 0) {
        stats.relationships = null;
      } else {
        const active = rels.filter((r: any) => !r.validTo || new Date(r.validTo).getTime() > nowMs).length;
        stats.relationships = { total: rels.length, active };
      }
    } catch { stats.relationships = null; }

    // ── Soul ──
    try {
      const souls: any[] = [];
      for await (const s of db.flair.Soul.search({})) souls.push(s);
      stats.soulEntries = souls.length;
      const byPriority = { critical: 0, high: 0, standard: 0, low: 0 } as Record<string, number>;
      for (const s of souls) {
        const p = (s.priority ?? "standard") as string;
        if (p in byPriority) byPriority[p]++;
      }
      stats.soul = { total: souls.length, byPriority };
    } catch { stats.soulEntries = null; stats.soul = null; }

    // ── Federation ──
    try {
      const instances: any[] = [];
      try { for await (const i of db.flair.Instance.search({})) instances.push(i); } catch { /* absent */ }
      const peers: any[] = [];
      try { for await (const p of db.flair.Peer.search({})) peers.push(p); } catch { /* absent */ }
      const tokens: any[] = [];
      try { for await (const t of db.flair.PairingToken.search({})) tokens.push(t); } catch { /* absent */ }

      if (instances.length === 0 && peers.length === 0) {
        stats.federation = null;
      } else {
        const inst = instances[0];
        const peersBlock = {
          total: peers.length,
          connected: peers.filter((p: any) => p.status === "connected").length,
          disconnected: peers.filter((p: any) => p.status === "disconnected").length,
          revoked: peers.filter((p: any) => p.status === "revoked").length,
        };
        const pendingTokens = tokens.filter(
          (t: any) => !t.consumedBy && t.expiresAt && new Date(t.expiresAt).getTime() > nowMs,
        ).length;
        stats.federation = {
          instance: inst ? { id: inst.id, role: inst.role, status: inst.status } : null,
          peers: peersBlock,
          pendingTokens,
          peerList: peers.map((p: any) => ({
            id: p.id,
            role: p.role,
            status: p.status,
            lastSyncAt: p.lastSyncAt ?? null,
          })),
        };
        if (peers.length > 0 && peersBlock.connected === 0) {
          const oldest = peers
            .map((p: any) => (p.lastSyncAt ? new Date(p.lastSyncAt).getTime() : 0))
            .reduce((a: number, b: number) => (a === 0 ? b : b === 0 ? a : Math.min(a, b)), 0);
          if (oldest > 0 && nowMs - oldest > 24 * 3600 * 1000) {
            warnings.push({ level: "warn", message: "federation peers all disconnected >24h" });
          }
        }
        if (pendingTokens > 0) {
          warnings.push({ level: "info", message: `${pendingTokens} pairing token(s) unconsumed` });
        }
      }
    } catch { stats.federation = null; }

    // ── OAuth / IdP ──
    try {
      const clients: any[] = [];
      try { for await (const c of db.flair.OAuthClient.search({})) clients.push(c); } catch { /* absent */ }
      const idps: any[] = [];
      try { for await (const i of db.flair.IdpConfig.search({})) idps.push(i); } catch { /* absent */ }
      let activeTokens = 0;
      let tokensAvailable = true;
      try {
        const toks: any[] = [];
        for await (const t of db.flair.OAuthToken.search({})) toks.push(t);
        activeTokens = toks.filter((t: any) => {
          if (t.revokedAt) return false;
          if (t.expiresAt && new Date(t.expiresAt).getTime() < nowMs) return false;
          return true;
        }).length;
      } catch { tokensAvailable = false; }

      if (clients.length === 0 && idps.length === 0) {
        stats.oauth = null;
      } else {
        stats.oauth = {
          clients: clients.length,
          idpConfigs: idps.length,
          activeTokens: tokensAvailable ? activeTokens : 0,
          clientList: clients.map((c: any) => ({
            id: c.id,
            name: c.name,
            registeredBy: c.registeredBy ?? null,
            createdAt: c.createdAt ?? null,
          })),
          idpList: idps.map((i: any) => ({ id: i.id, name: i.name, issuer: i.issuer })),
        };
      }
    } catch { stats.oauth = null; }

    // ── REM ──
    try {
      const logsDir = join(homedir(), ".flair", "logs");
      const remLog = join(logsDir, "rem.jsonl");
      const nightlyLog = join(logsDir, "rem-nightly.jsonl");

      const tailJsonl = (path: string, maxBytes = 256 * 1024): any[] => {
        try {
          if (!existsSync(path)) return [];
          const size = statSync(path).size;
          const start = Math.max(0, size - maxBytes);
          const len = size - start;
          const fd = openSync(path, "r");
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, start);
          closeSync(fd);
          return buf
            .toString("utf-8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
        } catch { return []; }
      };

      const remRecords = tailJsonl(remLog);
      const findLast = (kind: string) => {
        for (let i = remRecords.length - 1; i >= 0; i--) {
          const r = remRecords[i];
          if (r && (r.kind === kind || r.type === kind)) return r.at ?? r.ts ?? r.timestamp ?? null;
        }
        return null;
      };
      const lastLightAt = findLast("light");
      const lastRapidAt = findLast("rapid");
      const lastRestorativeAt = findLast("restorative");

      let nightlyEnabled: boolean | null = null;
      const plat = platform();
      if (plat === "darwin") {
        const plist = join(homedir(), "Library", "LaunchAgents", "dev.flair.rem.nightly.plist");
        nightlyEnabled = existsSync(plist);
      } else if (plat === "linux") {
        const timer = join(homedir(), ".config", "systemd", "user", "flair-rem-nightly.timer");
        nightlyEnabled = existsSync(timer);
      }

      const nightlyRecords = tailJsonl(nightlyLog);
      const lastNightlyRec = nightlyRecords[nightlyRecords.length - 1];
      const lastNightlyAt = lastNightlyRec ? (lastNightlyRec.at ?? lastNightlyRec.ts ?? lastNightlyRec.timestamp ?? null) : null;

      let pendingCandidates: number | null = null;
      try {
        let count = 0;
        for await (const c of db.flair.MemoryCandidate.search({})) {
          if (c.status === "pending") count++;
        }
        pendingCandidates = count;
      } catch { pendingCandidates = null; }

      const allNull =
        !lastLightAt &&
        !lastRapidAt &&
        !lastRestorativeAt &&
        nightlyEnabled === null &&
        !lastNightlyAt &&
        pendingCandidates === null;
      if (allNull) {
        stats.rem = null;
      } else {
        stats.rem = {
          lastLightAt,
          lastRapidAt,
          lastRestorativeAt,
          nightlyEnabled,
          lastNightlyAt,
          pendingCandidates,
        };
        if (nightlyEnabled && lastNightlyAt && nowMs - new Date(lastNightlyAt).getTime() > 48 * 3600 * 1000) {
          warnings.push({ level: "warn", message: "nightly REM hasn't run in >48h" });
        }
      }
    } catch { stats.rem = null; }

    // ── Disk ──
    try {
      const dataDir = process.env.HDB_ROOT ?? join(homedir(), ".flair", "data");
      const snapshotDir = join(homedir(), ".flair", "snapshots");

      const dirSize = (root: string, maxDepth = 6): number | null => {
        if (!existsSync(root)) return null;
        let total = 0;
        const walk = (p: string, depth: number) => {
          if (depth > maxDepth) return;
          let entries: import("node:fs").Dirent[];
          try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            const full = join(p, e.name);
            try {
              if (e.isDirectory()) walk(full, depth + 1);
              else if (e.isFile()) total += statSync(full).size;
            } catch { /* skip */ }
          }
        };
        walk(root, 0);
        return total;
      };

      const dataBytes = dirSize(dataDir);
      const snapshotBytes = dirSize(snapshotDir);
      if (dataBytes === null && snapshotBytes === null) {
        stats.disk = null;
      } else {
        stats.disk = {
          dataDir,
          dataBytes: dataBytes ?? 0,
          snapshotDir,
          snapshotBytes: snapshotBytes ?? 0,
        };
      }
    } catch { stats.disk = null; }

    // ── Bridges ──
    try {
      const cwd = process.cwd();
      const candidates = [join(cwd, "node_modules"), join(homedir(), ".flair", "node_modules")];
      const installed = new Set<string>();
      for (const base of candidates) {
        if (!existsSync(base)) continue;
        try {
          for (const name of readdirSync(base)) {
            if (name.startsWith("flair-bridge-")) installed.add(name);
          }
        } catch { /* skip */ }
      }
      if (installed.size === 0) {
        stats.bridges = null;
      } else {
        stats.bridges = {
          installed: Array.from(installed).sort(),
          lastImport: null,
          lastExport: null,
        };
      }
    } catch { stats.bridges = null; }

    // ── Warnings ──
    stats.warnings = warnings;

    // ── Process info ──
    stats.pid = process.pid;
    stats.uptimeSeconds = Math.floor(process.uptime());

    return stats;
  }
}
