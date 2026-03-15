/**
 * bootstrap-database.test.ts
 *
 * Tests for bootstrapDatabase() — create_database + create_table sequence
 * sent to operations API on flair init.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-dbboot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// Inline bootstrapDatabase logic (mirrors CLI)
const FLAIR_TABLES = [
  "Agent", "Integration", "Memory", "MemoryGrant", "Soul",
  "WorkspaceState", "OrgEvent", "ObsOffice", "ObsAgentSnapshot", "ObsEventFeed",
];

async function bootstrapDatabase(opsPort: number, adminUser: string, adminPass: string): Promise<void> {
  const url = `http://127.0.0.1:${opsPort}/`;
  const auth = Buffer.from(`${adminUser}:${adminPass}`).toString("base64");

  async function opsPost(body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text };
  }

  const dbRes = await opsPost({ operation: "create_database", database: "flair" });
  if (!dbRes.ok && !dbRes.text.includes("already exists") && !dbRes.text.includes("duplicate") && dbRes.status !== 409) {
    throw new Error(`Failed to create database 'flair' (${dbRes.status}): ${dbRes.text}`);
  }

  for (const table of FLAIR_TABLES) {
    const res = await opsPost({ operation: "create_table", database: "flair", table, hash_attribute: "id" });
    if (!res.ok && !res.text.includes("already exists") && !res.text.includes("duplicate") && res.status !== 409) {
      // warn only, don't throw
    }
  }
}

describe("bootstrapDatabase", () => {
  let tmpDir: string;
  let opsServer: { server: Server; url: string; port: number };
  let requests: Array<{ body: any; authHeader: string }> = [];

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    requests = [];
    opsServer = await startMockServer((req, body, res) => {
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch {}
      requests.push({ body: parsed, authHeader: req.headers.authorization ?? "" });
      jsonRes(res, 200, { message: "ok" });
    });
  });

  afterEach(async () => {
    await stopServer(opsServer.server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends create_database as first operation", async () => {
    await bootstrapDatabase(opsServer.port, "admin", "test123");
    expect(requests[0].body.operation).toBe("create_database");
    expect(requests[0].body.database).toBe("flair");
  });

  it("sends create_table for all expected tables", async () => {
    await bootstrapDatabase(opsServer.port, "admin", "test123");

    const tableOps = requests.filter(r => r.body.operation === "create_table");
    const tableNames = tableOps.map(r => r.body.table);

    for (const t of FLAIR_TABLES) {
      expect(tableNames).toContain(t);
    }
  });

  it("all create_table ops target database 'flair'", async () => {
    await bootstrapDatabase(opsServer.port, "admin", "test123");

    const tableOps = requests.filter(r => r.body.operation === "create_table");
    for (const op of tableOps) {
      expect(op.body.database).toBe("flair");
    }
  });

  it("uses Basic auth for all requests", async () => {
    await bootstrapDatabase(opsServer.port, "admin", "bootpass");
    for (const req of requests) {
      const decoded = Buffer.from(req.authHeader.replace("Basic ", ""), "base64").toString();
      expect(decoded).toBe("admin:bootpass");
    }
  });

  it("does not throw when database already exists (409)", async () => {
    await stopServer(opsServer.server);
    let callCount = 0;
    opsServer = await startMockServer((_req, body, res) => {
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch {}
      callCount++;
      if (parsed.operation === "create_database") {
        return jsonRes(res, 409, { error: "already exists" });
      }
      jsonRes(res, 200, { message: "ok" });
    });

    // Should not throw
    await expect(bootstrapDatabase(opsServer.port, "admin", "test123")).resolves.toBeUndefined();
    expect(callCount).toBeGreaterThan(0);
  });

  it("does not throw when table already exists (text match)", async () => {
    await stopServer(opsServer.server);
    opsServer = await startMockServer((_req, body, res) => {
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch {}
      if (parsed.operation === "create_table") {
        return jsonRes(res, 400, { error: "table already exists" });
      }
      jsonRes(res, 200, { message: "ok" });
    });

    // Should not throw
    await expect(bootstrapDatabase(opsServer.port, "admin", "test123")).resolves.toBeUndefined();
  });

  it("throws on unexpected create_database failure", async () => {
    await stopServer(opsServer.server);
    opsServer = await startMockServer((_req, _body, res) => {
      jsonRes(res, 500, { error: "internal server error" });
    });

    await expect(bootstrapDatabase(opsServer.port, "admin", "test123")).rejects.toThrow("500");
  });

  it("total requests = 1 (create_database) + N tables", async () => {
    await bootstrapDatabase(opsServer.port, "admin", "test123");
    expect(requests.length).toBe(1 + FLAIR_TABLES.length);
  });
});
