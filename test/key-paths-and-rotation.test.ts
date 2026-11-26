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
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import nacl from "tweetnacl";
import { program } from "../src/cli.js";
import { setAgentKeyFileTestHooks } from "../src/lib/agent-key-file.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-keyrot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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
      "--admin-user",
      "admin",
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

describe("agent rotate-key (real command, POSIX)", () => {
  const id = "agent-a";
  let tmpDir: string;
  let keysDir: string;
  let privPath: string;
  let pubPath: string;
  const opsServer = { port: 19101 };
  const httpServer = { port: 19102 };
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let restoreFixture: (() => void) | undefined;
  let stagedInode: number;
  let stagedBytes: Buffer;
  let opsMode: "update-ok" | "update-500" | "update-no-change" | "transport-failure" | "read-failure";
  let storedPublicKey: string;
  let updateBodies: any[];
  let authHeaders: string[];
  let requestCount: number;
  let rotationEvents: string[];

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
    requestCount = 0;
    rotationEvents = [];

    stagedInode = 0;
    stagedBytes = Buffer.alloc(0);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      requestCount += 1;
      const url = String(input);
      if (url.startsWith(`http://127.0.0.1:${httpServer.port}/`)) {
        return Response.json({ id });
      }
      expect(url).toBe(`http://127.0.0.1:${opsServer.port}/`);
      authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
      const parsed = JSON.parse(String(init?.body));
      if (parsed.operation === "update" && parsed.table === "Agent") {
        rotationEvents.push("update");
        updateBodies.push(parsed);
        const staged = stagedOf(keysDir);
        expect(staged).toHaveLength(1);
        stagedBytes = readFileSync(staged[0]);
        expect(publicKeyOfSeed(stagedBytes)).toBe(parsed.records[0].publicKey);
        if (process.platform !== "win32") expect(modeOf(staged[0])).toBe(0o600);
        stagedInode = Number(statSync(staged[0]).ino);
        if (opsMode === "update-500") return Response.json({ error: "refused" }, { status: 500 });
        if (opsMode !== "update-no-change") storedPublicKey = String(parsed.records[0].publicKey);
        if (opsMode === "transport-failure") throw new TypeError("update response unavailable");
        return Response.json({ updated_hashes: opsMode === "update-no-change" ? 0 : 1 });
      }
      expect(parsed.operation).toBe("search_by_value");
      if (opsMode === "read-failure") return new Response("read unavailable", { status: 503 });
      return Response.json([{ id: parsed.search_value, name: parsed.search_value, publicKey: storedPublicKey }]);
    }) as typeof fetch);
  });

  afterEach(() => {
    restoreFixture?.();
    restoreFixture = undefined;
    setAgentKeyFileTestHooks(undefined);
    fetchSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedCurrentKey(mode = 0o600): Buffer {
    const pair = newPair();
    writeFileSync(privPath, pair.seed);
    chmodSync(privPath, mode);
    storedPublicKey = pair.publicKey;
    return pair.seed;
  }

  it("rotates without hard links and preserves occupied backups", async () => {
    const oldSeed = seedCurrentKey();
    const legacy = `${privPath}.bak`;
    const earlier = `${privPath}.bak.2020-01-01T00-00-00-000Z`;
    writeFileSync(legacy, "legacy");
    writeFileSync(earlier, "earlier");
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" });
    });
    restoreFixture = () => link.mockRestore();

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(0);
    expect(link).not.toHaveBeenCalled();
    const backups = backupsOf(keysDir, id).filter(path => path !== earlier);
    expect(backups).toHaveLength(1);
    expect(readFileSync(backups[0]).equals(oldSeed)).toBe(true);
    if (process.platform !== "win32") expect(modeOf(backups[0])).toBe(0o600);
    expect(readFileSync(legacy, "utf8")).toBe("legacy");
    expect(readFileSync(earlier, "utf8")).toBe("earlier");
    expect(publicKeyOfSeed(readFileSync(privPath))).toBe(storedPublicKey);
    expect(Number(statSync(privPath).ino)).toBe(stagedInode);
    expect(updateBodies).toHaveLength(1);
    expect(stagedOf(keysDir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("syncs the staged directory before the update and the installed directory after rename", async () => {
    const oldSeed = seedCurrentKey();
    let syncs = 0;
    setAgentKeyFileTestHooks({
      syncKeysDir: (fd) => {
        expect(fstatSync(fd).isDirectory()).toBe(true);
        if (++syncs === 1) {
          expect(stagedOf(keysDir)).toHaveLength(1);
          expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
          rotationEvents.push("staged sync");
        } else {
          expect(stagedOf(keysDir)).toEqual([]);
          expect(Number(statSync(privPath).ino)).toBe(stagedInode);
          expect(publicKeyOfSeed(readFileSync(privPath))).toBe(storedPublicKey);
          rotationEvents.push("installed sync");
        }
        fs.fsyncSync(fd);
      },
      beforePublish: () => { rotationEvents.push("rename"); },
    });

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(0);
    expect(syncs).toBe(2);
    expect(rotationEvents).toEqual(["staged sync", "update", "rename", "installed sync"]);
  });

  for (const missing of [1, 3, "dotdot"] as const) {
    it.skipIf(process.platform === "win32")(`syncs created-directory parents before the update (${missing})`, async () => {
      rmSync(keysDir, { recursive: true });
      keysDir = missing === "dotdot"
        ? `${tmpDir}/detour/../keys`
        : join(tmpDir, ...Array.from({ length: missing }, (_, i) => `missing-${i}`));
      privPath = join(keysDir, `${id}.key`);
      const parents: string[] = missing === "dotdot" ? [`${tmpDir}/detour/..`, tmpDir] : [];
      if (missing !== "dotdot") {
        for (let created = keysDir; created !== tmpDir; created = dirname(created)) {
          parents.push(dirname(created));
        }
      }
      const directories = [...parents, keysDir, keysDir];
      let syncs = 0;
      setAgentKeyFileTestHooks({
        syncKeysDir: (fd) => {
          const actual = fstatSync(fd);
          const expected = statSync(directories[syncs]);
          expect(actual.isDirectory()).toBe(true);
          expect([actual.dev, actual.ino]).toEqual([expected.dev, expected.ino]);
          rotationEvents.push(`sync ${directories[syncs++]}`);
          fs.fsyncSync(fd);
        },
        beforePublish: () => { rotationEvents.push("rename"); },
      });

      const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

      expect(result.code).toBe(0);
      expect(syncs).toBe(directories.length);
      expect(rotationEvents).toEqual([
        ...parents.map(parent => `sync ${parent}`), `sync ${keysDir}`, "update", "rename", `sync ${keysDir}`,
      ]);
      expect(publicKeyOfSeed(readFileSync(privPath))).toBe(storedPublicKey);
    });
  }

  it.skipIf(process.platform === "win32")("refuses a failed created-directory parent sync before sending an update", async () => {
    rmSync(keysDir, { recursive: true });
    let syncs = 0;
    setAgentKeyFileTestHooks({ syncKeysDir: (fd) => {
      const actual = fstatSync(fd);
      const parent = statSync(tmpDir);
      expect(actual.isDirectory()).toBe(true);
      expect([actual.dev, actual.ino]).toEqual([parent.dev, parent.ino]);
      syncs += 1;
      throw new Error("parent sync fixture failure");
    } });

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    expect(syncs).toBe(1);
    expect(requestCount).toBe(0);
    expect(updateBodies).toHaveLength(0);
    expect(existsSync(privPath)).toBe(false);
    expect(result.stderr).toContain(`flair could not sync parent directory ${tmpDir}`);
    expect(result.stderr).toContain(`new keys directory ${keysDir} is not confirmed durable`);
    expect(result.stderr).toContain("check the directory and filesystem, then retry");
  });

  it.skipIf(process.platform === "win32")("refuses a failed staging directory sync before sending an update", async () => {
    const oldSeed = seedCurrentKey();
    let syncs = 0;
    setAgentKeyFileTestHooks({ syncKeysDir: () => {
      syncs += 1;
      throw new Error("directory sync fixture failure");
    } });

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    expect(syncs).toBe(1);
    expect(requestCount).toBe(0);
    expect(updateBodies).toHaveLength(0);
    expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
    expect(stagedOf(keysDir)).toEqual([]);
    expect(result.stderr).toContain(`flair could not sync keys directory ${keysDir}`);
    expect(result.stderr).toContain("No update was sent; the current key is unchanged");
    expect(result.stderr).toContain("check the directory and filesystem, then retry rotation");
  });

  it.skipIf(process.platform === "win32")("warns after an installed directory sync fails and keeps the new key in place", async () => {
    seedCurrentKey();
    let syncs = 0;
    setAgentKeyFileTestHooks({ syncKeysDir: (fd) => {
      if (++syncs === 2) throw new Error("installed directory sync fixture failure");
      fs.fsyncSync(fd);
    } });

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(0);
    expect(syncs).toBe(2);
    expect(publicKeyOfSeed(readFileSync(privPath))).toBe(storedPublicKey);
    expect(stagedOf(keysDir)).toEqual([]);
    expect(result.stderr).toContain(`Warning: flair could not sync keys directory ${keysDir}`);
    expect(result.stderr).toContain(`the new private key is in place at ${privPath}`);
  });

  it("refuses a backup that fails the read-back check before sending an update", async () => {
    const oldSeed = seedCurrentKey();
    setAgentKeyFileTestHooks({ writeSeedFile: (fd, bytes) => fs.writeSync(fd, Buffer.alloc(bytes.length)) });

    await expect(runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port }))
      .rejects.toThrow("does not match the current key");

    expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
    expect(backupsOf(keysDir, id)).toEqual([]);
    expect(requestCount).toBe(0);
  });

  it("(a) replaces the current key and backs it up; checks POSIX modes and warning", async () => {
    const oldSeed = seedCurrentKey(0o644);
    const observedModes: number[] = [];
    setAgentKeyFileTestHooks({
      beforeFirstWrite: (fd) => { observedModes.push(fstatSync(fd).mode & 0o777); },
    });

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(0);
    if (process.platform !== "win32") expect(result.stdout).toContain("has group or world permission bits and is being replaced");
    expect(observedModes.length).toBeGreaterThanOrEqual(2);
    if (process.platform !== "win32") expect(observedModes.every((mode) => mode === 0o600)).toBe(true);
    expect(Number(statSync(privPath).ino)).toBe(stagedInode);
    if (process.platform !== "win32") expect(modeOf(privPath)).toBe(0o600);
    expect(readFileSync(privPath).equals(stagedBytes)).toBe(true);
    const newSeed = readFileSync(privPath);
    expect(newSeed.length).toBe(32);
    expect(newSeed.equals(oldSeed)).toBe(false);
    const backups = backupsOf(keysDir, id);
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    if (process.platform !== "win32") expect(modeOf(backups[0])).toBe(0o600);
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

  it("(c) Flair refuses the update: the current key is byte-identical and the staged key is kept and named", async () => {
    const oldSeed = seedCurrentKey();
    opsMode = "update-500";

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
    const staged = stagedOf(keysDir);
    expect(staged.length).toBe(1);
    if (process.platform !== "win32") expect(modeOf(staged[0])).toBe(0o600);
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
    if (process.platform !== "win32") expect(modeOf(staged[0])).toBe(0o600);
    expect(result.stderr).toContain("does not match the new key");
  });

  it("(e) a failed rename keeps the staged key and its public key is the one Flair stored", async () => {
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
    if (process.platform !== "win32") expect(modeOf(staged[0])).toBe(0o600);
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

  it("(g) on POSIX a symlinked current key is refused and its target is unchanged", async () => {
    const target = join(tmpDir, "target.key");
    const pair = newPair();
    writeFileSync(target, pair.seed);
    symlinkSync(target, privPath);

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is a symlink");
    expect(readFileSync(target).equals(pair.seed)).toBe(true);
    expect(stagedOf(keysDir).length).toBe(0);
    expect(requestCount).toBe(0);
  });
  it("refuses the backup name selected by a fixed UTC clock", async () => {
    const oldSeed = seedCurrentKey();
    const clock = spyOn(Date.prototype, "toISOString").mockReturnValue("2031-02-03T04:05:06.007Z");
    restoreFixture = () => clock.mockRestore();
    const backup = `${privPath}.bak.2031-02-03T04-05-06-007Z`;
    const occupied = Buffer.alloc(32, 0xA7);
    writeFileSync(backup, occupied);

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
    expect(readFileSync(backup).equals(occupied)).toBe(true);
    expect(backupsOf(keysDir, id)).toEqual([backup]);
    expect(stagedOf(keysDir)).toEqual([]);
    expect(result.stderr).toContain(backup);
    expect(requestCount).toBe(0);
    expect(updateBodies).toHaveLength(0);
  });

  it("a staging failure leaves the current key and backup and sends no request", async () => {
    const oldSeed = seedCurrentKey();
    let writes = 0;
    setAgentKeyFileTestHooks({ beforeFirstWrite: () => {
      if (++writes === 2) throw new Error("staging fixture failure");
    } });

    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

    expect(result.code).toBe(1);
    expect(writes).toBe(2);
    expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
    expect(stagedOf(keysDir)).toEqual([]);
    expect(result.stderr).toContain(privPath);
    expect(result.stderr).toContain("could not stage");
    expect(backupsOf(keysDir, id)).toHaveLength(1);
    expect(readFileSync(backupsOf(keysDir, id)[0]).equals(oldSeed)).toBe(true);
    expect(requestCount).toBe(0);
    expect(updateBodies).toHaveLength(0);
  });

  for (const failure of ["transport-failure", "read-failure"] as const) {
    it(`keeps and names the staged key after ${failure}`, async () => {
      const oldSeed = seedCurrentKey();
      opsMode = failure;

      const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });

      expect(result.code).toBe(1);
      expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
      const staged = stagedOf(keysDir);
      expect(staged).toHaveLength(1);
      expect(readFileSync(staged[0]).equals(stagedBytes)).toBe(true);
      if (process.platform !== "win32") expect(modeOf(staged[0])).toBe(0o600);
      expect(publicKeyOfSeed(stagedBytes)).toBe(storedPublicKey);
      expect(result.stderr).toContain(staged[0]);
      expect(result.stderr).toContain(privPath);
      expect(requestCount).toBe(failure === "transport-failure" ? 1 : 2);
      expect(updateBodies).toHaveLength(1);
    });
  }

  for (const recovery of ["move", "delete"] as const) {
    it(`runs the printed ${recovery} recovery commands through sh`, async () => {
      keysDir = join(tmpDir, "keys space ' $ ; `");
      mkdirSync(keysDir);
      privPath = join(keysDir, `${id}.key`);
      pubPath = join(keysDir, `${id}.pub`);
      const oldSeed = seedCurrentKey();
      const sentinel = join(tmpDir, "sentinel");
      writeFileSync(sentinel, "keep");
      opsMode = recovery === "move" ? "transport-failure" : "update-500";
      const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });
      expect(result.code).toBe(1);
      const staged = stagedOf(keysDir);
      expect(staged).toHaveLength(1);
      const seed = readFileSync(staged[0]);
      const quoted = (path: string) => "'" + path.split("'").join("'\\''") + "'";
      const move = `mv -- ${quoted(staged[0])} ${quoted(privPath)}`;
      const chmod = `chmod -- 600 ${quoted(privPath)}`;
      const remove = `rm -- ${quoted(staged[0])}`;
      expect(result.stderr).toContain(`place: ${move}, then ${chmod}.`);
      expect(result.stderr).toContain(`file: ${remove}.`);
      const printedMove = result.stderr.split("place: ")[1].split(", then ")[0];
      const printedChmod = result.stderr.split(", then ")[1].split(". If it does not")[0];
      const printedRemove = result.stderr.split("delete the staged file: ")[1].slice(0, -1);
      const entriesBefore = readdirSync(keysDir).filter(name => !name.includes(".tmp-")).sort();
      const command = recovery === "move" ? `${printedMove} && ${printedChmod}` : printedRemove;
      const shell = spawnSync("sh", ["-c", 'eval "$FLAIR_TEST_RECOVERY_COMMAND"'], {
        cwd: tmpDir, encoding: "utf8", timeout: 2_000,
        env: {
          ...process.env, FLAIR_TEST_RECOVERY_COMMAND: command,
          FLAIR_TEST_ALLOW_BUN_HARPER: "Exercise printed recovery commands through the POSIX shell",
        },
      });
      expect(shell.stderr).toBe("");
      expect(shell.status).toBe(0);
      expect(existsSync(staged[0])).toBe(false);
      expect(readFileSync(privPath).equals(recovery === "move" ? seed : oldSeed)).toBe(true);
      expect(publicKeyOfSeed(readFileSync(privPath))).toBe(storedPublicKey);
      if (process.platform !== "win32") expect(modeOf(privPath)).toBe(0o600);
      expect(readdirSync(keysDir).sort()).toEqual(entriesBefore);
      expect(readFileSync(sentinel, "utf8")).toBe("keep");
      expect(readdirSync(tmpDir).sort()).toEqual(["keys", "keys space ' $ ; `", "sentinel"].sort());
    });
  }

  it("tightens a wide-mode keys directory before the request", async () => {
    seedCurrentKey();
    chmodSync(keysDir, 0o755);
    setAgentKeyFileTestHooks({ beforeFirstWrite: () => {
      if (process.platform !== "win32") expect(modeOf(keysDir)).toBe(0o700);
    } });
    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });
    expect(result.code).toBe(0);
    if (process.platform !== "win32") expect(modeOf(keysDir)).toBe(0o700);
    expect(updateBodies).toHaveLength(1);
  });

  it("on POSIX refuses a symlinked keys directory before a request", async () => {
    const oldSeed = seedCurrentKey();
    const realKeysDir = keysDir;
    keysDir = join(tmpDir, "linked-keys");
    symlinkSync(realKeysDir, keysDir);
    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is a symlink");
    expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
    expect(readdirSync(realKeysDir)).toEqual([`${id}.key`]);
    expect(requestCount).toBe(0);
  });

  it("refuses a non-regular current key before a request", async () => {
    mkdirSync(privPath);
    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a regular file");
    expect(statSync(privPath).isDirectory()).toBe(true);
    expect(stagedOf(keysDir)).toEqual([]);
    expect(requestCount).toBe(0);
  });

  it("refuses a foreign owner from the opened descriptor before a request", async () => {
    const oldSeed = seedCurrentKey();
    const originalFstat = fs.fstatSync;
    const fixture = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const st = originalFstat(fd);
      Object.defineProperty(st, "uid", { value: process.getuid!() + 1 });
      return st;
    }) as typeof fs.fstatSync);
    restoreFixture = () => fixture.mockRestore();
    const result = await runRotate({ id, keysDir, opsPort: opsServer.port, httpPort: httpServer.port });
    expect(result.code).toBe(1);
    expect(fixture).toHaveBeenCalled();
    expect(result.stderr).toContain("owned by another user");
    expect(readFileSync(privPath).equals(oldSeed)).toBe(true);
    expect(stagedOf(keysDir)).toEqual([]);
    expect(requestCount).toBe(0);
  });

});
