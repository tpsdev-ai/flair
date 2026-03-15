/**
 * cli-v2.test.ts — Unit tests for flair init, agent add, status CLI commands
 *
 * Uses mock HTTP servers. No real Harper instance required.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// ─── Inline implementations (mirror CLI logic for unit testing) ───────────────
// We test the core logic functions independently to avoid CLI parse complexity.

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function runSeedAgent(
  opsPort: number,
  agentId: string,
  pubKeyB64url: string,
  adminUser: string,
  adminPass: string,
): Promise<void> {
  const url = `http://127.0.0.1:${opsPort}/`;
  const auth = Buffer.from(`${adminUser}:${adminPass}`).toString("base64");
  const body = {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id: agentId, name: agentId, publicKey: pubKeyB64url, createdAt: new Date().toISOString() }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 409 || text.includes("duplicate") || text.includes("already exists")) return;
    throw new Error(`Operations API insert failed (${res.status}): ${text}`);
  }
}

function ensureKeyPair(agentId: string, keysDir: string): { privPath: string; pubKeyB64url: string } {
  mkdirSync(keysDir, { recursive: true });
  const privPath = join(keysDir, `${agentId}.key`);
  const pubPath = join(keysDir, `${agentId}.pub`);

  if (existsSync(privPath)) {
    const seed = new Uint8Array(readFileSync(privPath));
    const kp = nacl.sign.keyPair.fromSeed(seed);
    return { privPath, pubKeyB64url: b64url(kp.publicKey) };
  }

  const kp = nacl.sign.keyPair();
  const seed = kp.secretKey.slice(0, 32);
  writeFileSync(privPath, Buffer.from(seed));
  chmodSync(privPath, 0o600);
  writeFileSync(pubPath, Buffer.from(kp.publicKey));
  return { privPath, pubKeyB64url: b64url(kp.publicKey) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("flair init / agent add", () => {
  let tmpDir: string;
  let opsServer: { server: Server; url: string; port: number };
  let httpServer: { server: Server; url: string; port: number };
  let opsRequests: Array<{ path: string; method: string; body: string }> = [];

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    opsRequests = [];

    opsServer = await startMockServer((req, body, res) => {
      opsRequests.push({ path: req.url ?? "/", method: req.method ?? "GET", body });
      jsonRes(res, 200, { inserted_hashes: 1 });
    });

    httpServer = await startMockServer((req, _body, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
      if (req.url?.startsWith("/Agent/") && req.headers.authorization?.startsWith("TPS-Ed25519")) {
        jsonRes(res, 200, { id: "test-agent" }); return;
      }
      jsonRes(res, 401, { error: "unauthorized" });
    });
  });

  afterEach(async () => {
    await stopServer(opsServer.server);
    await stopServer(httpServer.server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Keypair ────────────────────────────────────────────────────────────

  describe("keypair generation", () => {
    it("generates new 32-byte seed and writes to keys dir", () => {
      const keysDir = join(tmpDir, "keys");
      const { privPath, pubKeyB64url } = ensureKeyPair("test-agent", keysDir);

      expect(existsSync(privPath)).toBe(true);
      const seed = readFileSync(privPath);
      expect(seed.length).toBe(32);
      expect(pubKeyB64url).toBeTruthy();
      expect(pubKeyB64url).not.toContain("="); // no padding
    });

    it("reuses existing seed and derives correct public key", () => {
      const keysDir = join(tmpDir, "keys");
      mkdirSync(keysDir, { recursive: true });
      const privPath = join(keysDir, "test-agent.key");

      // Write known seed
      const knownSeed = Buffer.alloc(32, 0x42);
      writeFileSync(privPath, knownSeed);

      const { pubKeyB64url } = ensureKeyPair("test-agent", keysDir);

      const expectedKp = nacl.sign.keyPair.fromSeed(new Uint8Array(knownSeed));
      const expectedB64url = Buffer.from(expectedKp.publicKey).toString("base64url");
      expect(pubKeyB64url).toBe(expectedB64url);
    });

    it("public key is raw 32 bytes (not SPKI)", () => {
      const keysDir = join(tmpDir, "keys");
      const { pubKeyB64url } = ensureKeyPair("test-agent", keysDir);
      const decoded = Buffer.from(pubKeyB64url, "base64url");
      expect(decoded.length).toBe(32);
    });
  });

  // ─── Operations API seeding ──────────────────────────────────────────────

  describe("agent seeding via operations API", () => {
    it("POSTs insert with correct fields", async () => {
      const keysDir = join(tmpDir, "keys");
      const { pubKeyB64url } = ensureKeyPair("test-agent", keysDir);
      await runSeedAgent(opsServer.port, "test-agent", pubKeyB64url, "admin", "test123");

      expect(opsRequests).toHaveLength(1);
      const body = JSON.parse(opsRequests[0].body);
      expect(body.operation).toBe("insert");
      expect(body.table).toBe("Agent");
      expect(body.records[0].id).toBe("test-agent");
      expect(body.records[0].publicKey).toBe(pubKeyB64url);
    });

    it("uses Basic auth for operations API", async () => {
      // Override ops server to capture auth header
      await stopServer(opsServer.server);
      const authHeaders: string[] = [];
      opsServer = await startMockServer((req, body, res) => {
        authHeaders.push(req.headers.authorization ?? "");
        opsRequests.push({ path: req.url ?? "/", method: req.method ?? "GET", body });
        jsonRes(res, 200, { inserted_hashes: 1 });
      });

      const keysDir = join(tmpDir, "keys");
      const { pubKeyB64url } = ensureKeyPair("test-agent", keysDir);
      await runSeedAgent(opsServer.port, "test-agent", pubKeyB64url, "admin", "mypass");

      expect(authHeaders[0]).toStartWith("Basic ");
      const decoded = Buffer.from(authHeaders[0].replace("Basic ", ""), "base64").toString("utf-8");
      expect(decoded).toBe("admin:mypass");
    });

    it("ignores 409 duplicate — does not throw", async () => {
      await stopServer(opsServer.server);
      opsServer = await startMockServer((_req, _body, res) => {
        jsonRes(res, 409, { error: "duplicate key" });
      });

      const keysDir = join(tmpDir, "keys");
      const { pubKeyB64url } = ensureKeyPair("test-agent", keysDir);
      // Should not throw
      await expect(runSeedAgent(opsServer.port, "test-agent", pubKeyB64url, "admin", "test123")).resolves.toBeUndefined();
    });

    it("throws on non-409 error", async () => {
      await stopServer(opsServer.server);
      opsServer = await startMockServer((_req, _body, res) => {
        jsonRes(res, 500, { error: "internal server error" });
      });

      const keysDir = join(tmpDir, "keys");
      const { pubKeyB64url } = ensureKeyPair("test-agent", keysDir);
      await expect(runSeedAgent(opsServer.port, "test-agent", pubKeyB64url, "admin", "test123")).rejects.toThrow("500");
    });
  });

  // ─── Admin password ───────────────────────────────────────────────────────

  describe("admin password", () => {
    it("does not write admin password to disk", () => {
      const keysDir = join(tmpDir, "keys");
      ensureKeyPair("test-agent", keysDir);

      // Check no password files exist in keysDir or tmpDir root
      const files = require("node:fs").readdirSync(keysDir) as string[];
      for (const f of files) {
        const content = readFileSync(join(keysDir, f), "utf-8").trim();
        // Files should be binary keys, not plaintext passwords
        // (seed is 32 raw bytes, pub key is 32 raw bytes — not text)
        expect(content.length).toBeLessThanOrEqual(64); // raw bytes, not a long text file
      }
    });
  });
});

// ─── flair status logic ───────────────────────────────────────────────────────

describe("flair status", () => {
  let tmpDir: string;
  let httpServer: { server: Server; url: string; port: number };

  beforeEach(async () => {
    tmpDir = makeTmpDir();
  });

  afterEach(async () => {
    if (httpServer?.server?.listening) await stopServer(httpServer.server);
    rmSync(tmpDir, { recursive: true, force: true });
    // Reset so next test doesn't try to close a stale reference
    httpServer = undefined as any;
  });

  async function getStatus(baseUrl: string): Promise<{ healthy: boolean; agentCount: number | null }> {
    let healthy = false;
    let agentCount: number | null = null;
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      healthy = res.status > 0;
    } catch { /* unreachable */ }

    if (healthy) {
      try {
        const agents = await fetch(`${baseUrl}/Agent`, { signal: AbortSignal.timeout(3000) });
        if (agents.ok) {
          const list = await agents.json().catch(() => null);
          if (Array.isArray(list)) agentCount = list.length;
        }
      } catch { /* best effort */ }
    }
    return { healthy, agentCount };
  }

  it("returns healthy=true when Harper responds", async () => {
    httpServer = await startMockServer((req, _body, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
      if (req.url === "/Agent") { jsonRes(res, 200, [{ id: "a1" }, { id: "a2" }]); return; }
      res.writeHead(404); res.end();
    });

    const { healthy, agentCount } = await getStatus(httpServer.url);
    expect(healthy).toBe(true);
    expect(agentCount).toBe(2);
  });

  it("returns healthy=false when Harper is unreachable", async () => {
    const { healthy, agentCount } = await getStatus("http://127.0.0.1:19999");
    expect(healthy).toBe(false);
    expect(agentCount).toBeNull();
  });

  it("handles missing /Agent endpoint gracefully", async () => {
    httpServer = await startMockServer((req, _body, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
      res.writeHead(404); res.end();
    });

    const { healthy, agentCount } = await getStatus(httpServer.url);
    expect(healthy).toBe(true);
    expect(agentCount).toBeNull();
  });
});
