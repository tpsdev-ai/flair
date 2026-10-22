// MemoryMaintenance orphan-pointer scope, on a real Harper.
//
// The orphan sweep follows the same scope rule as the Memory loop: a non-admin
// run is scoped to the caller, and an admin run that names an agent is scoped to
// that agent. Such a run counts and removes only orphan pointer rows whose
// stamped author is the run's owner; a pointer with an empty author is outside
// it. Fleet-wide admin maintenance (no agent named) removes every orphan pointer
// row, the empty-author one included. With no concurrent writer, a pointer whose
// Memory row is live is not removed in any mode. A dry run skips the sweep; the
// dry runs here check how an admin `agentId` is refused or accepted.
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
// five orphans; orphans a scoped run must leave in place stay seeded, so each
// later scoped run also checks it left them unchanged, and the fleet-wide case
// (c) checks that it removes every remaining orphan. `outstanding` tracks them,
// and in (a) to (c) orphan rows are compared with a snapshot read immediately
// before each run. The live
// pointers and their Memory rows are compared with a snapshot taken at setup.
// (d) seeds nothing and (e) seeds one orphan of its own, with its own
// assertions on the replacement row and the counts; both first remove any
// orphans an earlier test left behind.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { AGENT_ID_RULE, isValidAgentId } from "../../src/lib/agent-id-rule.ts";
import { startHarper, stopHarper, HARPER_STOP_BUDGET_MS, type HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, type ProbeComponent, type ProbeFiles } from "../helpers/component-with-replay-probe";

const SFX = Date.now().toString(36);
const PAST = "2000-01-01T00:00:00.000Z";
const POINTER = { v: 1, host: "host-a", kind: "run", id: "run-aaaaaaaa" };
const READ_PROBE: ProbeFiles = {
  source: join("test", "fixtures", "maintenance-read-probe-2084", "probe.js"),
  target: join("dist", "resources", "zz-maintenance-read-probe-2084.js"),
  out: "maintenance-read-probe-2084",
};
const READ_PROBE_LOG = "maintenance-read-probe-2084.jsonl";
const MEMORY_READ_PROBE_LOG = "maintenance-memory-read-probe-2084.jsonl";
/** The 400 body an admin run's refused agentId gets: it names the shared agent-id rule. */
const AGENT_ID_REFUSAL = { error: `agentId must be a string matching ${AGENT_ID_RULE}` };

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
let composed: ProbeComponent | undefined;
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

async function seedOtherAgentOrphans(tag: string, count: number): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const id = `mm-${tag}-other-${i}-${SFX}`;
    rows.push(pointerRow(id, agentB.id));
    outstanding.set(id, agentB.id);
  }
  await insertRows("MemoryHostSource", rows);
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

/** The probe's per-search lines, in the order the searches completed. */
function readProbeLog(): Array<{ conditions: unknown; rows: number }> {
  const text = readFileSync(join(harper.installDir, READ_PROBE_LOG), "utf8").trim();
  return text.length === 0 ? [] : text.split("\n").map((line) => JSON.parse(line));
}

/** The probe's per-search Memory lines, in the order the searches completed. */
function readMemoryProbeLog(): Array<{ conditions: unknown; rows: number; ids: string[] }> {
  const path = join(harper.installDir, MEMORY_READ_PROBE_LOG);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n").map((line) => JSON.parse(line));
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-mm-scope-pause-"));
  composed = componentWithReplayProbe({ probe: READ_PROBE });
  harper = await startHarper({
    cwd: composed.dir,
    harperBinDir: composed.sourceRoot,
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
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
  if (composed) composed.cleanup();
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

  it("(a) an admin run refuses a supplied agentId that is not a non-blank string", async () => {
    await seedOrphans("bad");
    const before = await snapshotOrphans();
    for (const agentId of ["", " ", 42, null, true, {}, []]) {
      const res = await fetch(`${harper.httpURL}/MemoryMaintenance`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basicHeader() },
        body: JSON.stringify({ agentId }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      expect(res.status, `agentId=${JSON.stringify(agentId)}: ${text.slice(0, 300)}`).toBe(400);
      expect(JSON.parse(text), `agentId=${JSON.stringify(agentId)}: ${text.slice(0, 300)}`).toEqual(AGENT_ID_REFUSAL); // assertion: the refusal names the field and the rule
      for (const [id, o] of before) {
        expect(await readPointer(id), `agentId=${JSON.stringify(agentId)}: ${id} pointer changed`).toBe(o.pointer);
        expect(await readMemory(id), `agentId=${JSON.stringify(agentId)}: ${id} Memory row changed`).toBe(o.memory);
      }
    }
    const body = await maintain({ kind: "admin", body: {} });
    expect(body.stats?.agent).toBe("all"); // control: an absent agentId is fleet-wide
    await expectSweptOnly(null, body, before);
  }, 90_000);

  it("(a) an admin run refuses an agentId with leading or trailing whitespace and changes nothing", async () => {
    await seedOrphans("pad");
    const before = await snapshotOrphans();
    for (const agentId of [` ${agentA.id}`, `${agentA.id} `, `\t${agentA.id}`, `${agentA.id}\n`]) {
      const res = await fetch(`${harper.httpURL}/MemoryMaintenance`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basicHeader() },
        body: JSON.stringify({ agentId }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      expect(res.status, `agentId=${JSON.stringify(agentId)}: ${text.slice(0, 300)}`).toBe(400); // assertion: a padded agentId is refused
      expect(JSON.parse(text), `agentId=${JSON.stringify(agentId)}: ${text.slice(0, 300)}`).toEqual(AGENT_ID_REFUSAL);
      for (const [id, o] of before) {
        expect(await readPointer(id), `agentId=${JSON.stringify(agentId)}: ${id} pointer changed`).toBe(o.pointer);
        expect(await readMemory(id), `agentId=${JSON.stringify(agentId)}: ${id} Memory row changed`).toBe(o.memory);
      }
    }
    // A non-admin run still ignores the field, padded or not.
    const body = await maintain({ kind: "agent", agent: agentA, body: { agentId: ` ${agentA.id} ` } });
    expect(body.stats?.agent).toBe(agentA.id); // control: the padded field is ignored for a non-admin caller
    await expectSweptOnly(agentA.id, body, before);
  }, 90_000);

  it("(a) an admin dry run refuses a present agentId that is not a string, is blank when trimmed, or differs from its trimmed form, the same way a non-dry run does", async () => {
    for (const agentId of ["", " ", ` ${agentA.id}`, `${agentA.id} `, 42, null]) {
      const res = await fetch(`${harper.httpURL}/MemoryMaintenance`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basicHeader() },
        body: JSON.stringify({ agentId, dryRun: true }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      expect(res.status, `dryRun agentId=${JSON.stringify(agentId)}: ${text.slice(0, 300)}`).toBe(400); // assertion: a dry run refuses a present agentId that is not a string, is blank when trimmed, or differs from its trimmed form
      expect(JSON.parse(text), `dryRun agentId=${JSON.stringify(agentId)}: ${text.slice(0, 300)}`).toEqual(AGENT_ID_REFUSAL);
    }
  }, 60_000);

  it("(a) an admin run refuses an agentId outside the shared agent-id rule, dry run or not, and changes nothing", async () => {
    const outside = ["agent/name", "a".repeat(65)];
    expect(outside[1].length).toBe(65); // control: one character over the rule's 64
    await seedOrphans("rule");
    // An orphan pointer stamped with each refused id: a run scoped to that id
    // would remove it.
    for (const [i, author] of outside.entries()) {
      const id = `mm-rule-outside-${i}-${SFX}`;
      await insertRows("MemoryHostSource", [pointerRow(id, author)]);
      expect(JSON.parse(await readPointer(id)).length, `${id} pointer was seeded`).toBe(1);
      outstanding.set(id, author);
    }
    const before = await snapshotOrphans();
    for (const agentId of outside) {
      for (const dryRun of [false, true]) {
        const label = `dryRun=${dryRun} agentId=${JSON.stringify(agentId)}`;
        const res = await fetch(`${harper.httpURL}/MemoryMaintenance`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: basicHeader() },
          body: JSON.stringify({ agentId, dryRun }),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text();
        expect(res.status, `${label}: ${text.slice(0, 300)}`).toBe(400); // assertion: an id outside the rule is refused
        expect(JSON.parse(text), `${label}: ${text.slice(0, 300)}`).toEqual(AGENT_ID_REFUSAL); // assertion: the refusal names the rule
        for (const [id, o] of before) {
          expect(await readPointer(id), `${label}: ${id} pointer changed`).toBe(o.pointer);
          expect(await readMemory(id), `${label}: ${id} Memory row changed`).toBe(o.memory);
        }
      }
    }
    await expectLiveUnchanged("refused admin runs");
    // A non-admin run still ignores the field.
    const own = await maintain({ kind: "agent", agent: agentA, body: { agentId: "agent/name" } });
    expect(own.stats?.agent).toBe(agentA.id); // control: the field is ignored for a non-admin caller
    await expectSweptOnly(agentA.id, own, before);
    const rest = await snapshotOrphans();
    const fleet = await maintain({ kind: "admin", body: {} });
    expect(fleet.stats?.agent).toBe("all"); // control: an absent agentId is fleet-wide
    await expectSweptOnly(null, fleet, rest); // control: the orphans the refused runs left were removable
  }, 120_000);

  it("(a) an admin run accepts a valid agentId that names no agent and removes nothing, dry run or not", async () => {
    const unknown = "a".repeat(64);
    expect(await readRows("Agent", "id", unknown)).toBe("[]"); // control: no agent has this id
    expect(await readRows("Memory", "agentId", unknown)).toBe("[]"); // control: no Memory row has this owner
    expect(await readRows("MemoryHostSource", "authorId", unknown)).toBe("[]"); // control: no pointer row has this author
    await seedOrphans("unknown");
    const before = await snapshotOrphans();
    for (const dryRun of [false, true]) {
      const label = `dryRun=${dryRun}`;
      const body = await maintain({ kind: "admin", body: { agentId: unknown, dryRun } });
      expect(body.message, label).toBe(dryRun ? "Dry run complete" : "Maintenance complete"); // assertion: accepted
      expect(body.stats?.agent, label).toBe(unknown); // control: the run is scoped to the named id
      expect({ total: body.total, expired: body.expired, archived: body.archived, orphans: body.orphans, skipped: body.skipped }, label)
        .toEqual({ total: 0, expired: 0, archived: 0, orphans: 0, skipped: 0 }); // assertion: nothing was counted
      for (const [id, o] of before) {
        expect(await readPointer(id), `${label}: ${id} pointer changed`).toBe(o.pointer); // assertion: nothing was removed
        expect(await readMemory(id), `${label}: ${id} Memory row changed`).toBe(o.memory);
      }
      await expectLiveUnchanged(`admin run naming an unknown id, ${label}`);
    }
    const fleet = await maintain({ kind: "admin", body: {} });
    expect(fleet.stats?.agent).toBe("all"); // control: an absent agentId is fleet-wide
    await expectSweptOnly(null, fleet, before);
  }, 120_000);

  it("(a) a non-admin run by an agent whose stored id is outside the agent-id rule removes its own orphan pointers", async () => {
    // The Agent row and its pointers are seeded through the operations API,
    // which does not apply the agent-id rule.
    const legacy = makeAgent(`mm-legacy.${SFX}`);
    expect(isValidAgentId(legacy.id)).toBe(false); // control: the stored id is outside the rule
    await insertRows("Agent", [
      { id: legacy.id, name: legacy.id, role: "agent", publicKey: legacy.publicKey, createdAt: new Date().toISOString() },
    ]);
    expect((JSON.parse(await readRows("Agent", "id", legacy.id)) as unknown[]).length, "the legacy agent row was seeded").toBe(1);
    await seedOrphans("legacy");
    const legacyRows: Record<string, unknown>[] = [];
    for (let i = 0; i < 2; i++) {
      const id = `mm-legacy-orphan-${i}-${SFX}`;
      legacyRows.push(pointerRow(id, legacy.id));
      outstanding.set(id, legacy.id);
    }
    await insertRows("MemoryHostSource", legacyRows);
    const before = await snapshotOrphans();
    expect([...before.values()].filter((o) => o.author === legacy.id).length).toBe(2); // control: the legacy agent's orphans are stored

    const body = await maintain({ kind: "agent", agent: legacy, body: {} });
    expect(body.stats?.agent).toBe(legacy.id); // control: the run is scoped to the caller
    await expectSweptOnly(legacy.id, body, before); // assertion: its orphan pointers are counted and removed, every other orphan unchanged
    await expectLiveUnchanged("legacy-id non-admin run");

    const rest = await snapshotOrphans();
    const fleet = await maintain({ kind: "admin", body: {} });
    expect(fleet.stats?.agent).toBe("all"); // control: an absent agentId is fleet-wide
    await expectSweptOnly(null, fleet, rest);
  }, 120_000);

  it("(b) an admin run naming an agent reads only that agent's pointer rows", async () => {
    await clearLeftoverOrphans();
    await seedOrphans("read");
    await seedOtherAgentOrphans("read", 25);
    const before = await snapshotOrphans();
    const targetIds = [...before].filter(([, o]) => o.author === agentA.id).map(([id]) => id);
    const otherCount = before.size - targetIds.length;
    const agentARows = targetIds.length + LIVE.filter((l) => l.author === agentA.id).length;
    expect(targetIds.length).toBe(2); // control: the target agent has two orphans
    expect(otherCount).toBe(28); // control: the other-agent and unattributed orphans are stored
    expect(agentARows).toBe(3); // control: the target agent has three pointer rows including its live one

    rmSync(join(harper.installDir, READ_PROBE_LOG), { force: true });
    const body = await maintain({ kind: "admin", body: { agentId: agentA.id } });
    const reads = readProbeLog();
    expect(reads.length, JSON.stringify(reads)).toBe(1); // control: the sweep ran one pointer search
    expect(reads[0].conditions).toEqual([{ attribute: "authorId", comparator: "equals", value: agentA.id }]); // assertion: the scoped read is an indexed authorId condition
    expect(reads[0].rows, JSON.stringify(reads[0])).toBe(agentARows); // assertion: the scoped read yielded only the target agent's rows
    await expectSweptOnly(agentA.id, body, before);

    const fleetBefore = await snapshotOrphans();
    rmSync(join(harper.installDir, READ_PROBE_LOG), { force: true });
    const fleet = await maintain({ kind: "admin", body: {} });
    const fleetReads = readProbeLog();
    expect(fleet.stats?.agent).toBe("all"); // control: an absent agentId is fleet-wide
    expect(fleetReads.length, JSON.stringify(fleetReads)).toBe(1); // control: the sweep ran one pointer search
    expect(fleetReads[0].conditions).toBeNull(); // assertion: the fleet-wide read carries no owner condition
    expect(fleetReads[0].rows, JSON.stringify(fleetReads[0])).toBe(otherCount + LIVE.length); // assertion: the fleet-wide read yielded every remaining row
    await expectSweptOnly(null, fleet, fleetBefore);
  }, 120_000);

  it("(b) an admin run naming one of two case-variant agents removes only its orphan pointer", async () => {
    await clearLeftoverOrphans();
    const lower = `mm-case-${SFX}`;
    const upper = lower.toUpperCase();
    expect(upper).not.toBe(lower); // control: the two ids differ only by case
    const now = new Date().toISOString();
    await insertRows("Agent", [
      { id: lower, name: lower, role: "agent", publicKey: makeAgent(lower).publicKey, createdAt: now },
      { id: upper, name: upper, role: "agent", publicKey: makeAgent(upper).publicKey, createdAt: now },
    ]);
    expect((JSON.parse(await readRows("Agent", "id", lower)) as unknown[]).length, "the named agent row was seeded").toBe(1);
    expect((JSON.parse(await readRows("Agent", "id", upper)) as unknown[]).length, "the case-variant agent row was seeded").toBe(1);
    const lowerId = `${lower}-orphan`;
    const upperId = `${upper}-orphan`;
    await insertRows("MemoryHostSource", [pointerRow(lowerId, lower), pointerRow(upperId, upper)]);
    const lowerBefore = await readPointer(lowerId);
    const upperBefore = await readPointer(upperId);
    expect(JSON.parse(lowerBefore).length, "the named agent's orphan pointer was seeded").toBe(1);
    expect(JSON.parse(upperBefore).length, "the case-variant agent's orphan pointer was seeded").toBe(1);

    const body = await maintain({ kind: "admin", body: { agentId: lower } });
    expect(body.stats?.agent).toBe(lower); // control: the run is scoped to the named agent
    expect(body.orphans, JSON.stringify(body)).toBe(1); // assertion: only the named agent's pointer is counted
    expect(await readPointer(lowerId), "the named agent's pointer was not removed").toBe("[]"); // assertion: the named agent's pointer is removed
    expect(await readPointer(upperId), "the case-variant agent's pointer changed").toBe(upperBefore); // assertion: the case-variant pointer is unchanged
    const cleanup = await adminOp({ operation: "delete", database: "flair", table: "MemoryHostSource", hash_values: [upperId] });
    expect(cleanup.status).toBe(200);
  }, 90_000);

  it("(b) an admin run naming an agent reads only that agent's Memory rows", async () => {
    await clearLeftoverOrphans();
    const countMemory = async (agentId: string) =>
      (JSON.parse(await readRows("Memory", "agentId", agentId)) as unknown[]).length;
    const agentARows = await countMemory(agentA.id);
    const agentBRows = await countMemory(agentB.id);
    expect(agentARows, "the target agent has Memory rows").toBeGreaterThan(0);
    expect(agentBRows, "the other agent has Memory rows").toBeGreaterThan(0);
    const totalRows = agentARows + agentBRows;

    rmSync(join(harper.installDir, MEMORY_READ_PROBE_LOG), { force: true });
    const body = await maintain({ kind: "admin", body: { agentId: agentA.id } });
    expect(body.stats?.agent).toBe(agentA.id); // control: the run is scoped to the named agent
    const scoped = readMemoryProbeLog();
    expect(scoped.length, JSON.stringify(scoped)).toBe(1); // control: the item loop ran one Memory search
    const agentAIds = (JSON.parse(await readRows("Memory", "agentId", agentA.id)) as Array<{ id: string }>).map((r) => r.id);
    expect([...scoped[0].ids].sort(), JSON.stringify(scoped[0])).toEqual([...agentAIds].sort()); // assertion: the yielded ids are exactly the target agent's rows
    expect(scoped[0].conditions).toEqual([{ attribute: "agentId", comparator: "equals", value: agentA.id }]); // assertion: the scoped read is an indexed agentId condition
    expect(scoped[0].rows, JSON.stringify(scoped[0])).toBe(agentARows); // assertion: the scoped read yielded as many rows as the target agent has

    rmSync(join(harper.installDir, MEMORY_READ_PROBE_LOG), { force: true });
    const fleet = await maintain({ kind: "admin", body: {} });
    expect(fleet.stats?.agent).toBe("all"); // control: an absent agentId is fleet-wide
    const fleetReads = readMemoryProbeLog();
    expect(fleetReads.length, JSON.stringify(fleetReads)).toBe(1); // control: the item loop ran one Memory search
    expect(fleetReads[0].conditions).toBeNull(); // assertion: the fleet-wide read carries no agent condition
    expect(fleetReads[0].rows, JSON.stringify(fleetReads[0])).toBe(totalRows); // assertion: the fleet-wide read yielded every Memory row
  }, 120_000);

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
