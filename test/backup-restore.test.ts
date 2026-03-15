/**
 * backup-restore.test.ts — Unit tests for flair backup and restore commands
 *
 * Tests the core backup/restore logic using mock HTTP servers.
 * No real Harper instance required.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

function startMockServer(handler: Handler): Promise<{ server: Server; url: string; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, body, res));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, port });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

function jsonRes(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENTS = [
  { id: "flint", name: "Flint" },
  { id: "kern", name: "Kern" },
];

const MEMORIES = [
  { id: "m1", agentId: "flint", content: "Strategy note", type: "lesson" },
  { id: "m2", agentId: "flint", content: "Architecture decision", type: "decision" },
  { id: "m3", agentId: "kern", content: "Review comment", type: "lesson" },
];

const SOULS = [
  { id: "flint:soul", agentId: "flint", key: "soul", value: "I am Flint" },
  { id: "kern:identity", agentId: "kern", key: "identity", value: "Kern the reviewer" },
];

// ─── Inline backup logic (mirrors CLI logic for unit testing) ─────────────────

interface BackupOptions {
  baseUrl: string;
  adminUser: string;
  adminPass: string;
  agentFilter?: string[] | null;
}

interface BackupResult {
  version: number;
  createdAt: string;
  source: string;
  agents: any[];
  memories: any[];
  souls: any[];
}

async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const auth = `Basic ${Buffer.from(`${opts.adminUser}:${opts.adminPass}`).toString("base64")}`;

  async function adminGet(path: string): Promise<any> {
    const res = await fetch(`${opts.baseUrl}${path}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
    return res.json();
  }

  const allAgents: any[] = await adminGet("/Agent");
  const agents = opts.agentFilter
    ? allAgents.filter((a: any) => opts.agentFilter!.includes(a.id))
    : allAgents;

  const memories: any[] = [];
  for (const agent of agents) {
    try {
      const agentMemories = await adminGet(`/Memory?agentId=${encodeURIComponent(agent.id)}`);
      if (Array.isArray(agentMemories)) memories.push(...agentMemories);
    } catch { /* best effort */ }
  }

  const souls: any[] = [];
  for (const agent of agents) {
    try {
      const agentSouls = await adminGet(`/Soul?agentId=${encodeURIComponent(agent.id)}`);
      if (Array.isArray(agentSouls)) souls.push(...agentSouls);
    } catch { /* best effort */ }
  }

  return { version: 1, createdAt: new Date().toISOString(), source: opts.baseUrl, agents, memories, souls };
}

interface RestoreOptions {
  baseUrl: string;
  adminUser: string;
  adminPass: string;
  mode: "merge" | "replace";
  dryRun?: boolean;
  backup: BackupResult;
}

interface RestoreResult {
  agentCount: number;
  memoryCount: number;
  soulCount: number;
}

async function runRestore(opts: RestoreOptions): Promise<RestoreResult> {
  const { agents = [], memories = [], souls = [] } = opts.backup;
  const auth = `Basic ${Buffer.from(`${opts.adminUser}:${opts.adminPass}`).toString("base64")}`;

  if (opts.dryRun) return { agentCount: 0, memoryCount: 0, soulCount: 0 };

  async function adminPut(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${opts.baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PUT ${path} failed (${res.status}): ${text}`);
    }
  }

  async function adminDelete(path: string): Promise<void> {
    const res = await fetch(`${opts.baseUrl}${path}`, {
      method: "DELETE",
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
    }
  }

  if (opts.mode === "replace") {
    for (const m of memories) if (m.id) await adminDelete(`/Memory/${m.id}`).catch(() => {});
    for (const s of souls) if (s.id) await adminDelete(`/Soul/${s.id}`).catch(() => {});
  }

  let agentCount = 0, memoryCount = 0, soulCount = 0;
  for (const a of agents) { try { await adminPut(`/Agent/${a.id}`, a); agentCount++; } catch { /* warn */ } }
  for (const m of memories) { try { await adminPut(`/Memory/${m.id}`, m); memoryCount++; } catch { /* warn */ } }
  for (const s of souls) { try { await adminPut(`/Soul/${s.id}`, s); soulCount++; } catch { /* warn */ } }

  return { agentCount, memoryCount, soulCount };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("flair backup", () => {
  let tmpDir: string;
  let server: { server: Server; url: string; port: number };

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    server = await startMockServer((req, _body, res) => {
      if (req.url === "/Agent") return jsonRes(res, 200, AGENTS);
      if (req.url?.startsWith("/Memory?agentId=flint")) return jsonRes(res, 200, MEMORIES.filter(m => m.agentId === "flint"));
      if (req.url?.startsWith("/Memory?agentId=kern")) return jsonRes(res, 200, MEMORIES.filter(m => m.agentId === "kern"));
      if (req.url?.startsWith("/Soul?agentId=flint")) return jsonRes(res, 200, SOULS.filter(s => s.agentId === "flint"));
      if (req.url?.startsWith("/Soul?agentId=kern")) return jsonRes(res, 200, SOULS.filter(s => s.agentId === "kern"));
      jsonRes(res, 404, { error: "not found" });
    });
  });

  afterEach(async () => {
    await stopServer(server.server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fetches all agents, memories, and souls", async () => {
    const result = await runBackup({ baseUrl: server.url, adminUser: "admin", adminPass: "test123" });
    expect(result.agents).toHaveLength(2);
    expect(result.memories).toHaveLength(3);
    expect(result.souls).toHaveLength(2);
  });

  it("backup has correct version and source", async () => {
    const result = await runBackup({ baseUrl: server.url, adminUser: "admin", adminPass: "test123" });
    expect(result.version).toBe(1);
    expect(result.source).toBe(server.url);
    expect(result.createdAt).toBeTruthy();
  });

  it("filters by agent IDs when specified", async () => {
    const result = await runBackup({
      baseUrl: server.url,
      adminUser: "admin",
      adminPass: "test123",
      agentFilter: ["flint"],
    });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].id).toBe("flint");
    expect(result.memories).toHaveLength(2); // only flint's
    expect(result.souls).toHaveLength(1);    // only flint's
  });

  it("uses Basic auth for all requests", async () => {
    const authHeaders: string[] = [];
    await stopServer(server.server);
    server = await startMockServer((req, _body, res) => {
      authHeaders.push(req.headers.authorization ?? "");
      if (req.url === "/Agent") return jsonRes(res, 200, []);
      jsonRes(res, 200, []);
    });

    await runBackup({ baseUrl: server.url, adminUser: "admin", adminPass: "mypass" });

    expect(authHeaders.length).toBeGreaterThan(0);
    const decoded = Buffer.from(authHeaders[0].replace("Basic ", ""), "base64").toString("utf-8");
    expect(decoded).toBe("admin:mypass");
  });

  it("writes valid JSON to output file", async () => {
    const result = await runBackup({ baseUrl: server.url, adminUser: "admin", adminPass: "test123" });
    const outputPath = join(tmpDir, "backup.json");
    writeFileSync(outputPath, JSON.stringify(result, null, 2));

    const parsed = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(parsed.version).toBe(1);
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.memories).toHaveLength(3);
  });
});

describe("flair restore", () => {
  let tmpDir: string;
  let server: { server: Server; url: string; port: number };
  let requests: Array<{ method: string; path: string; body: string }>;

  const BACKUP: BackupResult = {
    version: 1,
    createdAt: "2026-03-15T00:00:00.000Z",
    source: "http://127.0.0.1:9926",
    agents: AGENTS,
    memories: MEMORIES,
    souls: SOULS,
  };

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    requests = [];
    server = await startMockServer((req, body, res) => {
      requests.push({ method: req.method ?? "GET", path: req.url ?? "/", body });
      if (req.method === "PUT") { res.writeHead(204); res.end(); return; }
      if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
      jsonRes(res, 404, { error: "not found" });
    });
  });

  afterEach(async () => {
    await stopServer(server.server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restores all records in merge mode", async () => {
    const result = await runRestore({
      baseUrl: server.url,
      adminUser: "admin",
      adminPass: "test123",
      mode: "merge",
      backup: BACKUP,
    });

    expect(result.agentCount).toBe(2);
    expect(result.memoryCount).toBe(3);
    expect(result.soulCount).toBe(2);

    // Should only have PUT requests (no DELETE in merge mode)
    const deletes = requests.filter(r => r.method === "DELETE");
    expect(deletes).toHaveLength(0);
    const puts = requests.filter(r => r.method === "PUT");
    expect(puts).toHaveLength(7); // 2 agents + 3 memories + 2 souls
  });

  it("deletes existing records before restoring in replace mode", async () => {
    const result = await runRestore({
      baseUrl: server.url,
      adminUser: "admin",
      adminPass: "test123",
      mode: "replace",
      backup: BACKUP,
    });

    expect(result.agentCount).toBe(2);

    const deletes = requests.filter(r => r.method === "DELETE");
    // Should delete memories + souls before restoring (3 memories + 2 souls = 5 deletes)
    expect(deletes.length).toBe(5);
  });

  it("dry run makes no HTTP requests", async () => {
    const result = await runRestore({
      baseUrl: server.url,
      adminUser: "admin",
      adminPass: "test123",
      mode: "merge",
      dryRun: true,
      backup: BACKUP,
    });

    expect(result.agentCount).toBe(0);
    expect(result.memoryCount).toBe(0);
    expect(result.soulCount).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("uses Basic auth for restore requests", async () => {
    const authHeaders: string[] = [];
    await stopServer(server.server);
    server = await startMockServer((req, _body, res) => {
      authHeaders.push(req.headers.authorization ?? "");
      res.writeHead(204); res.end();
    });

    await runRestore({
      baseUrl: server.url,
      adminUser: "admin",
      adminPass: "restorepass",
      mode: "merge",
      backup: { ...BACKUP, agents: [AGENTS[0]], memories: [], souls: [] },
    });

    expect(authHeaders.length).toBeGreaterThan(0);
    const decoded = Buffer.from(authHeaders[0].replace("Basic ", ""), "base64").toString("utf-8");
    expect(decoded).toBe("admin:restorepass");
  });

  it("handles DELETE 404 gracefully in replace mode", async () => {
    await stopServer(server.server);
    server = await startMockServer((req, _body, res) => {
      requests.push({ method: req.method ?? "GET", path: req.url ?? "/", body: "" });
      if (req.method === "DELETE") { res.writeHead(404); res.end(); return; }
      if (req.method === "PUT") { res.writeHead(204); res.end(); return; }
      res.writeHead(404); res.end();
    });

    // Should not throw
    const result = await runRestore({
      baseUrl: server.url,
      adminUser: "admin",
      adminPass: "test123",
      mode: "replace",
      backup: BACKUP,
    });
    expect(result.agentCount).toBe(2);
  });
});
