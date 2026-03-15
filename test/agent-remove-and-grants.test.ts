/**
 * agent-remove-and-grants.test.ts
 *
 * Tests for:
 *   1. flair agent remove — delete agent, memories, souls, key files
 *   2. flair grant — create MemoryGrant record
 *   3. flair revoke — delete MemoryGrant record
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-rmgrant-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// ─── Inline agent remove logic (mirrors CLI) ──────────────────────────────────

interface RemoveOpts {
  agentId: string;
  keysDir: string;
  opsPort: number;
  adminPass: string;
  keepKeys?: boolean;
  force?: boolean;
}

async function runAgentRemove(opts: RemoveOpts): Promise<{
  memoriesDeleted: number;
  soulsDeleted: number;
  agentDeleted: boolean;
  keysDeleted: boolean;
}> {
  const { agentId, keysDir, opsPort, adminPass, keepKeys = false } = opts;
  const adminUser = "admin";
  const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

  async function opsPost(body: unknown): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404 || text.includes("not found")) return [];
      throw new Error(`ops failed (${res.status}): ${text}`);
    }
    return res.json().catch(() => []);
  }

  // Get memories
  const memories = await opsPost({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "agentId", search_value: agentId, get_attributes: ["id"] });
  const memList = Array.isArray(memories) ? memories : [];

  // Delete memories
  for (const m of memList) {
    if (m?.id) await opsPost({ operation: "delete", database: "flair", table: "Memory", ids: [m.id] }).catch(() => {});
  }

  // Get souls
  const souls = await opsPost({ operation: "search_by_value", database: "flair", table: "Soul", search_attribute: "agentId", search_value: agentId, get_attributes: ["id"] });
  const soulList = Array.isArray(souls) ? souls : [];

  // Delete souls
  for (const s of soulList) {
    if (s?.id) await opsPost({ operation: "delete", database: "flair", table: "Soul", ids: [s.id] }).catch(() => {});
  }

  // Delete agent
  await opsPost({ operation: "delete", database: "flair", table: "Agent", ids: [agentId] });

  // Delete key files
  let keysDeleted = false;
  if (!keepKeys) {
    const privPath = join(keysDir, `${agentId}.key`);
    const pubPath = join(keysDir, `${agentId}.pub`);
    const backupPath = privPath + ".bak";
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
    for (const p of [privPath, pubPath, backupPath]) {
      if (existsSync(p)) { try { unlinkSync(p); keysDeleted = true; } catch { /* best effort */ } }
    }
  }

  return { memoriesDeleted: memList.length, soulsDeleted: soulList.length, agentDeleted: true, keysDeleted };
}

// ─── Inline grant/revoke logic ────────────────────────────────────────────────

async function runGrant(opts: {
  fromAgent: string;
  toAgent: string;
  scope: string;
  opsPort: number;
  adminPass: string;
}): Promise<{ grantId: string; alreadyExists: boolean }> {
  const { fromAgent, toAgent, scope, opsPort, adminPass } = opts;
  const auth = `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`;
  const grantId = `${fromAgent}:${toAgent}`;

  const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "MemoryGrant",
      records: [{ id: grantId, fromAgentId: fromAgent, toAgentId: toAgent, scope, createdAt: new Date().toISOString() }],
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 409 || text.includes("duplicate")) return { grantId, alreadyExists: true };
    throw new Error(`grant failed (${res.status}): ${text}`);
  }
  return { grantId, alreadyExists: false };
}

async function runRevoke(opts: {
  fromAgent: string;
  toAgent: string;
  opsPort: number;
  adminPass: string;
}): Promise<{ revoked: boolean; notFound: boolean }> {
  const { fromAgent, toAgent, opsPort, adminPass } = opts;
  const auth = `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`;
  const grantId = `${fromAgent}:${toAgent}`;

  const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ operation: "delete", database: "flair", table: "MemoryGrant", ids: [grantId] }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 404 || text.includes("not found")) return { revoked: false, notFound: true };
    throw new Error(`revoke failed (${res.status}): ${text}`);
  }
  return { revoked: true, notFound: false };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("flair agent remove", () => {
  let tmpDir: string;
  let opsServer: { server: Server; url: string; port: number };
  let requests: Array<{ method: string; body: any }>;

  const MEMORIES = [{ id: "m1" }, { id: "m2" }];
  const SOULS = [{ id: "flint:soul" }];

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    requests = [];

    opsServer = await startMockServer((req, body, res) => {
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch {}
      requests.push({ method: req.method ?? "GET", body: parsed });

      if (parsed.operation === "search_by_value" && parsed.table === "Memory") return jsonRes(res, 200, MEMORIES);
      if (parsed.operation === "search_by_value" && parsed.table === "Soul") return jsonRes(res, 200, SOULS);
      if (parsed.operation === "search_by_value" && parsed.table === "Agent") return jsonRes(res, 200, [{ id: "flint", name: "Flint" }]);
      if (parsed.operation === "delete") return jsonRes(res, 200, { deleted_hashes: 1 });
      jsonRes(res, 200, {});
    });
  });

  afterEach(async () => {
    await stopServer(opsServer.server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes all memories and souls before agent", async () => {
    const result = await runAgentRemove({
      agentId: "flint",
      keysDir: join(tmpDir, "keys"),
      opsPort: opsServer.port,
      adminPass: "test123",
      force: true,
    });

    expect(result.memoriesDeleted).toBe(2);
    expect(result.soulsDeleted).toBe(1);
    expect(result.agentDeleted).toBe(true);
  });

  it("sends correct delete operations for each record", async () => {
    await runAgentRemove({
      agentId: "flint",
      keysDir: join(tmpDir, "keys"),
      opsPort: opsServer.port,
      adminPass: "test123",
      force: true,
    });

    const deletes = requests.filter(r => r.body.operation === "delete");
    // m1, m2, flint:soul, flint agent = 4 deletes
    expect(deletes.length).toBe(4);

    const memDeletes = deletes.filter(r => r.body.table === "Memory");
    expect(memDeletes).toHaveLength(2);

    const agentDelete = deletes.find(r => r.body.table === "Agent");
    expect(agentDelete?.body.ids).toContain("flint");
  });

  it("deletes key files by default", async () => {
    const keysDir = join(tmpDir, "keys");
    mkdirSync(keysDir, { recursive: true });
    const privPath = join(keysDir, "flint.key");
    const pubPath = join(keysDir, "flint.pub");
    writeFileSync(privPath, Buffer.alloc(32, 0x01));
    writeFileSync(pubPath, Buffer.alloc(32, 0x02));

    const result = await runAgentRemove({
      agentId: "flint",
      keysDir,
      opsPort: opsServer.port,
      adminPass: "test123",
      force: true,
    });

    expect(result.keysDeleted).toBe(true);
    expect(existsSync(privPath)).toBe(false);
    expect(existsSync(pubPath)).toBe(false);
  });

  it("preserves key files with --keep-keys", async () => {
    const keysDir = join(tmpDir, "keys");
    mkdirSync(keysDir, { recursive: true });
    const privPath = join(keysDir, "flint.key");
    writeFileSync(privPath, Buffer.alloc(32, 0x01));

    const result = await runAgentRemove({
      agentId: "flint",
      keysDir,
      opsPort: opsServer.port,
      adminPass: "test123",
      keepKeys: true,
      force: true,
    });

    expect(result.keysDeleted).toBe(false);
    expect(existsSync(privPath)).toBe(true);
  });

  it("uses Basic auth for all operations API calls", async () => {
    const authHeaders: string[] = [];
    await stopServer(opsServer.server);
    opsServer = await startMockServer((req, body, res) => {
      authHeaders.push(req.headers.authorization ?? "");
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch {}
      if (parsed.operation === "search_by_value") return jsonRes(res, 200, []);
      jsonRes(res, 200, { deleted_hashes: 1 });
    });

    await runAgentRemove({
      agentId: "flint",
      keysDir: join(tmpDir, "keys"),
      opsPort: opsServer.port,
      adminPass: "removepass",
      force: true,
    });

    expect(authHeaders.length).toBeGreaterThan(0);
    for (const h of authHeaders) {
      expect(h).toStartWith("Basic ");
      const decoded = Buffer.from(h.replace("Basic ", ""), "base64").toString();
      expect(decoded).toBe("admin:removepass");
    }
  });
});

describe("flair grant", () => {
  let tmpDir: string;
  let opsServer: { server: Server; url: string; port: number };
  let requests: Array<{ body: any; authHeader: string }>;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    requests = [];
    opsServer = await startMockServer((req, body, res) => {
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch {}
      requests.push({ body: parsed, authHeader: req.headers.authorization ?? "" });
      jsonRes(res, 200, { inserted_hashes: 1 });
    });
  });

  afterEach(async () => {
    await stopServer(opsServer.server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inserts MemoryGrant record with correct fields", async () => {
    const result = await runGrant({
      fromAgent: "flint",
      toAgent: "kern",
      scope: "read",
      opsPort: opsServer.port,
      adminPass: "test123",
    });

    expect(result.grantId).toBe("flint:kern");
    expect(result.alreadyExists).toBe(false);

    const req = requests[0];
    expect(req.body.operation).toBe("insert");
    expect(req.body.table).toBe("MemoryGrant");
    expect(req.body.records[0].id).toBe("flint:kern");
    expect(req.body.records[0].fromAgentId).toBe("flint");
    expect(req.body.records[0].toAgentId).toBe("kern");
    expect(req.body.records[0].scope).toBe("read");
  });

  it("supports custom scope", async () => {
    await runGrant({ fromAgent: "flint", toAgent: "kern", scope: "search", opsPort: opsServer.port, adminPass: "test123" });
    expect(requests[0].body.records[0].scope).toBe("search");
  });

  it("uses Basic auth", async () => {
    await runGrant({ fromAgent: "flint", toAgent: "kern", scope: "read", opsPort: opsServer.port, adminPass: "grantpass" });
    const decoded = Buffer.from(requests[0].authHeader.replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe("admin:grantpass");
  });

  it("handles 409 duplicate gracefully", async () => {
    await stopServer(opsServer.server);
    opsServer = await startMockServer((_req, _body, res) => jsonRes(res, 409, { error: "duplicate" }));

    const result = await runGrant({ fromAgent: "flint", toAgent: "kern", scope: "read", opsPort: opsServer.port, adminPass: "test123" });
    expect(result.alreadyExists).toBe(true);
  });
});

describe("flair revoke", () => {
  let tmpDir: string;
  let opsServer: { server: Server; url: string; port: number };
  let requests: Array<{ body: any }>;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    requests = [];
    opsServer = await startMockServer((req, body, res) => {
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch {}
      requests.push({ body: parsed });
      jsonRes(res, 200, { deleted_hashes: 1 });
    });
  });

  afterEach(async () => {
    await stopServer(opsServer.server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes MemoryGrant with correct id", async () => {
    const result = await runRevoke({ fromAgent: "flint", toAgent: "kern", opsPort: opsServer.port, adminPass: "test123" });

    expect(result.revoked).toBe(true);
    expect(requests[0].body.operation).toBe("delete");
    expect(requests[0].body.table).toBe("MemoryGrant");
    expect(requests[0].body.ids).toContain("flint:kern");
  });

  it("handles 404 not found gracefully", async () => {
    await stopServer(opsServer.server);
    opsServer = await startMockServer((_req, _body, res) => jsonRes(res, 404, { error: "not found" }));

    const result = await runRevoke({ fromAgent: "flint", toAgent: "kern", opsPort: opsServer.port, adminPass: "test123" });
    expect(result.notFound).toBe(true);
    expect(result.revoked).toBe(false);
  });
});
