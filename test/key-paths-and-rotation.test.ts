/**
 * key-paths-and-rotation.test.ts
 *
 * Tests for:
 *   1. Plugin key resolution order (FLAIR_KEY_DIR > ~/.flair/keys > legacy paths)
 *   2. `flair agent rotate-key` through the real command (flair#3077 slice B)
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync,
  fstatSync, readdirSync, statSync, symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";
import { program } from "../src/cli.js";
import { setAgentKeyFileTestHooks } from "../src/lib/agent-key-file.js";

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

function newPair(): { seed: Buffer; publicKey: string } {
  const kp = nacl.sign.keyPair();
  return { seed: Buffer.from(kp.secretKey.slice(0, 32)), publicKey: b64url(kp.publicKey) };
}

function publicKeyOfSeed(seed: Buffer): string {
  return b64url(nacl.sign.keyPair.fromSeed(seed).publicKey);
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function backupsOf(keysDir: string, id: string): string[] {
  return readdirSync(keysDir)
    .filter((name) => name.startsWith(`${id}.key.bak.`))
    .map((name) => join(keysDir, name))
    .sort();
}

function stagedOf(keysDir: string): string[] {
  return readdirSync(keysDir)
    .filter((name) => name.includes(".tmp-"))
    .map((name) => join(keysDir, name));
}

/** Run the real `flair agent rotate-key` command and capture its result. */
async function runRotate(opts: {
  id: string;
  keysDir: string;
  opsPort: number;
  httpPort: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  });
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  let code = 0;
  try {
    await program.parseAsync([
      "node",
      "flair",
      "agent",
      "rotate-key",
      opts.id,
      "--ops-port",
      String(opts.opsPort),
      "--port",
      String(opts.httpPort),
      "--admin-pass",
      "throwaway-admin-pass-not-a-secret",
      "--keys-dir",
      opts.keysDir,
    ]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/^process\.exit\((\d+)\)$/);
    if (!match) throw err;
    code = Number(match[1]);
  } finally {
    process.exit = origExit;
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
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

describe("agent rotate-key (real command)", () => {
  const id = "agent-a";
  let tmpDir: string;
  let keysDir: string;
  let privPath: string;
  let pubPath: string;
  let opsServer: { server: Server; url: string; port: number };
  let httpServer: { server: Server; url: string; port: number };
  let opsMode: "update-ok" | "update-500" | "update-no-change";
  let storedPublicKey: string;
  let updateBodies: any[];
  let authHeaders: string[];
  let opsRequestCount: number;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    keysDir = join(tmpDir, "keys");
    mkdirSync(keysDir, { recursive: true });
    privPath = join(keysDir, `${id}.key`);
    pubPath = join(keysDir, `${id}.pub`);
    opsMode = "update-ok";
    storedPublicKey = "";
    updateBodies = [];
    authHeaders = [];
    opsRequestCount = 0;

    opsServer = await startMockServer((req, body, res) => {
      opsRequestCount += 1;
      authHeaders.push(req.headers.authorization ?? "");
      let parsed: any = {};
      try { parsed = JSON.parse(body || "{}"); } catch { return jsonRes(res, 400, { error: "bad json" }); }
      if (parsed.operation === "update" && parsed.table === "Agent") {
        updateBodies.push(parsed);
        if (opsMode === "update-500") return jsonRes(res, 500, { error: "refused" });
        if (opsMode === "update-ok") storedPublicKey = String(parsed.records[0].publicKey);
        return jsonRes(res, 200, { updated_hashes: opsMode === "update-ok" ? 1 : 0 });
      }
      if (parsed.operation === "search_by_value" && parsed.table === "Agent") {
        return jsonRes(res, 200, [{ id: parsed.search_value, name: parsed.search_value, publicKey: storedPublicKey }]);
      }
      return jsonRes(res, 200, {});
    });

    httpServer = await startMockServer((_req, _body, res) => {
      jsonRes(res, 200, { id });
    });
  });

  afterEach(async () => {
    setAgentKeyFileTestHooks(undefined);
    await stopServer(opsServer.server);
    await stopServer(httpServer.server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedCurrentKey(mode = 0o600): Buffer {
    const pair = newPair();
    writeFileSync(privPath, pair.seed);
    chmodSync(privPath, mode);
    storedPublicKey = pair.publicKey;
    return pair.seed;
  }

  it("(a) an existing 0644 key rotates to 0600: the new key and backup are created 0600; the warning prints", async () => {
    const oldSeed = seedCurrentKey(0o644);
    const observedModes: number[] = [];
    setAgentKeyFileTestHooks({
      beforeFirstWrite: (fd) => { observedModes.push(fstatSync(fd).mode & 0o777); },
    });

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("readable by other users and is being replaced");
    expect(observedModes.length).toBeGreaterThanOrEqual(2);
    expect(observedModes.every((mode) => mode === 0o600)).toBe(true);
    expect(modeOf(privPath)).toBe(0o600);
    const newSeed = readFileSync(privPath);
    expect(newSeed.length).toBe(32);
    expect(newSeed.equals(oldSeed)).toBe(false);
    const backups = backupsOf(keysDir, id);
    expect(backups.length).toBe(1);
    expect(modeOf(backups[0])).toBe(0o600);
    expect(readFileSync(backups[0]).equals(oldSeed)).toBe(true);

    expect(updateBodies.length).toBe(1);
    expect(updateBodies[0].records[0].publicKey).toBe(publicKeyOfSeed(newSeed));
    const decoded = Buffer.from(authHeaders[0].replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe("admin:throwaway-admin-pass-not-a-secret");
  });

  it("(b) an occupied <key>.bak and an earlier timestamped backup stay byte-identical; a new backup is written", async () => {
    const oldSeed = seedCurrentKey();
    const legacyBak = `${privPath}.bak`;
    const earlierBak = `${privPath}.bak.2020-01-01T00-00-00-000Z`;
    const legacyBytes = Buffer.alloc(32, 0xAA);
    const earlierBytes = Buffer.alloc(32, 0xBB);
    writeFileSync(legacyBak, legacyBytes);
    writeFileSync(earlierBak, earlierBytes);

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(0);
    expect(readFileSync(legacyBak).equals(legacyBytes)).toBe(true);
    expect(readFileSync(earlierBak).equals(earlierBytes)).toBe(true);
    const backups = backupsOf(keysDir, id).filter((p) => p !== earlierBak);
    expect(backups.length).toBe(1);
    expect(readFileSync(backups[0]).equals(oldSeed)).toBe(true);
  });

  it("(c) Flair refuses the update: the current key is byte-identical and the staged 0600 key is kept and named", async () => {
    const oldSeed = seedCurrentKey();
    opsMode = "update-500";

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
    const staged = stagedOf(keysDir);
    expect(staged.length).toBe(1);
    expect(modeOf(staged[0])).toBe(0o600);
    expect(result.stderr).toContain(staged[0]);
    expect(result.stderr).toContain("Flair may now hold the new public key");
    expect(result.stderr).toContain("is unchanged");
  });

  it("(d) a 2xx update that changes no row is a failure; the current key is byte-identical and the staged key is kept", async () => {
    const oldSeed = seedCurrentKey();
    opsMode = "update-no-change";

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
    const staged = stagedOf(keysDir);
    expect(staged.length).toBe(1);
    expect(modeOf(staged[0])).toBe(0o600);
    expect(result.stderr).toContain("does not match the new key");
  });

  it("(e) a failed rename keeps the staged key, 0600, and its public key is the one Flair stored", async () => {
    const oldSeed = seedCurrentKey();
    setAgentKeyFileTestHooks({
      beforePublish: (_tempPath, finalPath) => {
        if (finalPath === privPath) throw new Error("rename refused in test");
      },
    });

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
    const staged = stagedOf(keysDir);
    expect(staged.length).toBe(1);
    expect(modeOf(staged[0])).toBe(0o600);
    expect(publicKeyOfSeed(readFileSync(staged[0]))).toBe(storedPublicKey);
    expect(result.stderr).toContain(staged[0]);
  });

  it("(f) a public-key write failure after the rename says the private key was already replaced and names the backup", async () => {
    seedCurrentKey();
    mkdirSync(pubPath, { recursive: true });

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    const backups = backupsOf(keysDir, id);
    expect(backups.length).toBe(1);
    expect(result.stderr).toContain("was already replaced");
    expect(result.stderr).toContain(backups[0]);
  });

  it("(g) a symlinked current key is refused and its target is unchanged", async () => {
    const target = join(tmpDir, "target.key");
    const pair = newPair();
    writeFileSync(target, pair.seed);
    symlinkSync(target, privPath);

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is a symlink");
    expect(readFileSync(target).equals(pair.seed)).toBe(true);
    expect(stagedOf(keysDir).length).toBe(0);
    expect(opsRequestCount).toBe(0);
  });
});
