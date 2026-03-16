/**
 * key-paths-and-rotation.test.ts
 *
 * Tests for:
 *   1. Plugin key resolution order (FLAIR_KEY_DIR > ~/.flair/keys > legacy paths)
 *   2. flair agent rotate-key logic (keypair gen, ops API update, verify, backup)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-keyrot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

// ─── Inline key resolution (mirrors plugin logic) ─────────────────────────────

function resolveKey(
  agentId: string,
  opts: {
    configKeyPath?: string;
    flairKeyDir?: string;   // FLAIR_KEY_DIR override
    newStandardDir: string; // ~/.flair/keys equivalent
    legacyDir: string;      // ~/.tps/secrets/flair equivalent
  }
): { path: string | null; source: "config" | "env" | "standard" | "legacy" | null } {
  // 1. Explicit config keyPath
  if (opts.configKeyPath && existsSync(opts.configKeyPath)) {
    return { path: opts.configKeyPath, source: "config" };
  }

  // 2. FLAIR_KEY_DIR env
  if (opts.flairKeyDir) {
    const p = join(opts.flairKeyDir, `${agentId}.key`);
    if (existsSync(p)) return { path: p, source: "env" };
  }

  // 3. New standard path
  const standard = join(opts.newStandardDir, `${agentId}.key`);
  if (existsSync(standard)) return { path: standard, source: "standard" };

  // 4. Legacy path
  const legacy = join(opts.legacyDir, `${agentId}-priv.key`);
  if (existsSync(legacy)) return { path: legacy, source: "legacy" };

  return { path: null, source: null };
}

// ─── Inline rotate-key logic ──────────────────────────────────────────────────

async function rotateKey(opts: {
  agentId: string;
  keysDir: string;
  opsPort: number;
  httpPort: number;
  adminPass: string;
}): Promise<{ newPubKeyB64url: string; privPath: string; backupPath: string }> {
  const { agentId, keysDir, opsPort, httpPort, adminPass } = opts;
  const adminUser = "admin";

  mkdirSync(keysDir, { recursive: true });
  const privPath = join(keysDir, `${agentId}.key`);
  const pubPath = join(keysDir, `${agentId}.pub`);
  const backupPath = privPath + ".bak";

  // Generate new keypair
  const kp = nacl.sign.keyPair();
  const newSeed = kp.secretKey.slice(0, 32);
  const newPubKeyB64url = b64url(kp.publicKey);

  // Back up old key if it exists
  if (existsSync(privPath)) {
    writeFileSync(backupPath, readFileSync(privPath));
    chmodSync(backupPath, 0o600);
  }

  // Update in Flair via operations API
  const opsUrl = `http://127.0.0.1:${opsPort}/`;
  const auth = Buffer.from(`${adminUser}:${adminPass}`).toString("base64");
  const updateBody = {
    operation: "update",
    database: "flair",
    table: "Agent",
    records: [{ id: agentId, publicKey: newPubKeyB64url, updatedAt: new Date().toISOString() }],
  };
  const updateRes = await fetch(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify(updateBody),
    signal: AbortSignal.timeout(5000),
  });
  if (!updateRes.ok) {
    const text = await updateRes.text().catch(() => "");
    throw new Error(`Failed to update public key (${updateRes.status}): ${text}`);
  }

  // Write new key (only after successful Flair update)
  writeFileSync(privPath, Buffer.from(newSeed));
  chmodSync(privPath, 0o600);
  writeFileSync(pubPath, Buffer.from(kp.publicKey));

  // Verify auth works
  const verifyRes = await fetch(`http://127.0.0.1:${httpPort}/Agent/${agentId}`, {
    // Simple test — just check server responds
    signal: AbortSignal.timeout(3000),
  });
  if (!verifyRes.ok && verifyRes.status !== 401) {
    throw new Error(`Verification request failed: ${verifyRes.status}`);
  }

  return { newPubKeyB64url, privPath, backupPath };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("plugin key resolution", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("prefers explicit config keyPath when it exists", () => {
    const configPath = join(tmpDir, "explicit.key");
    writeFileSync(configPath, Buffer.alloc(32, 0x01));

    const result = resolveKey("agent1", {
      configKeyPath: configPath,
      newStandardDir: tmpDir,
      legacyDir: tmpDir,
    });
    expect(result.source).toBe("config");
    expect(result.path).toBe(configPath);
  });

  it("uses FLAIR_KEY_DIR when set and key exists", () => {
    const envDir = join(tmpDir, "env-keys");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "agent1.key"), Buffer.alloc(32, 0x02));

    const result = resolveKey("agent1", {
      flairKeyDir: envDir,
      newStandardDir: join(tmpDir, "standard"),
      legacyDir: tmpDir,
    });
    expect(result.source).toBe("env");
    expect(result.path).toBe(join(envDir, "agent1.key"));
  });

  it("falls back to new standard path ~/.flair/keys/<agent>.key", () => {
    const standardDir = join(tmpDir, "standard");
    mkdirSync(standardDir, { recursive: true });
    writeFileSync(join(standardDir, "agent1.key"), Buffer.alloc(32, 0x03));

    const result = resolveKey("agent1", {
      newStandardDir: standardDir,
      legacyDir: join(tmpDir, "legacy"),
    });
    expect(result.source).toBe("standard");
    expect(result.path).toBe(join(standardDir, "agent1.key"));
  });

  it("falls back to legacy path when standard not present", () => {
    const legacyDir = join(tmpDir, "legacy");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "agent1-priv.key"), Buffer.alloc(32, 0x04));

    const result = resolveKey("agent1", {
      newStandardDir: join(tmpDir, "empty-standard"),
      legacyDir,
    });
    expect(result.source).toBe("legacy");
    expect(result.path).toContain("agent1-priv.key");
  });

  it("returns null when no key found anywhere", () => {
    const result = resolveKey("agent1", {
      newStandardDir: join(tmpDir, "noexist1"),
      legacyDir: join(tmpDir, "noexist2"),
    });
    expect(result.path).toBeNull();
    expect(result.source).toBeNull();
  });

  it("FLAIR_KEY_DIR takes priority over standard path", () => {
    const envDir = join(tmpDir, "env-keys");
    const standardDir = join(tmpDir, "standard");
    mkdirSync(envDir, { recursive: true });
    mkdirSync(standardDir, { recursive: true });
    writeFileSync(join(envDir, "agent1.key"), Buffer.alloc(32, 0xAA));
    writeFileSync(join(standardDir, "agent1.key"), Buffer.alloc(32, 0xBB));

    const result = resolveKey("agent1", {
      flairKeyDir: envDir,
      newStandardDir: standardDir,
      legacyDir: tmpDir,
    });
    expect(result.source).toBe("env");
  });

  it("standard path takes priority over legacy path", () => {
    const standardDir = join(tmpDir, "standard");
    const legacyDir = join(tmpDir, "legacy");
    mkdirSync(standardDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(standardDir, "agent1.key"), Buffer.alloc(32, 0xAA));
    writeFileSync(join(legacyDir, "agent1-priv.key"), Buffer.alloc(32, 0xBB));

    const result = resolveKey("agent1", {
      newStandardDir: standardDir,
      legacyDir,
    });
    expect(result.source).toBe("standard");
  });
});

describe("agent rotate-key", () => {
  let tmpDir: string;
  let opsServer: { server: Server; url: string; port: number };
  let httpServer: { server: Server; url: string; port: number };
  let opsRequests: Array<{ method: string; path: string; body: string }> = [];

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    opsRequests = [];

    opsServer = await startMockServer((req, body, res) => {
      opsRequests.push({ method: req.method ?? "GET", path: req.url ?? "/", body });
      jsonRes(res, 200, { updated_hashes: 1 });
    });

    httpServer = await startMockServer((_req, _body, res) => {
      jsonRes(res, 200, { id: "test-agent" });
    });
  });

  afterEach(async () => {
    await stopServer(opsServer.server);
    await stopServer(httpServer.server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a new 32-byte keypair", async () => {
    const keysDir = join(tmpDir, "keys");
    const result = await rotateKey({
      agentId: "test-agent",
      keysDir,
      opsPort: opsServer.port,
      httpPort: httpServer.port,
      adminPass: "test123",
    });

    const newSeed = readFileSync(result.privPath);
    expect(newSeed.length).toBe(32);
    expect(result.newPubKeyB64url).toBeTruthy();
    const pubBytes = Buffer.from(result.newPubKeyB64url, "base64url");
    expect(pubBytes.length).toBe(32);
  });

  it("backs up old key before writing new one", async () => {
    const keysDir = join(tmpDir, "keys");
    mkdirSync(keysDir, { recursive: true });
    const privPath = join(keysDir, "test-agent.key");
    const oldSeed = Buffer.alloc(32, 0x99);
    writeFileSync(privPath, oldSeed);

    const result = await rotateKey({
      agentId: "test-agent",
      keysDir,
      opsPort: opsServer.port,
      httpPort: httpServer.port,
      adminPass: "test123",
    });

    expect(existsSync(result.backupPath)).toBe(true);
    const backedUp = readFileSync(result.backupPath);
    expect(backedUp.equals(oldSeed)).toBe(true);
  });

  it("sends update operation to ops API with new public key", async () => {
    const keysDir = join(tmpDir, "keys");
    const result = await rotateKey({
      agentId: "test-agent",
      keysDir,
      opsPort: opsServer.port,
      httpPort: httpServer.port,
      adminPass: "test123",
    });

    expect(opsRequests).toHaveLength(1);
    const body = JSON.parse(opsRequests[0].body);
    expect(body.operation).toBe("update");
    expect(body.table).toBe("Agent");
    expect(body.records[0].id).toBe("test-agent");
    expect(body.records[0].publicKey).toBe(result.newPubKeyB64url);
  });

  it("uses Basic auth for operations API", async () => {
    const authHeaders: string[] = [];
    await stopServer(opsServer.server);
    opsServer = await startMockServer((req, body, res) => {
      authHeaders.push(req.headers.authorization ?? "");
      opsRequests.push({ method: req.method ?? "GET", path: req.url ?? "/", body });
      jsonRes(res, 200, { updated_hashes: 1 });
    });

    const keysDir = join(tmpDir, "keys");
    await rotateKey({
      agentId: "test-agent",
      keysDir,
      opsPort: opsServer.port,
      httpPort: httpServer.port,
      adminPass: "rotatepass",
    });

    expect(authHeaders.length).toBeGreaterThan(0);
    const decoded = Buffer.from(authHeaders[0].replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe("admin:rotatepass");
  });

  it("does not write new key if ops API fails", async () => {
    await stopServer(opsServer.server);
    opsServer = await startMockServer((_req, _body, res) => {
      jsonRes(res, 500, { error: "internal error" });
    });

    const keysDir = join(tmpDir, "keys");
    const privPath = join(keysDir, "test-agent.key");

    await expect(rotateKey({
      agentId: "test-agent",
      keysDir,
      opsPort: opsServer.port,
      httpPort: httpServer.port,
      adminPass: "test123",
    })).rejects.toThrow("500");

    // Key file should not exist (ops failed before write)
    expect(existsSync(privPath)).toBe(false);
  });

  it("new key differs from old key", async () => {
    const keysDir = join(tmpDir, "keys");
    mkdirSync(keysDir, { recursive: true });
    const privPath = join(keysDir, "test-agent.key");
    const oldSeed = Buffer.alloc(32, 0x42);
    writeFileSync(privPath, oldSeed);

    await rotateKey({
      agentId: "test-agent",
      keysDir,
      opsPort: opsServer.port,
      httpPort: httpServer.port,
      adminPass: "test123",
    });

    const newSeed = readFileSync(privPath);
    expect(newSeed.equals(oldSeed)).toBe(false);
  });
});
