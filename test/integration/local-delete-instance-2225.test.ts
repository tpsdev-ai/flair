/**
 * local-delete-instance-2225.test.ts — the CLI's local delete paths against a
 * REAL ephemeral Harper (flair#2225, under #2213).
 *
 * `memory hygiene --apply` and `agent remove` pair the operations port they
 * scanned with the HTTP port Harper's own `get_configuration` reports
 * (src/lib/local-delete-instance.ts), then send each delete through the CLI's
 * real api() transport. These tests run the real commands against a scratch
 * Harper and assert that a delete lands on the scanned instance and is written
 * to the MemoryDeletionHistory table the integrity watcher reads — and that an
 * unreadable or unpaired configuration is refused before any delete.
 *
 * Throwaway HOME + data dir, OS-assigned ports (never 9925/9926, never ~/.flair).
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureCliBuild } from "../helpers/build-cli-once.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
setDefaultTimeout(180_000);

let harper: HarperInstance;
const homes: string[] = [];

const adminAuth = () =>
  "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
const opsPort = () => Number(new URL(harper.opsURL).port);
const httpPort = () => Number(new URL(harper.httpURL).port);

async function ops(body: unknown): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`ops ${(body as any)?.operation ?? "call"} failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function insertMemory(rec: { id: string; agentId: string; content: string; durability: string }): Promise<void> {
  await ops({
    operation: "insert",
    database: "flair",
    table: "Memory",
    records: [{ ...rec, instanceToken: randomUUID(), createdAt: new Date().toISOString() }],
  });
}

async function insertAgent(id: string): Promise<void> {
  await ops({
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id, name: "Agent B", publicKey: "test-agent-b-public-key", createdAt: new Date().toISOString() }],
  });
}

async function memoryExists(id: string): Promise<boolean> {
  const rows = await ops({
    operation: "search_by_value",
    database: "flair",
    table: "Memory",
    search_attribute: "id",
    search_value: id,
    get_attributes: ["id"],
  });
  return Array.isArray(rows) && rows.some((r: any) => r?.id === id);
}

/** Rows in MemoryDeletionHistory for one memory id — the table the watcher reads. */
async function historyFor(memoryId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value",
    database: "flair",
    table: "MemoryDeletionHistory",
    search_attribute: "id",
    search_value: "*",
    get_attributes: ["id", "memoryId", "memoryInstanceToken", "durability"],
  });
  return Array.isArray(rows) ? rows.filter((r: any) => r?.memoryId === memoryId) : [];
}

/** A fresh scratch HOME under the OS temp dir (never ~/.flair). */
function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "flair-2225-home-"));
  homes.push(home);
  return home;
}

interface CliRun {
  code: number | null;
  out: string;
}

async function runCli(args: string[], home: string): Promise<CliRun> {
  const env: Record<string, string | undefined> = { ...process.env };
  // Strip ambient target/identity so the CLI targets this scratch instance.
  delete env.FLAIR_URL;
  delete env.FLAIR_TARGET;
  delete env.FLAIR_OPS_PORT;
  delete env.FLAIR_AGENT_ID;
  env.HOME = home;
  env.FLAIR_ADMIN_USER = harper.admin.username;
  env.FLAIR_ADMIN_PASS = harper.admin.password;
  return await new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: env as Record<string, string>,
      timeout: 90_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out }));
  });
}

function runIntegrityCheck(home: string, port: number): { code: number | null; out: string; json: any } {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.FLAIR_URL;
  delete env.FLAIR_TARGET;
  delete env.FLAIR_OPS_PORT;
  env.HOME = home;
  env.FLAIR_ADMIN_USER = harper.admin.username;
  env.FLAIR_ADMIN_PASS = harper.admin.password;
  const r = spawnSync(process.execPath, [CLI, "integrity", "check", "--json", "--ops-port", String(port)], {
    encoding: "utf-8",
    env: env as Record<string, string>,
    timeout: 90_000,
    killSignal: "SIGTERM",
  });
  const stdout = r.stdout ?? "";
  let json: any = null;
  try {
    json = JSON.parse(stdout.trim().split("\n").filter((l) => l.trim().length > 0).pop() ?? "");
  } catch {
    /* leave null */
  }
  return { code: r.status, out: `${stdout}${r.stderr ?? ""}`, json };
}

/** A bound port with nothing listening on it (the listener is closed first). */
async function freeThenClosedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** A stub ops endpoint that reports an operations port it does not serve. */
async function startMismatchStub(): Promise<{ port: number; configurations: number; deletes: number; close: () => Promise<void> }> {
  const state = { configurations: 0, deletes: 0 };
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const port = (srv.address() as { port: number }).port;
      let parsed: any = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* ignore */
      }
      if (parsed?.operation === "get_configuration") state.configurations++;
      if (parsed?.operation === "delete") state.deletes++;
      res.writeHead(200, { "Content-Type": "application/json" });
      // The served operations port is this listener's port, but the body claims
      // a different one — the pairing does not hold.
      res.end(JSON.stringify({ http: { port: `127.0.0.1:${httpPort()}` }, operationsApi: { network: { port: port === 65535 ? 65534 : port + 1 } } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (srv.address() as { port: number }).port;
  return {
    port,
    get configurations() {
      return state.configurations;
    },
    get deletes() {
      return state.deletes;
    },
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

beforeAll(async () => {
  ensureCliBuild();
  harper = await startHarper();
  // OS-assigned, and never the reserved production ports.
  expect([9925, 9926]).not.toContain(opsPort());
  expect([9925, 9926]).not.toContain(httpPort());
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("flair#2225 — CLI local deletes on a real Harper", () => {
  test("memory hygiene --apply deletes on the scanned instance and records each delete the watcher reads", async () => {
    const home = scratchHome();
    const ids = ["agent-hyg-compact-1", "agent-hyg-compact-2"];
    for (const id of ids) await insertMemory({ id, agentId: "agent-hyg", content: "junk row", durability: "permanent" });

    const base = runIntegrityCheck(home, opsPort());
    expect(base.code, base.out).toBe(0);
    expect(base.json?.status).toBe("baseline");

    const run = await runCli(
      ["memory", "hygiene", "--apply", "--pattern", "compact-id", "--ops-port", String(opsPort())],
      home,
    );
    expect(run.code, run.out).toBe(0);

    for (const id of ids) {
      expect(await memoryExists(id)).toBe(false);
      const history = await historyFor(id);
      expect(history.length).toBe(1);
      expect(history[0].durability).toBe("permanent");
    }

    // The watcher reads the same table: the deletes are attributed, not losses.
    const after = runIntegrityCheck(home, opsPort());
    expect(after.code, after.out).toBe(0);
    expect(after.json?.status).toBe("healthy");
    expect(after.json?.losses).toEqual([]);
    expect((after.json?.attributedDeletes ?? []).map((d: any) => d.id).sort()).toEqual([...ids].sort());
  }, 300_000);

  test("agent remove deletes on the scanned instance and records the delete the watcher reads", async () => {
    const home = scratchHome();
    const agentId = "agent-b";
    const memoryId = "agent-b-memory-1";
    await insertAgent(agentId);
    await insertMemory({ id: memoryId, agentId, content: "a durable memory owned by agent b", durability: "permanent" });

    const base = runIntegrityCheck(home, opsPort());
    expect(base.code, base.out).toBe(0);
    expect(base.json?.status).toBe("baseline");

    const run = await runCli(
      ["agent", "remove", agentId, "--force", "--keep-keys", "--ops-port", String(opsPort())],
      home,
    );
    expect(run.code, run.out).toBe(0);
    expect(await memoryExists(memoryId)).toBe(false);

    const history = await historyFor(memoryId);
    expect(history.length).toBe(1);
    expect(history[0].durability).toBe("permanent");

    const after = runIntegrityCheck(home, opsPort());
    expect(after.code, after.out).toBe(0);
    expect(after.json?.status).toBe("healthy");
    expect(after.json?.losses).toEqual([]);
    expect((after.json?.attributedDeletes ?? []).map((d: any) => d.id)).toContain(memoryId);
  }, 300_000);

  test.each(["memory hygiene", "agent remove"])("%s refuses a conflicting explicit HTTP port", async (command) => {
    const home = scratchHome();
    const agentId = `agent-conflict-${command === "memory hygiene" ? "hyg" : "remove"}`;
    const id = `${agentId}-compact-1`;
    await insertAgent(agentId);
    await insertMemory({ id, agentId, content: "junk row", durability: "permanent" });
    const before = await historyFor(id);
    const conflictingPort = await freeThenClosedPort();
    expect(conflictingPort).not.toBe(httpPort());
    const args = command === "memory hygiene"
      ? ["memory", "hygiene", "--apply", "--pattern", "compact-id"]
      : ["agent", "remove", agentId, "--force", "--keep-keys"];
    const run = await runCli(
      [...args, "--ops-port", String(opsPort()), "--port", String(conflictingPort)],
      home,
    );
    expect(run.code, run.out).not.toBe(0);
    expect(run.out).toContain(
      `--port ${conflictingPort} does not match --ops-port ${opsPort()}'s HTTP endpoint ${httpPort()}; refusing deletion`,
    );
    expect(await memoryExists(id)).toBe(true);
    expect(await historyFor(id)).toEqual(before);
  }, 300_000);

  test("an unreadable or unpaired configuration refuses before any delete", async () => {
    const home = scratchHome();
    const id = "agent-hyg-compact-3";
    await insertMemory({ id, agentId: "agent-hyg", content: "junk row", durability: "permanent" });

    // (i) nothing serving the ops port: get_configuration cannot be read.
    const closed = await freeThenClosedPort();
    const closedRun = await runCli(
      ["memory", "hygiene", "--apply", "--pattern", "compact-id", "--ops-port", String(closed)],
      home,
    );
    expect(closedRun.code, closedRun.out).not.toBe(0);
    expect(closedRun.out).toContain("refusing deletion");
    expect(await memoryExists(id)).toBe(true);

    // (ii) the instance's own HTTP port is not a paired operations endpoint.
    const httpRun = await runCli(
      ["memory", "hygiene", "--apply", "--pattern", "compact-id", "--ops-port", String(httpPort())],
      home,
    );
    expect(httpRun.code, httpRun.out).not.toBe(0);
    expect(httpRun.out).toContain("refusing deletion");
    expect(await memoryExists(id)).toBe(true);

    // (iii) a stub reporting an operations port it does not serve.
    const stub = await startMismatchStub();
    try {
      const stubRun = await runCli(
        ["memory", "hygiene", "--apply", "--pattern", "compact-id", "--ops-port", String(stub.port)],
        home,
      );
      expect(stubRun.code, stubRun.out).not.toBe(0);
      expect(stubRun.out).toContain(`--ops-port ${stub.port}: no matching local HTTP endpoint; refusing deletion`);
      expect(stub.configurations).toBe(1);
      expect(stub.deletes).toBe(0);
      expect(await memoryExists(id)).toBe(true);
    } finally {
      await stub.close();
    }
  }, 300_000);
});
