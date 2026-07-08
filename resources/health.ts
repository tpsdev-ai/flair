import { Resource, databases } from "@harperfast/harper";
import { promises as fsp, existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getRerankStatus } from "./rerank-provider.js";
import { allowVerified, resolveAgentAuth } from "./agent-auth.js";

const db = databases as any;

const redactHome = (p: string): string => {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
};

const exists = async (path: string): Promise<boolean> => {
  try { await fsp.stat(path); return true; } catch { return false; }
};

/**
 * Resolve the runtime package version from package.json (duplicated from
 * admin-layout.ts / AdminInstance.ts — same "keep in sync" idiom as the
 * federation-crypto helpers in src/cli.ts; see those two files' comments for
 * why it's inlined rather than imported). `process.env.npm_package_version`
 * is only populated inside `npm run`, so reading package.json relative to
 * THIS running module is the only way to report the version of the code
 * that's actually executing — which is exactly what `flair upgrade`'s
 * post-restart verification (flair#635) needs: proof the NEW package is
 * what's serving, not just what landed on disk before a restart.
 */
function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg.version) return pkg.version;
      }
    }
  } catch { /* fall through */ }
  return process.env.npm_package_version ?? "dev";
}

/**
 * Health endpoint — truly public, returns only { ok: true }.
 *
 * `allowRead() { return true }` opens Harper's role gate for anonymous GETs,
 * which is what makes /Health work for callers outside `authorizeLocal`'s
 * localhost-bypass. Without this, Harper's intrinsic Basic-auth gate fires
 * BEFORE our HTTP middleware can apply the /Health bypass list in
 * auth-middleware.ts, so remote callers (e.g., from a remote host hitting a Fabric-
 * hosted Flair) get a 401 even though the Resource handler is intentionally
 * unauthenticated. Symptom matched: Fabric returned 401 + WWW-Authenticate:
 * Basic on /Health while a localhost caller returned 200 — the difference was
 * Harper's localhost-auto-auth, not anything in our code.
 *
 * Same pattern as `FederationPair.allowCreate(){ return true }` (PR #299):
 * declare the Resource anonymously-accessible at the Harper layer; let the
 * handler itself enforce whatever it needs (in this case, nothing — /Health
 * is intentionally and always public).
 *
 * Rich stats (memory counts, agent names, etc.) are behind /HealthDetail
 * which requires authentication. This prevents information leakage on
 * publicly exposed instances.
 */
export class Health extends Resource {
  // Anyone can call /Health — no auth, no role check. Truly public.
  allowRead(_user: any) {
    return true;
  }
  async get() {
    return { ok: true };
  }
}

/**
 * Authenticated health detail — returns memory/agent/soul stats + process info.
 * Requires Ed25519 agent auth or admin basic auth.
 *
 * allowRead()=allowVerified (authorizeLocal-escalation-class follow-up to
 * #601/#604/#609/#612 — flair#614's backstop found this resource had NO
 * allow* at all, despite this docstring's stated intent). Harper's own
 * default (`user?.role.permission.super_user`, satisfiable only by a genuine
 * admin OR authorizeLocal's forged loopback super_user) was silently
 * standing in instead. Any verified agent may read — get() below still
 * filters sensitive fields (peer/OAuth-client lists, absolute paths, full
 * agent roster) down to admin-only.
 *
 * Every optional-subsystem lookup is wrapped so a missing table or absent
 * schema downgrades to "not configured" rather than failing the whole call.
 */
export class HealthDetail extends Resource {
  async allowRead(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async get() {
    const stats: Record<string, any> = { ok: true };
    const nowMs = Date.now();
    const warnings: Array<{ level: "warn" | "info"; message: string }> = [];

    const ctx = (this as any).getContext?.();
    // #614 fix: resolve identity via the shared three-way verdict
    // (internal/agent/anonymous — agent-auth.ts) instead of reading
    // tpsAgent/tpsAgentIsAdmin off the raw request directly. The OLD
    // computation was `request?.tpsAgentIsAdmin === true || !callerAgent` —
    // the `|| !callerAgent` half meant an UNRESOLVED caller (no tpsAgent at
    // all — i.e. anonymous) defaulted to isAdmin=TRUE, backwards from every
    // other resource in this codebase and the opposite of fail-safe.
    // allowRead() above already denies a genuine anonymous HTTP caller
    // before get() ever runs; this fixes the internal computation to match
    // (defense-in-depth, and correct semantics if get() is ever reached
    // another way). Only a true "internal" verdict (no HTTP request at all —
    // a programmatic/in-process call) or a verified admin agent is isAdmin;
    // an unresolved/anonymous HTTP caller is never treated as admin.
    const auth = await resolveAgentAuth(ctx);
    const callerAgent: string | undefined = auth.kind === "agent" ? auth.agentId : undefined;
    const isAdmin: boolean = auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin);
    stats.caller = { agentId: callerAgent ?? null, isAdmin };

    let memoriesList: any[] = [];

    // ── Memory stats ──
    try {
      for await (const m of db.flair.Memory.search({})) {
        memoriesList.push(m);
      }
      // Per-model counts: "hash-512d" is the hash-fallback marker; any other
      // value (or missing value) is a real embedding. Multiple distinct
      // non-hash models means mixed vector spaces — cross-space searches
      // return garbage unless reconciled via `flair reembed`.
      const modelCounts: Record<string, number> = {};
      for (const m of memoriesList) {
        const model = m.embeddingModel || "hash-512d";
        modelCounts[model] = (modelCounts[model] ?? 0) + 1;
      }
      const hashFallback = modelCounts["hash-512d"] ?? 0;
      const withEmbeddings = memoriesList.length - hashFallback;
      const realModels = Object.keys(modelCounts).filter((k) => k !== "hash-512d");
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
        modelCounts,
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
      // Hash-fallback coverage — tiered by percentage. Thresholds are
      // first-pass defaults; Kern's review on ops-n4n may tune them.
      if (memoriesList.length > 0) {
        const pct = Math.round((hashFallback / memoriesList.length) * 100);
        if (pct >= 10) {
          warnings.push({
            level: "warn",
            message: `${hashFallback}/${memoriesList.length} (${pct}%) memories are hash-fallback — run: flair reembed --stale-only --dry-run`,
          });
        }
      }
      // Mixed embedding models — searches across vector spaces return garbage.
      if (realModels.length > 1) {
        const list = realModels.map((k) => `${k}:${modelCounts[k]}`).join(", ");
        warnings.push({
          level: "warn",
          message: `multiple embedding models in use (${list}) — cross-model search unreliable; run: flair reembed against one model`,
        });
      }
    } catch { stats.memories = null; }

    // ── Agent stats ──
    try {
      const agents: any[] = [];
      for await (const a of db.flair.Agent.search({})) agents.push(a);
      type AgentRow = {
        id: string;
        memoryCount: number;
        hashFallback: number;
        writes24h: number;
        lastWriteAt: string | null;
      };
      const blank = (id: string): AgentRow => ({
        id, memoryCount: 0, hashFallback: 0, writes24h: 0, lastWriteAt: null,
      });
      const perAgentMap = new Map<string, AgentRow>();
      for (const a of agents) {
        if (a.id) perAgentMap.set(a.id, blank(a.id));
      }
      const cutoff24h = nowMs - 24 * 3600 * 1000;
      for (const m of memoriesList) {
        if (!m.agentId) continue;
        const row = perAgentMap.get(m.agentId) ?? blank(m.agentId);
        row.memoryCount++;
        if (!m.embeddingModel || m.embeddingModel === "hash-512d") row.hashFallback++;
        if (m.createdAt) {
          const ts = new Date(m.createdAt).getTime();
          if (ts >= cutoff24h) row.writes24h++;
          if (!row.lastWriteAt || ts > new Date(row.lastWriteAt).getTime()) {
            row.lastWriteAt = m.createdAt;
          }
        }
        perAgentMap.set(m.agentId, row);
      }
      const perAgentFull = Array.from(perAgentMap.values()).sort((a, b) => b.memoryCount - a.memoryCount);
      const perAgent = isAdmin
        ? perAgentFull
        : perAgentFull.filter((r) => r.id === callerAgent || r.memoryCount > 0);
      stats.agents = {
        count: agents.length,
        names: isAdmin ? agents.map((a: any) => a.id).filter(Boolean) : undefined,
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
      // Soul entries have no severity dimension — they are keyed identity facts
      // (role / project / standards / …). A per-priority breakdown was dead
      // telemetry: nothing writes Soul.priority to anything but "standard", and
      // the `?? "standard"` fallback also mislabelled *unset* as *standard*, so
      // it always read 100% standard regardless of the data. Report the honest
      // dimension instead — a count per key.
      const byKey: Record<string, number> = {};
      for (const s of souls) {
        const k = (s.key ?? "(unkeyed)") as string;
        byKey[k] = (byKey[k] ?? 0) + 1;
      }
      stats.soul = { total: souls.length, byKey };
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
          peerList: isAdmin
            ? peers.map((p: any) => ({
                id: p.id,
                role: p.role,
                status: p.status,
                lastSyncAt: p.lastSyncAt ?? null,
              }))
            : undefined,
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
          clientList: isAdmin
            ? clients.map((c: any) => ({
                id: c.id,
                name: c.name,
                registeredBy: c.registeredBy ?? null,
                createdAt: c.createdAt ?? null,
              }))
            : undefined,
          idpList: isAdmin
            ? idps.map((i: any) => ({ id: i.id, name: i.name, issuer: i.issuer }))
            : undefined,
        };
      }
    } catch { stats.oauth = null; }

    // ── REM ──
    try {
      const logsDir = join(homedir(), ".flair", "logs");
      const remLog = join(logsDir, "rem.jsonl");
      const nightlyLog = join(logsDir, "rem-nightly.jsonl");

      const tailJsonl = async (path: string, maxBytes = 256 * 1024): Promise<any[]> => {
        let fh: import("node:fs/promises").FileHandle | null = null;
        try {
          const st = await fsp.stat(path).catch(() => null);
          if (!st) return [];
          const start = Math.max(0, st.size - maxBytes);
          const len = st.size - start;
          if (len === 0) return [];
          fh = await fsp.open(path, "r");
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, start);
          return buf
            .toString("utf-8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
        } catch { return []; }
        finally { if (fh) await fh.close().catch(() => {}); }
      };

      const remRecords = await tailJsonl(remLog);
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
        nightlyEnabled = await exists(join(homedir(), "Library", "LaunchAgents", "dev.flair.rem.nightly.plist"));
      } else if (plat === "linux") {
        nightlyEnabled = await exists(join(homedir(), ".config", "systemd", "user", "flair-rem-nightly.timer"));
      }

      const nightlyRecords = await tailJsonl(nightlyLog);
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

      const dirSize = async (root: string, maxDepth = 6): Promise<number | null> => {
        if (!(await exists(root))) return null;
        let total = 0;
        const walk = async (p: string, depth: number): Promise<void> => {
          if (depth > maxDepth) return;
          let entries: import("node:fs").Dirent[];
          try { entries = await fsp.readdir(p, { withFileTypes: true }); } catch { return; }
          const subdirs: string[] = [];
          const files: string[] = [];
          for (const e of entries) {
            const full = join(p, e.name);
            if (e.isDirectory()) subdirs.push(full);
            else if (e.isFile()) files.push(full);
          }
          const sizes = await Promise.all(files.map((f) => fsp.stat(f).then((s) => s.size).catch(() => 0)));
          total += sizes.reduce((a, b) => a + b, 0);
          await Promise.all(subdirs.map((d) => walk(d, depth + 1)));
        };
        await walk(root, 0);
        return total;
      };

      const [dataBytes, snapshotBytes] = await Promise.all([dirSize(dataDir), dirSize(snapshotDir)]);
      if (dataBytes === null && snapshotBytes === null) {
        stats.disk = null;
      } else {
        stats.disk = {
          dataDir: isAdmin ? dataDir : redactHome(dataDir),
          dataBytes: dataBytes ?? 0,
          snapshotDir: isAdmin ? snapshotDir : redactHome(snapshotDir),
          snapshotBytes: snapshotBytes ?? 0,
        };
      }
    } catch { stats.disk = null; }

    // ── Bridges ──
    try {
      const cwd = process.cwd();
      const candidates = [join(cwd, "node_modules"), join(homedir(), ".flair", "node_modules")];
      const installed = new Set<string>();
      await Promise.all(candidates.map(async (base) => {
        if (!(await exists(base))) return;
        try {
          const names = await fsp.readdir(base);
          for (const name of names) {
            if (name.startsWith("flair-bridge-")) installed.add(name);
          }
        } catch { /* skip */ }
      }));
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

    // ── Reranker ──
    // Cross-encoder rerank stage. Reports flag/model/mode + live counters so we
    // can see if it's silently degrading (fallbackCount climbing) in prod.
    try {
      const rr = getRerankStatus();
      stats.rerank = rr;
      if (rr.enabled && rr.state === "failed") {
        warnings.push({ level: "warn", message: `reranker enabled but unavailable: ${rr.error ?? "init failed"} — recall falling back to vector order` });
      }
      if (rr.enabled && rr.rerankCount > 0 && rr.fallbackCount > rr.rerankCount) {
        warnings.push({ level: "warn", message: `reranker falling back more than reranking (${rr.fallbackCount} fallbacks / ${rr.rerankCount} reranks) — check latency budget / topN` });
      }
    } catch { stats.rerank = null; }

    // ── Warnings ──
    stats.warnings = warnings;

    // ── Process info ──
    // version: the RUNNING process's own package.json — used by `flair
    // upgrade`'s post-restart verification (flair#635) to prove the new
    // code is actually serving, not just installed on disk.
    stats.version = resolveVersion();
    stats.pid = process.pid;
    stats.uptimeSeconds = Math.floor(process.uptime());

    return stats;
  }
}
