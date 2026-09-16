/**
 * init-admin-pass-persisted.test.ts — flair#837
 *
 * `flair init` with ~/.flair/admin-pass missing and Harper already holding a
 * persisted admin user used to generate a fresh file. HDB_ADMIN_PASSWORD
 * does not rotate a stored hash, so the instance 401'd on the next ops call.
 *
 * Decision + detection + refusal text + ops-socket alter_user are pure /
 * locally mocked here. No live Harper.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveInitAdminPasswordSource,
  resolveInitAdminPasswordRefuseReason,
  detectPersistedAdminUser,
  initAdminPassRefusalMessage,
  adminPassDesyncFinding,
  callOpsSocket,
  rotateAdminPasswordViaOpsSocket,
  prepareAdminPasswordRotate,
  formatAdminPasswordRotatePreflight,
  assertExplicitAdminPasswordRotate,
  isOwnerOnlyOpsSocketPosture,
  waitForOpsSocketReady,
  executeAdminPasswordRotate,
  INIT_RESET_ADMIN_PASS_COMMAND,
  INIT_ADMIN_PASS_FILE_COMMAND,
  INIT_STOP_FOREIGN_COMMAND,
  ADMIN_PASS_DESYNC_REMEDY,
} from "../../src/lib/init-admin-pass.ts";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-837-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("resolveInitAdminPasswordSource — flair#837 persisted user", () => {
  test("one-arg form keeps the #827 contract", () => {
    expect(resolveInitAdminPasswordSource(true)).toBe("reuse-existing");
    expect(resolveInitAdminPasswordSource(false)).toBe("generate-new");
  });

  test("FAILS-FIRST: persisted user + missing file is not generate-new", () => {
    expect(resolveInitAdminPasswordSource(false, { persistedAdminUser: true })).not.toBe("generate-new");
  });

  test("bare init against a persisted user refuses (does not guess)", () => {
    expect(resolveInitAdminPasswordSource(false, { persistedAdminUser: true })).toBe("refuse");
    expect(resolveInitAdminPasswordRefuseReason(false, { persistedAdminUser: true })).toBe("persisted-missing-file");
  });

  test("socket available without --reset-admin-pass is still refuse, never rotate", () => {
    expect(resolveInitAdminPasswordSource(false, {
      persistedAdminUser: true,
      opsSocketAvailable: true,
    })).toBe("refuse");
  });

  test("explicit credential + persisted user re-persists the file", () => {
    expect(resolveInitAdminPasswordSource(false, {
      persistedAdminUser: true,
      explicitCredential: true,
    })).toBe("re-persist");
  });

  test("--reset-admin-pass + socket available rotates via alter_user", () => {
    expect(resolveInitAdminPasswordSource(false, {
      persistedAdminUser: true,
      resetRequested: true,
      opsSocketAvailable: true,
    })).toBe("rotate");
  });

  test("--reset-admin-pass without a reachable socket refuses with the start command", () => {
    expect(resolveInitAdminPasswordSource(false, {
      persistedAdminUser: true,
      resetRequested: true,
      opsSocketAvailable: false,
    })).toBe("refuse");
    expect(resolveInitAdminPasswordRefuseReason(false, {
      persistedAdminUser: true,
      resetRequested: true,
      opsSocketAvailable: false,
    })).toBe("reset-without-socket");
  });

  test("foreign instance on the port (fresh data dir) refuses with flair stop", () => {
    expect(resolveInitAdminPasswordSource(false, {
      foreignInstanceOnPort: true,
      persistedAdminUser: false,
    })).toBe("refuse");
    expect(resolveInitAdminPasswordRefuseReason(false, {
      foreignInstanceOnPort: true,
    })).toBe("foreign-instance");
  });

  test("existing file still reuses even when a persisted user is present", () => {
    expect(resolveInitAdminPasswordSource(true, { persistedAdminUser: true })).toBe("reuse-existing");
  });
});

describe("detectPersistedAdminUser — Harper's own user-record paths", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  test("empty data dir is not a persisted user", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    expect(detectPersistedAdminUser(dir)).toBe(false);
  });

  test("harper-config.yaml alone is not a persisted user", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    writeFileSync(join(dir, "harper-config.yaml"), "http:\n  port: 19926\n");
    expect(detectPersistedAdminUser(dir)).toBe(false);
  });

  test("system/hdb_user/data.mdb is a persisted user", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    mkdirSync(join(dir, "system", "hdb_user"), { recursive: true });
    writeFileSync(join(dir, "system", "hdb_user", "data.mdb"), "user-hash");
    expect(detectPersistedAdminUser(dir)).toBe(true);
  });

  test("legacy system/hdb_user.mdb is a persisted user", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    mkdirSync(join(dir, "system"), { recursive: true });
    writeFileSync(join(dir, "system", "hdb_user.mdb"), "user-hash");
    expect(detectPersistedAdminUser(dir)).toBe(true);
  });
});

describe("refusal names the exact recovery command", () => {
  test("persisted-missing-file names both exits verbatim", () => {
    const msg = initAdminPassRefusalMessage("persisted-missing-file", {
      dataDir: "/tmp/flair-data",
      adminPassPath: "/tmp/admin-pass",
    });
    expect(msg).toContain(INIT_RESET_ADMIN_PASS_COMMAND);
    expect(msg).toContain(INIT_ADMIN_PASS_FILE_COMMAND);
    expect(msg).toContain("/tmp/flair-data");
    expect(msg).toContain("/tmp/admin-pass");
    expect(msg).not.toMatch(/generate/i);
  });

  test("foreign-instance names flair stop verbatim", () => {
    const msg = initAdminPassRefusalMessage("foreign-instance", { httpPort: 19926 });
    expect(msg).toContain(INIT_STOP_FOREIGN_COMMAND);
    expect(msg).toContain("19926");
  });

  test("reset-without-socket names flair init --reset-admin-pass", () => {
    const msg = initAdminPassRefusalMessage("reset-without-socket");
    expect(msg).toContain(INIT_RESET_ADMIN_PASS_COMMAND);
  });

  test("socket-not-owner-only names the posture and the reset command", () => {
    const msg = initAdminPassRefusalMessage("socket-not-owner-only", {
      socketPath: "/data/operations-server",
    });
    expect(msg).toContain("/data/operations-server");
    expect(msg).toContain("0700");
    expect(msg).toContain("0600");
    expect(msg).toContain("super_user");
    expect(msg).toContain(INIT_RESET_ADMIN_PASS_COMMAND);
  });

  test("socket-not-ready names the socket and refuses before write", () => {
    const msg = initAdminPassRefusalMessage("socket-not-ready", {
      socketPath: "/data/operations-server",
    });
    expect(msg).toContain("/data/operations-server");
    expect(msg).toContain("never became ready");
    expect(msg).toContain("Refusing before any alter_user");
    expect(msg).toContain(INIT_RESET_ADMIN_PASS_COMMAND);
  });
});

describe("adminPassDesyncFinding — doctor report-only", () => {
  test("flags missing file + persisted user", () => {
    const finding = adminPassDesyncFinding({
      adminPassFileExists: false,
      persistedAdminUser: true,
      dataDir: "/data",
      adminPassPath: "/pass",
    });
    expect(finding?.flagged).toBe(true);
    expect(finding?.remedy).toBe(ADMIN_PASS_DESYNC_REMEDY);
    expect(finding?.remedy).toContain("Fix:");
    expect(finding?.remedy).toContain(INIT_RESET_ADMIN_PASS_COMMAND);
    expect(finding?.remedy).toContain(INIT_ADMIN_PASS_FILE_COMMAND);
  });

  test("silent when the file exists or there is no persisted user", () => {
    expect(adminPassDesyncFinding({ adminPassFileExists: true, persistedAdminUser: true })).toBeNull();
    expect(adminPassDesyncFinding({ adminPassFileExists: false, persistedAdminUser: false })).toBeNull();
  });
});

describe("rotateAdminPasswordViaOpsSocket — no Authorization header", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  test("POSTs alter_user over the unix socket without Authorization", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const socketPath = join(dir, "operations-server");
    const seen: { headers: Record<string, string | string[] | undefined>; body: unknown }[] = [];

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        seen.push({
          headers: req.headers as Record<string, string | string[] | undefined>,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "ok" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, () => resolve());
      server.on("error", reject);
    });
    try {
      await rotateAdminPasswordViaOpsSocket(socketPath, "admin", "new-secret");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers.authorization).toBeUndefined();
      expect(seen[0]!.body).toEqual({
        operation: "alter_user",
        username: "admin",
        password: "new-secret",
        role: "super_user",
        active: true,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("callOpsSocket surfaces a 401 instead of writing a success", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const socketPath = join(dir, "operations-server");
    const server = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Login failed" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, () => resolve());
      server.on("error", reject);
    });
    try {
      await expect(rotateAdminPasswordViaOpsSocket(socketPath, "admin", "x")).rejects.toThrow(/401/);
      expect(existsSync(join(dir, "admin-pass"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("callOpsSocket is the transport rotate uses (same socket POST)", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const socketPath = join(dir, "operations-server");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, () => resolve());
      server.on("error", reject);
    });
    try {
      const result = await callOpsSocket(socketPath, { operation: "list_users" });
      expect(result.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("PLAN ACCEPTED conditions — preflight, owner-only, fails-first 401", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  test("preflight names the user, socket, and destination file before alter_user", () => {
    const msg = formatAdminPasswordRotatePreflight({
      username: "admin",
      socketPath: "/data/operations-server",
      adminPassPath: "/home/op/.flair/admin-pass",
    });
    expect(msg).toContain("admin");
    expect(msg).toContain("/data/operations-server");
    expect(msg).toContain("/home/op/.flair/admin-pass");
    expect(msg).toContain("super_user");
    expect(msg).toContain("no Authorization header");
    expect(msg).toContain("0700");
    expect(msg).toContain("0600");
  });

  test("rotate is unreachable without --reset-admin-pass", () => {
    expect(() => assertExplicitAdminPasswordRotate(false)).toThrow(/--reset-admin-pass was not given/);
    expect(() => assertExplicitAdminPasswordRotate(true)).not.toThrow();
    expect(() => prepareAdminPasswordRotate({
      resetRequested: false,
      username: "admin",
      socketPath: "/nope",
      adminPassPath: "/pass",
      stat: () => ({ mode: 0o600 }),
    })).toThrow(/--reset-admin-pass was not given/);
  });

  test("owner-only posture is exactly 0700 dir / 0600 socket", () => {
    expect(isOwnerOnlyOpsSocketPosture(0o700, 0o600)).toBe(true);
    expect(isOwnerOnlyOpsSocketPosture(0o750, 0o600)).toBe(false);
    expect(isOwnerOnlyOpsSocketPosture(0o700, 0o660)).toBe(false);
    expect(isOwnerOnlyOpsSocketPosture(0o755, 0o755)).toBe(false);
  });

  test("prepare refuses a group/world-accessible socket", () => {
    expect(() => prepareAdminPasswordRotate({
      resetRequested: true,
      username: "admin",
      socketPath: "/data/operations-server",
      adminPassPath: "/pass",
      stat: (p) => p.endsWith("operations-server") ? { mode: 0o755 } : { mode: 0o755 },
    })).toThrow(/not owner-only/);
    expect(() => prepareAdminPasswordRotate({
      resetRequested: true,
      username: "admin",
      socketPath: "/data/operations-server",
      adminPassPath: "/pass",
      stat: (p) => p.endsWith("operations-server") ? { mode: 0o600 } : { mode: 0o700 },
    })).not.toThrow();
  });

  test("FAILS-FIRST: missing file + persisted user + bare init on main writes a desynced file and the next ops call 401s; branch refuses and writes nothing", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    mkdirSync(join(dir, "system", "hdb_user"), { recursive: true });
    writeFileSync(join(dir, "system", "hdb_user", "data.mdb"), "user-hash");
    const passPath = join(dir, "admin-pass");
    expect(detectPersistedAdminUser(dir)).toBe(true);
    expect(existsSync(passPath)).toBe(false);

    const original = "original-persisted-password";
    const server = createServer((req, res) => {
      const expected = "Basic " + Buffer.from(`admin:${original}`).toString("base64");
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Login failed" }));
        return;
      }
      res.writeHead(200);
      res.end("{}");
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no port"));
      });
      server.on("error", reject);
    });

    try {
      // BEFORE (main): 1-arg form is generate-new. Writing that file desyncs
      // from the stored hash; the next ops call 401s.
      const mainDecision = resolveInitAdminPasswordSource(false);
      expect(mainDecision).toBe("generate-new");
      const desynced = "freshly-generated-does-not-match-hash";
      writeFileSync(passPath, desynced + "\n", { mode: 0o600 });
      chmodSync(passPath, 0o600);
      const before = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + Buffer.from(`admin:${desynced}`).toString("base64"),
        },
        body: JSON.stringify({ operation: "insert" }),
      });
      expect(before.status).toBe(401);
      expect((await before.json() as { error: string }).error).toBe("Login failed");

      rmSync(passPath);

      // AFTER (branch): 2-arg form with persisted user refuses. No file.
      const branchDecision = resolveInitAdminPasswordSource(false, { persistedAdminUser: true });
      expect(branchDecision).toBe("refuse");
      expect(existsSync(passPath)).toBe(false);
      const reason = resolveInitAdminPasswordRefuseReason(false, { persistedAdminUser: true });
      expect(reason).toBe("persisted-missing-file");
      const refusal = initAdminPassRefusalMessage(reason!, { dataDir: dir, adminPassPath: passPath });
      expect(refusal).toContain(INIT_RESET_ADMIN_PASS_COMMAND);
      expect(refusal).toContain(INIT_ADMIN_PASS_FILE_COMMAND);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("executeAdminPasswordRotate — socket ready, not HTTP health", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  test("waitForOpsSocketReady treats a dead leftover inode as not-ready", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const socketPath = join(dir, "operations-server");
    writeFileSync(socketPath, "");
    let polls = 0;
    const ready = await waitForOpsSocketReady(socketPath, {
      timeoutMs: 60,
      pollMs: 15,
      isLive: async () => {
        polls += 1;
        return false;
      },
    });
    expect(ready).toBe(false);
    expect(polls).toBeGreaterThan(0);
  });

  test("waitForOpsSocketReady becomes ready once the socket accepts", async () => {
    let polls = 0;
    const ready = await waitForOpsSocketReady("/data/operations-server", {
      timeoutMs: 200,
      pollMs: 10,
      isLive: async () => {
        polls += 1;
        return polls >= 3;
      },
    });
    expect(ready).toBe(true);
    expect(polls).toBe(3);
  });

  test("FAILS-FIRST: HTTP healthy + dead leftover socket refuses, writes no pass file, leaves the hash untouched", async () => {
    // Without the wait, prepare sees a 0600 leftover inode and calls alter_user
    // immediately. That is the Bugbot race: HTTP /Health already succeeded.
    const dir = makeTmpDir();
    dirs.push(dir);
    mkdirSync(join(dir, "system", "hdb_user"), { recursive: true });
    chmodSync(dir, 0o700);
    const hashPath = join(dir, "system", "hdb_user", "data.mdb");
    writeFileSync(hashPath, "existing-hash-untouched");
    const socketPath = join(dir, "operations-server");
    writeFileSync(socketPath, "");
    chmodSync(socketPath, 0o600);
    const passPath = join(dir, "admin-pass");
    const writes: string[] = [];
    const rotates: unknown[] = [];
    const preflights: string[] = [];

    await expect(executeAdminPasswordRotate({
      resetRequested: true,
      username: "admin",
      password: "new-secret-must-not-land",
      socketPath,
      adminPassPath: passPath,
      writeAdminPassFile: (p, contents) => {
        writes.push(p);
        writeFileSync(p, contents);
      },
      rotate: async (...args) => {
        rotates.push(args);
      },
      isLive: async () => false,
      timeoutMs: 80,
      pollMs: 20,
      stat: (p) => p === socketPath ? { mode: 0o600 } : { mode: 0o700 },
      onPreflight: (line) => preflights.push(line),
    })).rejects.toThrow(/never became ready/);

    expect(writes).toHaveLength(0);
    expect(rotates).toHaveLength(0);
    expect(preflights).toHaveLength(0);
    expect(existsSync(passPath)).toBe(false);
    expect(readFileSync(hashPath, "utf8")).toBe("existing-hash-untouched");
  });

  test("FAILS-FIRST: HTTP healthy + absent socket refuses before alter_user or write", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    mkdirSync(join(dir, "system", "hdb_user"), { recursive: true });
    const hashPath = join(dir, "system", "hdb_user", "data.mdb");
    writeFileSync(hashPath, "existing-hash-untouched");
    const socketPath = join(dir, "operations-server");
    const passPath = join(dir, "admin-pass");
    const writes: string[] = [];
    const rotates: unknown[] = [];

    await expect(executeAdminPasswordRotate({
      resetRequested: true,
      username: "admin",
      password: "new-secret-must-not-land",
      socketPath,
      adminPassPath: passPath,
      writeAdminPassFile: (p, contents) => {
        writes.push(p);
        writeFileSync(p, contents);
      },
      rotate: async (...args) => {
        rotates.push(args);
      },
      isLive: async () => false,
      timeoutMs: 60,
      pollMs: 15,
    })).rejects.toThrow(/never became ready/);

    expect(writes).toHaveLength(0);
    expect(rotates).toHaveLength(0);
    expect(existsSync(passPath)).toBe(false);
    expect(readFileSync(hashPath, "utf8")).toBe("existing-hash-untouched");
  });

  test("live socket: alter_user then write, never write first", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const socketPath = join(dir, "operations-server");
    const passPath = join(dir, "admin-pass");
    const order: string[] = [];

    await executeAdminPasswordRotate({
      resetRequested: true,
      username: "admin",
      password: "rotated-secret",
      socketPath,
      adminPassPath: passPath,
      writeAdminPassFile: (p, contents) => {
        order.push("write");
        writeFileSync(p, contents);
      },
      rotate: async () => {
        order.push("alter_user");
      },
      isLive: async () => true,
      timeoutMs: 50,
      pollMs: 10,
      stat: (p) => p === socketPath ? { mode: 0o600 } : { mode: 0o700 },
    });

    expect(order).toEqual(["alter_user", "write"]);
    expect(readFileSync(passPath, "utf8")).toBe("rotated-secret\n");
  });
});
