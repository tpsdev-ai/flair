// MemoryMaintenance orphan-pointer scope, on a real Harper.
//
// The orphan sweep follows the same scope rule as the Memory loop: a non-admin
// run is scoped to the caller, and an admin run that names an agent is scoped to
// that agent. Such a run counts and removes only orphan pointer rows whose
// stamped author is the run's owner; a pointer with an empty author is outside
// it. Fleet-wide admin maintenance (no agent named) removes every orphan pointer
// row, the empty-author one included. With no concurrent writer, a pointer whose
// Memory row is live is not removed in any mode. Every run here is a real run: a
// dry run skips the sweep and is not exercised.
//
// (e) replaces an in-scope orphan pointer with another author's row after the
// sweep's final confirmation read, while the sweep is held at its
// `maintenance-orphan-commit` pause (resources/txn-pause-point.ts, enabled for
// THIS file's Harper only by FLAIR_ENABLE_TEST_FAULT_INJECTION and
// FLAIR_TEST_PAUSE_DIR). The sweep's delete runs in a transaction whose time is
// taken at its first read, before the confirmation read, so a replacement whose
// transaction takes its time later is applied after the delete: the replacement
// stays stored and the run does not count it. A competing transaction whose time
// is taken before the sweep's first read and that commits after the
// confirmation read is not exercised here; there is no compare-and-set, and
// per-id serialization is tracked in flair#2478.
//
// The tests run in file order against one Harper. Tests (a) to (c) each seed
// five orphans; orphans a run must leave in place stay seeded, so every later
// run also proves it left them unchanged. `outstanding` tracks them, and orphan
// rows are compared with a snapshot read immediately before each run. The live
// pointers and their Memory rows are compared with a snapshot taken at setup.
// (d) seeds nothing and (e) seeds one orphan of its own; both first remove any
// orphans an earlier failed test left behind.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { startHarper, stopHarper, HARPER_STOP_BUDGET_MS, type HarperInstance } from "../helpers/harper-lifecycle";

const SFX = Date.now().toString(36);
const PAST = "2000-01-01T00:00:00.000Z";
const POINTER = { v: 1, host: "host-a", kind: "run", id: "run-aaaaaaaa" };

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

function makeAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}

let harper: HarperInstance;
let pauseDir = "";
const agentA = makeAgent(`mm-scope-a-${SFX}`);
const agentB = makeAgent(`mm-scope-b-${SFX}`);

function basicHeader(): string {
  return "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
}

async function adminOp(op: Record<string, unknown>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicHeader() },
    body: JSON.stringify(op),
  });
}

async function insertRows(table: string, records: unknown[]): Promise<void> {
  const res = await adminOp({ operation: "insert", database: "flair", table, records });
  if (!res.ok) throw new Error(`insert ${table} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

function ed25519(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${agent.id}:${ts}:${nonce}:${method}:${path}`), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

type Mode = { kind: "agent"; agent: TestAgent; body: Record<string, unknown> } | { kind: "admin"; body: Record<string, unknown> };

/** One maintenance run; the response must be a 200 with no errors. */
async function maintain(mode: Mode): Promise<any> {
  const res = await fetch(`${harper.httpURL}/MemoryMaintenance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: mode.kind === "agent" ? ed25519(mode.agent, "POST", "/MemoryMaintenance") : basicHeader(),
    },
    body: JSON.stringify(mode.body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  const body = JSON.parse(text);
  expect(body.errors, text.slice(0, 300)).toBe(0);
  return body;
}

/** Every stored attribute of the rows with this key, serialised as read back. */
async function readRows(table: string, attribute: string, value: string): Promise<string> {
  const res = await adminOp({
    operation: "search_by_value",
    database: "flair",
    table,
    search_attribute: attribute,
    search_type: "equals",
    search_value: value,
    get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.stringify(JSON.parse(text));
}
const readPointer = (memoryId: string) => readRows("MemoryHostSource", "memoryId", memoryId);
const readMemory = (id: string) => readRows("Memory", "id", id);

function pointerRow(memoryId: string, authorId: string, memoryInstanceToken: string = randomUUID()): Record<string, unknown> {
  return {
    memoryId,
    hostSource: JSON.stringify(POINTER),
    scopeAtWrite: null,
    authorId,
    memoryInstanceToken,
    receivedAt: new Date().toISOString(),
  };
}

function memoryRow(id: string, agentId: string, archived: boolean, instanceToken: string): Record<string, unknown> {
  return {
    id, agentId, content: `${id} body`, contentHash: id, visibility: "shared",
    durability: "permanent", createdAt: PAST, archived, instanceToken,
    // Seeded with a current-model embedding stamp, so the background re-embed
    // has nothing to do and every row stays as seeded unless maintenance acts.
    embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(),
  };
}

// ─── orphan bookkeeping ──────────────────────────────────────────────────────

/** Orphan pointers seeded by this file and expected to be still stored, keyed
 *  by memoryId, with their stamped author. */
const outstanding = new Map<string, string>();

type OrphanSnapshot = Map<string, { author: string; pointer: string; memory: string }>;

/** Seed five orphan pointers for one test: for each of A and B one whose Memory
 *  row is missing and one whose Memory row is archived, plus one with an empty
 *  author and no Memory row. */
async function seedOrphans(tag: string): Promise<void> {
  const specs: Array<{ id: string; author: string; memoryOwner?: string }> = [
    { id: `mm-${tag}-a-missing-${SFX}`, author: agentA.id },
    { id: `mm-${tag}-a-archived-${SFX}`, author: agentA.id, memoryOwner: agentA.id },
    { id: `mm-${tag}-b-missing-${SFX}`, author: agentB.id },
    { id: `mm-${tag}-b-archived-${SFX}`, author: agentB.id, memoryOwner: agentB.id },
    // The schema requires authorId, so a pointer with no owner is one whose
    // stamped author is the empty string.
    { id: `mm-${tag}-unattributed-${SFX}`, author: "" },
  ];
  for (const s of specs) {
    const token = randomUUID();
    if (s.memoryOwner) await insertRows("Memory", [memoryRow(s.id, s.memoryOwner, true, token)]);
    await insertRows("MemoryHostSource", [pointerRow(s.id, s.author, token)]);
    expect(JSON.parse(await readPointer(s.id)).length, `${s.id} pointer was seeded`).toBe(1);
    outstanding.set(s.id, s.author);
  }
}

/** Remove orphans an earlier failed test left stored, so a test can start
 *  from the live pointers alone. */
async function clearLeftoverOrphans(): Promise<void> {
  const leftover = [...(await snapshotOrphans()).keys()];
  if (leftover.length > 0) {
    const res = await adminOp({ operation: "delete", database: "flair", table: "MemoryHostSource", hash_values: leftover });
    expect(res.status).toBe(200);
  }
  outstanding.clear();
}

/** Every outstanding orphan's pointer and Memory rows, read back immediately
 *  before a run. A pointer already gone (only after an earlier test failed) is
 *  dropped, so each test judges only its own run. */
async function snapshotOrphans(): Promise<OrphanSnapshot> {
  const snap: OrphanSnapshot = new Map();
  for (const [id, author] of outstanding) {
    const pointer = await readPointer(id);
    if (pointer === "[]") { outstanding.delete(id); continue; }
    snap.set(id, { author, pointer, memory: await readMemory(id) });
  }
  return snap;
}

/** The run counted and removed exactly the orphans authored by `owner` (every
 *  orphan when `owner` is null) and left every other orphan byte-identical. */
async function expectSweptOnly(owner: string | null, body: any, before: OrphanSnapshot): Promise<void> {
  const swept = [...before].filter(([, o]) => owner === null || o.author === owner).map(([id]) => id);
  expect(swept.length, "the run had in-scope orphans to sweep").toBeGreaterThan(0);
  expect(body.orphans, JSON.stringify(body)).toBe(swept.length); // assertion: the count is exactly the in-scope orphans
  for (const [id, o] of before) {
    if (swept.includes(id)) {
      expect(await readPointer(id), `${id} (in scope) was not removed`).toBe("[]");
    } else {
      expect(await readPointer(id), `${id} (out of scope) changed`).toBe(o.pointer); // assertion: byte-identical
      expect(await readMemory(id), `${id} Memory row (out of scope) changed`).toBe(o.memory);
    }
  }
  for (const id of swept) outstanding.delete(id);
}

// ─── non-orphan pointers (d) ─────────────────────────────────────────────────

const LIVE = [
  { id: `mm-live-a-${SFX}`, author: agentA.id, memoryOwner: agentA.id },
  { id: `mm-live-b-${SFX}`, author: agentB.id, memoryOwner: agentB.id },
  { id: `mm-live-unattributed-${SFX}`, author: "", memoryOwner: agentB.id },
];
const liveBefore = new Map<string, { pointer: string; memory: string }>();

async function expectLiveUnchanged(label: string): Promise<void> {
  for (const l of LIVE) {
    const before = liveBefore.get(l.id)!;
    expect(await readPointer(l.id), `${label}: live pointer ${l.id} changed`).toBe(before.pointer); // assertion: a non-orphan pointer is not removed
    expect(await readMemory(l.id), `${label}: live Memory ${l.id} changed`).toBe(before.memory);
  }
}

// ─── the sweep's commit pause (e) ────────────────────────────────────────────

const COMMIT_PAUSE_POINT = "maintenance-orphan-commit";

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-mm-scope-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    // The spawned Harper has its copy; no later Harper in this process inherits it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
  const now = new Date().toISOString();
  await insertRows("Agent", [
    { id: agentA.id, name: agentA.id, role: "agent", publicKey: agentA.publicKey, createdAt: now },
    { id: agentB.id, name: agentB.id, role: "agent", publicKey: agentB.publicKey, createdAt: now },
  ]);
  for (const l of LIVE) {
    const token = randomUUID();
    await insertRows("Memory", [memoryRow(l.id, l.memoryOwner, false, token)]);
    await insertRows("MemoryHostSource", [pointerRow(l.id, l.author, token)]);
    const pointer = await readPointer(l.id);
    expect(JSON.parse(pointer).length, `${l.id} live pointer was seeded`).toBe(1);
    liveBefore.set(l.id, { pointer, memory: await readMemory(l.id) });
  }
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("MemoryMaintenance orphan sweep is scoped to the run's owner (real Harper)", () => {
  it("(a) a non-admin run counts and removes only the caller's orphan pointers", async () => {
    await seedOrphans("na");
    const before = await snapshotOrphans();
    const body = await maintain({ kind: "agent", agent: agentA, body: {} });
    expect(body.stats?.agent).toBe(agentA.id); // control: the run is scoped to the caller
    await expectSweptOnly(agentA.id, body, before);
    await expectLiveUnchanged("non-admin run");
  }, 60_000);

  it("(a) a non-admin run that names another agent is still scoped to the caller", async () => {
    await seedOrphans("nab");
    const before = await snapshotOrphans();
    const body = await maintain({ kind: "agent", agent: agentA, body: { agentId: agentB.id } });
    expect(body.stats?.agent).toBe(agentA.id); // control: the named agent is ignored for a non-admin caller
    await expectSweptOnly(agentA.id, body, before);
    await expectLiveUnchanged("non-admin run naming another agent");
  }, 60_000);

  it("(b) an admin run that names an agent counts and removes only that agent's orphan pointers", async () => {
    await seedOrphans("an");
    const before = await snapshotOrphans();
    const body = await maintain({ kind: "admin", body: { agentId: agentA.id } });
    expect(body.stats?.agent).toBe(agentA.id); // control: the run is scoped to the named agent
    await expectSweptOnly(agentA.id, body, before);
    await expectLiveUnchanged("admin run naming an agent");
  }, 60_000);

  it("(c) a fleet-wide admin run removes every orphan pointer, the unattributed one included", async () => {
    await seedOrphans("fw");
    const before = await snapshotOrphans();
    const authors = new Set([...before.values()].map((o) => o.author));
    expect(authors.has(agentA.id) && authors.has(agentB.id) && authors.has(""), "orphans of every owner kind are stored").toBe(true);
    const body = await maintain({ kind: "admin", body: {} });
    expect(body.stats?.agent).toBe("all"); // control: the run is fleet-wide
    await expectSweptOnly(null, body, before);
    expect(outstanding.size).toBe(0);
    await expectLiveUnchanged("fleet-wide admin run");
  }, 60_000);

  it("(d) with no concurrent writer, a pointer whose Memory row is live is not counted or removed in any mode", async () => {
    // Only the live pointers are stored, so every run here must count zero.
    await clearLeftoverOrphans();
    const modes: Array<[string, Mode]> = [
      ["non-admin A", { kind: "agent", agent: agentA, body: {} }],
      ["non-admin B", { kind: "agent", agent: agentB, body: {} }],
      ["admin naming A", { kind: "admin", body: { agentId: agentA.id } }],
      ["admin naming B", { kind: "admin", body: { agentId: agentB.id } }],
      ["fleet-wide admin", { kind: "admin", body: {} }],
    ];
    for (const [label, mode] of modes) {
      const body = await maintain(mode);
      expect(body.orphans, `${label}: ${JSON.stringify(body)}`).toBe(0); // assertion: no live pointer is counted
      await expectLiveUnchanged(label);
    }
  }, 120_000);

  it("(e) a pointer replaced by another author's row after the sweep's final confirmation stays stored and is not counted", async () => {
    await clearLeftoverOrphans();
    const id = `mm-commit-window-${SFX}`;
    const token = randomUUID();
    await insertRows("Memory", [memoryRow(id, agentA.id, true, token)]);
    await insertRows("MemoryHostSource", [pointerRow(id, agentA.id, token)]);
    const memoryBefore = await readMemory(id);
    const replacement = {
      memoryId: id,
      hostSource: JSON.stringify({ ...POINTER, id: "run-bbbbbbbb" }),
      scopeAtWrite: null,
      authorId: agentB.id,
      memoryInstanceToken: randomUUID(),
      receivedAt: new Date().toISOString(),
    };

    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${COMMIT_PAUSE_POINT}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${COMMIT_PAUSE_POINT}`), "");
    const pending = maintain({ kind: "agent", agent: agentA, body: {} });
    const paused = await waitForFile(join(pauseDir, `paused.${COMMIT_PAUSE_POINT}`), 15_000);
    let replacementRow = "";
    try {
      expect(paused, "the sweep was not held after its final confirmation").toBe(true);
      const res = await adminOp({ operation: "upsert", database: "flair", table: "MemoryHostSource", records: [replacement] });
      expect(res.status, `replacement upsert returned ${res.status}`).toBe(200);
      replacementRow = await readPointer(id);
      expect(JSON.parse(replacementRow)[0]?.authorId, "the replacement is stored while the sweep is held").toBe(agentB.id);
    } finally {
      writeFileSync(join(pauseDir, `go.${COMMIT_PAUSE_POINT}`), "");
    }
    const body = await pending;
    expect(readFileSync(join(pauseDir, `released.${COMMIT_PAUSE_POINT}`), "utf8"), "the sweep was not released by this test").toBe("go");

    expect(await readPointer(id), "the replacement pointer was removed").toBe(replacementRow); // assertion: the replacement stays stored, byte-identical
    expect(body.orphans, JSON.stringify(body)).toBe(0); // assertion: the run does not count the replaced pointer as removed
    expect(body.skipped, JSON.stringify(body)).toBe(1); // assertion: it is reported as skipped
    expect(await readMemory(id)).toBe(memoryBefore); // control: the archived Memory row is unchanged
    await expectLiveUnchanged("commit-window run");
    await adminOp({ operation: "delete", database: "flair", table: "MemoryHostSource", hash_values: [id] });
  }, 90_000);
});
