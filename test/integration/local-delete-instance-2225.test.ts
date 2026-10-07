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
import nacl from "tweetnacl";
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

interface SigningAgent { id: string; publicKey: string; secretKey: Uint8Array }
function signingAgent(id: string): SigningAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
const PLAIN_AGENT = signingAgent("agent-purge-plain");
const ADMIN_AGENT = signingAgent("agent-purge-admin");

function ed25519(who: SigningAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** POST a JSON body as a signing agent or with the instance's Basic admin credentials. */
async function postAs(who: SigningAgent | "basic", path: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: who === "basic" ? adminAuth() : ed25519(who, "POST", path) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: await res.text() };
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
  // Signing agents for the /MemoryPurge authority tests.
  await ops({
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [
      { id: PLAIN_AGENT.id, name: PLAIN_AGENT.id, role: "agent", publicKey: PLAIN_AGENT.publicKey, createdAt: new Date().toISOString() },
      { id: ADMIN_AGENT.id, name: ADMIN_AGENT.id, role: "admin", admin: true, publicKey: ADMIN_AGENT.publicKey, createdAt: new Date().toISOString() },
    ],
  });
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

// ─── post-merge audit (#2225 finding 1) ──────────────────────────────────────
// A destructive CLI delete that reports a row as removed must leave no Memory
// row stored. A skill-tagged row is the case the REST delete route versions
// instead of removing, so it is pinned here explicitly.
describe("audit #2225 — CLI deletes leave no skill-tagged Memory row stored", () => {
 async function putSkill(id: string, agentId: string, content: string): Promise<void> {
 // Right after boot the InstructionVersion per-key lock can answer 503
 // (instruction_version_lock_unavailable); retry that one status, bounded.
 let status = 0;
 let text = "";
 for (let attempt = 0; attempt < 60; attempt++) {
 const res = await fetch(`${harper.httpURL}/Memory/${encodeURIComponent(id)}`, {
 method: "PUT",
 headers: { "Content-Type": "application/json", Authorization: adminAuth() },
 body: JSON.stringify({ id, agentId, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent" }),
 signal: AbortSignal.timeout(30_000),
 });
 status = res.status;
 text = await res.text();
 if (status !== 503 || !text.includes("instruction_version_lock_unavailable")) break;
 await new Promise((r) => setTimeout(r, 500));
 }
 expect(status, text.slice(0, 300)).toBeLessThan(300);
 }

 async function storedRows(id: string): Promise<any[]> {
 const rows = await ops({
 operation: "search_by_value",
 database: "flair",
 table: "Memory",
 search_attribute: "id",
 search_value: id,
 get_attributes: ["id", "agentId", "tags", "validTo"],
 });
 return Array.isArray(rows) ? rows.filter((r: any) => r?.id === id) : [];
 }

 test("agent remove physically removes the removed agent's skill-tagged Memory row", async () => {
 const home = scratchHome();
 const agentId = "agent-skill-owner";
 const skillId = "agent-skill-owner-skill-1";
 await insertAgent(agentId);
 await putSkill(skillId, agentId, "a skill owned by the agent being removed");
 expect(await storedRows(skillId)).toHaveLength(1);

 const run = await runCli(
 ["agent", "remove", agentId, "--force", "--keep-keys", "--ops-port", String(opsPort())],
 home,
 );
 expect(run.code, run.out).toBe(0);
 expect(run.out).toContain(`Agent '${agentId}' removed successfully`);
 const left = await storedRows(skillId);
 expect(left, `still stored after a reported removal: ${JSON.stringify(left)}`).toEqual([]);
 }, 300_000);

 test("agent remove completes and removes every version row of an updated skill", async () => {
 const home = scratchHome();
 const agentId = "agent-skill-updated";
 const skillId = "agent-skill-updated-skill-1";
 await insertAgent(agentId);
 await putSkill(skillId, agentId, "first version of the skill");
 await putSkill(skillId, agentId, "second version of the skill");
 const before = await ops({
 operation: "search_by_value", database: "flair", table: "Memory",
 search_attribute: "agentId", search_value: agentId, get_attributes: ["id", "validTo"],
 });
 expect(before.length).toBe(2);

 const run = await runCli(
 ["agent", "remove", agentId, "--force", "--keep-keys", "--ops-port", String(opsPort())],
 home,
 );
 const agentLeft = await ops({
 operation: "search_by_value", database: "flair", table: "Agent",
 search_attribute: "id", search_value: agentId, get_attributes: ["id"],
 });
 expect(run.code, `${run.out}\nAgent rows left: ${JSON.stringify(agentLeft)}`).toBe(0);
 expect(agentLeft).toEqual([]);
 const left = await ops({
 operation: "search_by_value", database: "flair", table: "Memory",
 search_attribute: "agentId", search_value: agentId, get_attributes: ["id", "validTo"],
 });
 expect(left, `still stored after agent remove: ${JSON.stringify(left)}`).toEqual([]);
 }, 300_000);

 test("memory hygiene --apply physically removes a matched skill-tagged row it reports as deleted", async () => {
 const home = scratchHome();
 const skillId = "agent-hygskill-compact-1";
 await insertAgent("agent-hygskill");
 await putSkill(skillId, "agent-hygskill", "a skill row matched by the compact-id pattern");
 expect(await storedRows(skillId)).toHaveLength(1);

 const run = await runCli(
 ["memory", "hygiene", "--apply", "--pattern", "compact-id", "--ops-port", String(opsPort())],
 home,
 );
 expect(run.code, run.out).toBe(0);
 expect(run.out).toContain("Deleted");
 const left = await storedRows(skillId);
 expect(left, `still stored after hygiene reported it deleted: ${JSON.stringify(left)}`).toEqual([]);
 }, 300_000);

 test.each(["first", "latest"])("POST /MemoryPurge given only the %s version id of an updated skill removes every version row", async (which) => {
 const agentId = `agent-lineage-${which}`;
 const skillId = `${agentId}-skill-1`;
 await insertAgent(agentId);
 await putSkill(skillId, agentId, "first version of the skill");
 await putSkill(skillId, agentId, "second version of the skill");
 const versions = await ops({
 operation: "search_by_value", database: "flair", table: "Memory",
 search_attribute: "agentId", search_value: agentId, get_attributes: ["id"],
 });
 const versionIds: string[] = versions.map((r: any) => r.id).sort();
 expect(versionIds.length).toBe(2);
 expect(versionIds).toContain(skillId);
 const submitted = which === "first" ? skillId : versionIds.find((id) => id !== skillId)!;

 const res = await postAs("basic", "/MemoryPurge", { ids: [submitted] });
 expect(res.status, res.text.slice(0, 300)).toBe(200);
 expect(JSON.parse(res.text).removedIds.slice().sort()).toEqual(versionIds);
 const left = await ops({
 operation: "search_by_value", database: "flair", table: "Memory",
 search_attribute: "agentId", search_value: agentId, get_attributes: ["id"],
 });
 expect(left, `still stored after purging ${submitted}: ${JSON.stringify(left)}`).toEqual([]);
 }, 300_000);
});

// ─── POST /MemoryPurge authority and named-target refusals ──────────────────
describe("POST /MemoryPurge on a real Harper", () => {
  test("an agent signature and an admin agent signature are refused with nothing deleted; Basic operator credentials remove the row", async () => {
    // Positive control: the admin agent is an admin on this instance (an
    // admin-only endpoint accepts it and refuses the plain agent).
    const adminControl = await postAs(ADMIN_AGENT, "/MemoryDedupStats", {});
    expect(adminControl.status, adminControl.text.slice(0, 300)).toBe(200);
    const plainControl = await postAs(PLAIN_AGENT, "/MemoryDedupStats", {});
    expect(plainControl.status, plainControl.text.slice(0, 300)).toBe(403);

    const id = "agent-purge-auth-1";
    await insertMemory({ id, agentId: PLAIN_AGENT.id, content: "a durable row", durability: "permanent" });
    for (const who of [PLAIN_AGENT, ADMIN_AGENT]) {
      const res = await postAs(who, "/MemoryPurge", { ids: [id] });
      expect(res.status, `${who.id}: ${res.text.slice(0, 300)}`).toBe(403);
      expect(await memoryExists(id)).toBe(true);
      expect(await historyFor(id)).toEqual([]);
    }

    const res = await postAs("basic", "/MemoryPurge", { ids: [id] });
    expect(res.status, res.text.slice(0, 300)).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ removed: 1, removedIds: [id] });
    expect(await memoryExists(id)).toBe(false);
    expect((await historyFor(id)).length).toBe(1);
  }, 300_000);

  test("a named id that is not stored fails the call by name and removes nothing", async () => {
    const present = "agent-purge-missing-1";
    const absent = "agent-purge-missing-absent";
    await insertMemory({ id: present, agentId: PLAIN_AGENT.id, content: "a durable row", durability: "permanent" });
    const res = await postAs("basic", "/MemoryPurge", { ids: [present, absent] });
    expect(res.status, res.text.slice(0, 300)).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: "memory_purge_target_missing", ids: [absent] });
    expect(await memoryExists(present)).toBe(true);
    expect(await historyFor(present)).toEqual([]);
  }, 300_000);

  test("an id list with a non-string entry is refused and removes nothing", async () => {
    const present = "agent-purge-shape-1";
    await insertMemory({ id: present, agentId: PLAIN_AGENT.id, content: "a durable row", durability: "permanent" });
    const res = await postAs("basic", "/MemoryPurge", { ids: [present, 7] });
    expect(res.status, res.text.slice(0, 300)).toBe(400);
    expect(JSON.parse(res.text).error).toBe("memory_purge_ids_invalid");
    expect(await memoryExists(present)).toBe(true);
    expect(await historyFor(present)).toEqual([]);
  }, 300_000);
});

// ─── flair#2351 — agent remove confirms the Soul cleanup ──────────────────────
describe("flair#2351 — agent remove confirms the agent's Soul rows are gone", () => {
  /** Insert a Soul row with every field the Soul schema requires (schemas/soul in memory.graphql). */
  async function insertSoul(rec: { id: string; agentId: string; key: string; value: string }): Promise<void> {
    const res = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth() },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Soul",
        records: [{ ...rec, createdAt: new Date().toISOString() }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status, `Soul insert ${rec.id} → ${res.status}: ${(await res.text()).slice(0, 200)}`).toBe(200);
  }

  async function soulsFor(agentId: string): Promise<any[]> {
    const rows = await ops({
      operation: "search_by_value",
      database: "flair",
      table: "Soul",
      search_attribute: "agentId",
      search_value: agentId,
      get_attributes: ["id", "agentId", "key"],
    });
    return Array.isArray(rows) ? rows.filter((r: any) => r?.agentId === agentId) : rows;
  }

  test("agent remove removes an agent with Soul rows and leaves no Soul or Agent row", async () => {
    const home = scratchHome();
    const agentId = "agent-soul-owner";
    await insertAgent(agentId);
    await insertSoul({ id: `${agentId}:mission`, agentId, key: "mission", value: "keep the fleet honest" });
    await insertSoul({ id: `${agentId}:tone`, agentId, key: "tone", value: "plain" });
    expect((await soulsFor(agentId)).length).toBe(2);

    const run = await runCli(
      ["agent", "remove", agentId, "--force", "--keep-keys", "--ops-port", String(opsPort())],
      home,
    );
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain(`Agent '${agentId}' removed successfully`);

    const souls = await soulsFor(agentId);
    expect(souls, `Soul rows left after agent remove: ${JSON.stringify(souls)}`).toEqual([]);
    const agent = await ops({
      operation: "search_by_value",
      database: "flair",
      table: "Agent",
      search_attribute: "id",
      search_value: agentId,
      get_attributes: ["id"],
    });
    expect(agent, `Agent row left after agent remove: ${JSON.stringify(agent)}`).toEqual([]);
  }, 300_000);
});
