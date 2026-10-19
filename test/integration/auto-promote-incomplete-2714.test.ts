// flair#2714 — an auto-promotion whose candidate update fails is reported by
// the candidate's confirmed state, and a later sweep can adopt the recorded row.
//
// AutoPromoteCandidates writes the promoted Memory row, stamps it, and only
// then marks the candidate `promoted`. When that last write throws, a fresh
// read of the candidate decides the report: read back pending → `incomplete`;
// read back promoted with this row → `promoted`; anything else, or a read that
// fails → `unconfirmed`. These cases run against a real ephemeral Harper:
//
//   (a) the candidate update throws before it reaches Harper: `incomplete`
//       (memory id, candidate id, error), not `promoted`; one stamped Memory
//       row; the candidate is still pending with that row recorded on it.
//   (b) the next sweep, with no fault, adopts the recorded row: the candidate
//       ends `promoted`, still one Memory row, reported under `promoted`.
//   (c) the per-call cap counts every Memory write, whatever its outcome, and
//       an adoption counts too.
//   (d) a recorded row whose approval is not this sweep's own (another
//       reviewer, another status, a binding that does not match its content,
//       or no promotedAt) is not adopted.
//   (e) the candidate update commits and then throws: reported `promoted`.
//   (f) the update throws and the confirming read fails: `unconfirmed`.
//   (g) an owner edit between the adoption's selection and its lock: the
//       candidate is not marked promoted pointing at the edited row.
//   (h) an owner edit that arrives while the adoption holds the lock waits
//       for it, then clears the verdict on the row the candidate points to.
//
// The faults come from a test-only module installed into a PRIVATE composed
// copy of the built component (the componentWithRetryProbe pattern,
// test/helpers/federation-retry-probe-component.ts). It wraps
// MemoryCandidate.put for a write that sets `status: "promoted"` on a candidate
// the test arms with a marker file under FLAIR_TEST_PAUSE_DIR (each arm file is
// consumed when it fires):
//   arm.candidate-update-fail.<id>            throw before Harper's put;
//   arm.candidate-update-fail-unreadable.<id> the same, and the next
//                                             MemoryCandidate.get for <id> throws;
//   arm.candidate-update-commit-throw.<id>    commit Harper's put in its own
//                                             transaction, then throw.
// (g) and (h) use the handler's own txn pause points
// (`auto-promote-adopt-selected`, `auto-promote-adopt-locked`), inert unless
// FLAIR_ENABLE_TEST_FAULT_INJECTION=1. Nothing under resources/ or src/ gains a
// fault switch.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { MACHINE_REVIEWER_ADK_AUTO_PROMOTE } from "../../resources/auto-promote-lib.ts";
import { promotionContentHash } from "../../resources/promotion-binding.ts";

const FAULT_MODULE_REL = join("dist", "resources", "zz-test-failing-candidate-update-2714.js");
const FAULT_MESSAGE = "test component: forced candidate update failure (flair#2714)";
const READ_FAULT_MESSAGE = "test component: forced candidate read failure (flair#2714)";
const FAULT_MODULE_SRC = `import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { databases } from "harper";
const table = databases.flair.MemoryCandidate;
const put = table.put;
const get = table.get;
const readFailNext = new Set();
function consume(dir, kind, id) {
  try {
    unlinkSync(join(dir, "arm." + kind + "." + id));
  } catch {
    return false;
  }
  writeFileSync(join(dir, "fired." + kind + "." + id), "");
  return true;
}
table.put = async function (record, ...rest) {
  const dir = process.env.FLAIR_TEST_PAUSE_DIR;
  const id = record && record.id;
  if (dir && record && record.status === "promoted" && typeof id === "string" && /^[a-z0-9-]{1,80}$/.test(id)) {
    if (consume(dir, "candidate-update-fail", id)) throw new Error(${JSON.stringify(FAULT_MESSAGE)});
    if (consume(dir, "candidate-update-fail-unreadable", id)) {
      readFailNext.add(id);
      throw new Error(${JSON.stringify(FAULT_MESSAGE)});
    }
    if (consume(dir, "candidate-update-commit-throw", id)) {
      // Commit the real write in a transaction of its own, then throw.
      await globalThis.transaction({}, () => put.call(this, record));
      throw new Error(${JSON.stringify(FAULT_MESSAGE)});
    }
  }
  return put.call(this, record, ...rest);
};
table.get = function (id, ...rest) {
  if (typeof id === "string" && readFailNext.delete(id)) throw new Error(${JSON.stringify(READ_FAULT_MESSAGE)});
  return get.call(this, id, ...rest);
};
`;

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** Refuse any target that is not the ephemeral instance this file started. */
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

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function authSend(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `seed agent returned ${res.status}`).toBe(200);
}

/** Seed a PENDING ADK candidate (scopeTag-bearing, the shape the sweep accepts). */
async function seedCandidate(harper: HarperInstance, agentId: string, id: string, claim: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "MemoryCandidate",
    records: [{
      id, agentId, status: "pending", claim, scopeTag: `adk:app2714:${agentId}`, sourceMemoryIds: [],
      generatedAt: new Date().toISOString(), generatedBy: "test-seed",
    }],
  });
  expect(res.status, `seed candidate ${id} returned ${res.status}: ${(await res.text()).slice(0, 200)}`).toBe(200);
}

async function readCandidate(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_hash", database: "flair", table: "MemoryCandidate", hash_values: [id], get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `candidate search returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}

/** Every Memory row owned by `agentId`, read through the admin ops API. */
async function memoryRowsForAgent(harper: HarperInstance, agentId: string): Promise<any[]> {
  const res = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "agentId", search_value: agentId, get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_value returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  const rows = JSON.parse(text) as any[];
  return Array.isArray(rows) ? rows : [];
}

async function rowsWithClaim(harper: HarperInstance, agentId: string, claim: string): Promise<any[]> {
  return (await memoryRowsForAgent(harper, agentId)).filter((r) => r?.content === claim);
}

async function readMemory(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `memory search returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}

async function sweepResponse(harper: HarperInstance, agent: TestAgent, body: Record<string, unknown> = {}): Promise<Response> {
  return authSend(harper, agent, "POST", "/AutoPromoteCandidates", { agentId: agent.id, ...body });
}

async function sweep(harper: HarperInstance, agent: TestAgent, body: Record<string, unknown> = {}): Promise<any> {
  const res = await sweepResponse(harper, agent, body);
  const text = await res.text();
  expect(res.status, `sweep returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

let harper: HarperInstance;
let faultDir: string;
let appDir: string;

function arm(kind: string, candidateId: string): void {
  rmSync(join(faultDir, `fired.${kind}.${candidateId}`), { force: true });
  writeFileSync(join(faultDir, `arm.${kind}.${candidateId}`), "");
}
function fired(kind: string, candidateId: string): boolean {
  return existsSync(join(faultDir, `fired.${kind}.${candidateId}`));
}
function armed(kind: string, candidateId: string): boolean {
  return existsSync(join(faultDir, `arm.${kind}.${candidateId}`));
}
const UPDATE_FAIL = "candidate-update-fail";
const UPDATE_FAIL_UNREADABLE = "candidate-update-fail-unreadable";
const COMMIT_THROW = "candidate-update-commit-throw";

/**
 * Arm the pause point `point`, start `trigger`, run `compete` once the trigger
 * is paused there, release, and await the trigger.
 */
async function withPaused<T>(point: string, trigger: () => Promise<Response>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(faultDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(faultDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(faultDir, `paused.${point}`), 20_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(faultDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(faultDir, `released.${point}`), "utf8") : "never paused";
  return { response, competed, released, paused };
}

/** Seed an agent and a candidate, fail its update once, and return the
 *  incomplete promotion's memory id. */
async function seedIncomplete(agent: TestAgent, candidateId: string, claim: string): Promise<string> {
  await seedAgent(harper, agent);
  await seedCandidate(harper, agent.id, candidateId, claim);
  arm(UPDATE_FAIL, candidateId);
  const body = await sweep(harper, agent);
  expect(fired(UPDATE_FAIL, candidateId), "the injected candidate update fault fired").toBe(true);
  expect(body.incomplete.length, JSON.stringify(body)).toBe(1);
  expect((await readCandidate(harper, candidateId)).status).toBe("pending");
  return body.incomplete[0].memoryId as string;
}

beforeAll(async () => {
  faultDir = mkdtempSync(join(tmpdir(), "flair-ap2714-fault-"));
  appDir = mkdtempSync(join(tmpdir(), "flair-ap2714-app-"));
  for (const name of ["dist", "schemas", "config.yaml", "package.json"]) {
    if (existsSync(resolve(name))) cpSync(resolve(name), join(appDir, name), { recursive: true });
  }
  if (!existsSync(join(appDir, "dist", "resources", "AutoPromoteCandidates.js"))) {
    throw new Error("auto-promote-incomplete-2714: dist/ is not built — run `bun run build` first");
  }
  writeFileSync(join(appDir, FAULT_MODULE_REL), FAULT_MODULE_SRC);
  symlinkSync(resolve("node_modules"), join(appDir, "node_modules"), "dir");
  harper = await startHarper({
    cwd: appDir,
    harperBinDir: process.cwd(),
    env: { FLAIR_TEST_PAUSE_DIR: faultDir, FLAIR_ENABLE_TEST_FAULT_INJECTION: "1" },
  });
  assertOwnInstance(harper);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (faultDir) rmSync(faultDir, { recursive: true, force: true });
  if (appDir) rmSync(appDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2714 — a failed candidate update is reported by its confirmed state and adopted next cycle (real Harper)", () => {
  const agent = mkAgent("ap2714-agent-a");
  const candidateId = "ap2714-cand-a";
  const claim = "The team ships the weekly release notes every Thursday afternoon.";
  let memoryId = "";

  it("(a) the candidate update throws before Harper's put: incomplete, not promoted; one stamped Memory row; candidate still pending", async () => {
    await seedAgent(harper, agent);
    await seedCandidate(harper, agent.id, candidateId, claim);
    arm(UPDATE_FAIL, candidateId);

    const body = await sweep(harper, agent);

    expect(fired(UPDATE_FAIL, candidateId), "the injected candidate update fault fired").toBe(true);
    expect(body.promoted, "a promotion whose candidate update failed is not reported promoted").toEqual([]);
    expect(body.count).toBe(0);
    expect(body.considered).toBe(1);
    expect(body.skipped).toEqual([]);
    expect(body.unconfirmed, "the confirming read found the candidate pending").toEqual([]);
    expect(Array.isArray(body.incomplete)).toBe(true);
    expect(body.incomplete.length).toBe(1);
    const entry = body.incomplete[0];
    expect(entry.candidateId).toBe(candidateId);
    expect(typeof entry.memoryId).toBe("string");
    expect(entry.error).toContain(FAULT_MESSAGE);
    memoryId = entry.memoryId;

    const rows = await rowsWithClaim(harper, agent.id, claim);
    expect(rows.length, "exactly one Memory row carries the claim").toBe(1);
    expect(rows[0].id).toBe(memoryId);
    expect(rows[0].promotionStatus, "the row was stamped before the candidate update").toBe("approved");
    expect(rows[0].promotedBy).toBe(MACHINE_REVIEWER_ADK_AUTO_PROMOTE);
    expect(rows[0].promotionContentHash).toBe(promotionContentHash(claim));

    const cand = await readCandidate(harper, candidateId);
    expect(cand.status, "the candidate stays pending").toBe("pending");
    expect(cand.promotedRowId, "the sweep recorded the row it wrote").toBe(memoryId);
    expect(cand.promotedRowInstanceToken).toBe(rows[0].instanceToken);
  }, 120_000);

  it("(b) the next sweep, no fault, adopts the recorded row: candidate promoted, still one Memory row, reported promoted", async () => {
    expect(memoryId, "case (a) recorded the incomplete promotion's memory id").not.toBe("");
    expect(armed(UPDATE_FAIL, candidateId), "case (a) consumed the one-shot fault").toBe(false);
    rmSync(join(faultDir, `fired.${UPDATE_FAIL}.${candidateId}`), { force: true });

    const body = await sweep(harper, agent);

    expect(fired(UPDATE_FAIL, candidateId), "no fault in this sweep").toBe(false);
    expect(body.incomplete).toEqual([]);
    expect(body.unconfirmed).toEqual([]);
    expect(body.promoted, "the recorded row is adopted and reported promoted").toEqual([memoryId]);
    expect(body.count).toBe(1);
    expect(body.skipped).toEqual([]);

    const rows = await rowsWithClaim(harper, agent.id, claim);
    expect(rows.map((r) => r.id), "no second Memory row was written").toEqual([memoryId]);
    expect(rows[0].promotionStatus).toBe("approved");

    const cand = await readCandidate(harper, candidateId);
    expect(cand.status).toBe("promoted");
    expect(cand.target).toBe("memory");
    expect(cand.reviewerId).toBe(MACHINE_REVIEWER_ADK_AUTO_PROMOTE);
    expect(cand.promotedRowId).toBe(memoryId);
    expect(cand.decidedAt, "the candidate records when the verdict was stamped").toBe(rows[0].promotedAt);

    // A third sweep has nothing left to do.
    const again = await sweep(harper, agent);
    expect(again.considered).toBe(0);
    expect(again.promoted).toEqual([]);
    expect((await rowsWithClaim(harper, agent.id, claim)).length).toBe(1);
  }, 120_000);

  it("(c1) every Memory write counts toward the cap, an incomplete one included", async () => {
    const capAgent = mkAgent("ap2714-agent-cap-writes");
    await seedAgent(harper, capAgent);
    const claims: Record<string, string> = {
      "ap2714-capw-1": "Deploy windows close at five in the afternoon on Fridays.",
      "ap2714-capw-2": "The on-call rotation hands over every Monday at nine.",
      "ap2714-capw-3": "Design reviews require two approvals before merge.",
    };
    for (const [id, text] of Object.entries(claims)) {
      await seedCandidate(harper, capAgent.id, id, text);
      arm(UPDATE_FAIL, id);
    }

    // limit 2, every candidate update fails: each Memory write counts, so the
    // sweep stops after two candidates and leaves the third untouched.
    const first = await sweep(harper, capAgent, { limit: 2 });
    expect(first.count).toBe(0);
    expect(first.promoted).toEqual([]);
    expect(first.considered, "an incomplete promotion's Memory write counts toward the cap").toBe(2);
    expect(first.incomplete.length).toBe(2);
    const attempted = first.incomplete.map((e: any) => e.candidateId as string);
    const untouched = Object.keys(claims).filter((id) => !attempted.includes(id));
    expect(untouched.length).toBe(1);
    expect(armed(UPDATE_FAIL, untouched[0]), "the third candidate was not attempted").toBe(true);
    expect((await rowsWithClaim(harper, capAgent.id, claims[untouched[0]])).length).toBe(0);
    expect((await memoryRowsForAgent(harper, capAgent.id)).length).toBe(2);

    // Disarm the third; the next sweep adopts the two recorded rows and writes
    // the third.
    rmSync(join(faultDir, `arm.${UPDATE_FAIL}.${untouched[0]}`), { force: true });
    const second = await sweep(harper, capAgent, { limit: 5 });
    expect(second.incomplete).toEqual([]);
    expect(second.count).toBe(3);
    for (const e of first.incomplete) expect(second.promoted).toContain(e.memoryId);
    const rows = await memoryRowsForAgent(harper, capAgent.id);
    expect(rows.length, "no second row for any candidate").toBe(3);
    for (const [id, text] of Object.entries(claims)) {
      const cand = await readCandidate(harper, id);
      expect(cand.status, `${id} ends promoted`).toBe("promoted");
      expect(rows.find((r) => r.id === cand.promotedRowId)?.content, `${id} points at its own row`).toBe(text);
    }
  }, 180_000);

  it("(c2) an adoption counts toward the cap, though it writes no Memory row", async () => {
    const capAgent = mkAgent("ap2714-agent-cap-adopt");
    await seedAgent(harper, capAgent);
    const claims: Record<string, string> = {
      "ap2714-capa-1": "Incident reviews are published within three working days.",
      "ap2714-capa-2": "Staging is refreshed from production every Sunday night.",
      "ap2714-capa-3": "Feature flags are removed one release after full rollout.",
    };
    for (const [id, text] of Object.entries(claims)) {
      await seedCandidate(harper, capAgent.id, id, text);
      arm(UPDATE_FAIL, id);
    }
    const first = await sweep(harper, capAgent, { limit: 3 });
    expect(first.incomplete.length).toBe(3);
    const recorded = new Map<string, string>(first.incomplete.map((e: any) => [e.candidateId, e.memoryId]));

    // Every candidate now has an adoptable recorded row: limit 1 adopts one.
    const second = await sweep(harper, capAgent, { limit: 1 });
    expect(second.considered, "the adoption counts toward the cap").toBe(1);
    expect(second.count).toBe(1);
    expect([...recorded.values()]).toContain(second.promoted[0]);

    const third = await sweep(harper, capAgent, { limit: 5 });
    expect(third.count).toBe(2);
    const rows = await memoryRowsForAgent(harper, capAgent.id);
    expect(rows.length, "adoptions write no row").toBe(3);
    for (const [cand, mem] of recorded) {
      const row = await readCandidate(harper, cand);
      expect(row.status, `${cand} ends promoted`).toBe("promoted");
      expect(row.promotedRowId, `${cand} keeps its recorded row`).toBe(mem);
    }
  }, 180_000);

  // (d) The adoption gate: only a row carrying this sweep's own approval, bound
  // to its current content and with a promotedAt, is adopted. Each tamper below
  // is applied through the admin operations API (it bypasses the resource
  // layer, so it leaves the row's incarnation token unchanged) to the recorded
  // row of an incomplete promotion; the next sweep must not adopt it.
  const tampers: { slug: string; fields: Record<string, unknown> }[] = [
    { slug: "reviewer", fields: { promotedBy: "someone-else" } },
    { slug: "status", fields: { promotionStatus: "rejected" } },
    { slug: "binding", fields: { promotionContentHash: "0".repeat(64) } },
    { slug: "promotedat", fields: { promotedAt: null } },
  ];
  for (const tamper of tampers) {
    it(`(d) a recorded row with another ${tamper.slug} on its verdict is not adopted`, async () => {
      const gateAgent = mkAgent(`ap2714-agent-gate-${tamper.slug}`);
      const cid = `ap2714-gate-${tamper.slug}`;
      const text = `Gate case ${tamper.slug}: the archive job runs nightly at two.`;
      const recordedId = await seedIncomplete(gateAgent, cid, text);
      const before = await readMemory(harper, recordedId);
      const res = await adminOp(harper, { operation: "update", database: "flair", table: "Memory", records: [{ id: recordedId, ...tamper.fields }] });
      expect(res.status, `tamper update returned ${res.status}`).toBe(200);
      const tampered = await readMemory(harper, recordedId);
      expect(tampered.instanceToken, "the tamper keeps the incarnation token").toBe(before.instanceToken);
      for (const [field, value] of Object.entries(tamper.fields)) expect(tampered[field] ?? null).toBe(value);

      const second = await sweep(harper, gateAgent);
      expect(second.incomplete).toEqual([]);
      expect(second.promoted.length).toBe(1);
      expect(second.promoted[0], "the tampered row is not adopted").not.toBe(recordedId);
      const rows = await rowsWithClaim(harper, gateAgent.id, text);
      expect(rows.length, "the sweep wrote its own row").toBe(2);
      const cand = await readCandidate(harper, cid);
      expect(cand.status).toBe("promoted");
      expect(cand.promotedRowId).toBe(second.promoted[0]);
    }, 120_000);
  }

  it("(e) the candidate update commits and then throws: the confirming read reports it promoted", async () => {
    const commitAgent = mkAgent("ap2714-agent-commit-throw");
    await seedAgent(harper, commitAgent);
    const cid = "ap2714-commit-throw";
    const text = "Postmortems name a single owner for every follow-up action.";
    await seedCandidate(harper, commitAgent.id, cid, text);
    arm(COMMIT_THROW, cid);

    const body = await sweep(harper, commitAgent);

    expect(fired(COMMIT_THROW, cid), "the commit-then-throw fault fired").toBe(true);
    expect(body.incomplete, "a committed update is not reported incomplete").toEqual([]);
    expect(body.unconfirmed).toEqual([]);
    expect(body.promoted.length).toBe(1);
    expect(body.count).toBe(1);
    const rows = await rowsWithClaim(harper, commitAgent.id, text);
    expect(rows.map((r) => r.id)).toEqual([body.promoted[0]]);
    const cand = await readCandidate(harper, cid);
    expect(cand.status).toBe("promoted");
    expect(cand.promotedRowId).toBe(body.promoted[0]);
  }, 120_000);

  it("(f) the update throws and the confirming read fails: unconfirmed, not incomplete; the next sweep adopts", async () => {
    const readAgent = mkAgent("ap2714-agent-unreadable");
    await seedAgent(harper, readAgent);
    const cid = "ap2714-unreadable";
    const text = "Customer escalations are acknowledged within one business hour.";
    await seedCandidate(harper, readAgent.id, cid, text);
    arm(UPDATE_FAIL_UNREADABLE, cid);

    const body = await sweep(harper, readAgent);

    expect(fired(UPDATE_FAIL_UNREADABLE, cid)).toBe(true);
    expect(body.promoted).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.incomplete, "an unreadable outcome is not reported pending").toEqual([]);
    expect(body.unconfirmed.length).toBe(1);
    const entry = body.unconfirmed[0];
    expect(entry.candidateId).toBe(cid);
    expect(entry.error).toContain(FAULT_MESSAGE);
    expect(entry.readBack).toBe(`read failed: ${READ_FAULT_MESSAGE}`);
    const rows = await rowsWithClaim(harper, readAgent.id, text);
    expect(rows.map((r) => r.id)).toEqual([entry.memoryId]);

    // The update threw before Harper's put, so the candidate is in fact
    // pending, and the next sweep adopts the recorded row.
    expect((await readCandidate(harper, cid)).status).toBe("pending");
    const next = await sweep(harper, readAgent);
    expect(next.promoted).toEqual([entry.memoryId]);
    expect((await rowsWithClaim(harper, readAgent.id, text)).length).toBe(1);
  }, 120_000);

  it("(g) an owner edit between the adoption's selection and its lock: the candidate is not marked promoted on the edited row", async () => {
    const editAgent = mkAgent("ap2714-agent-edit-first");
    const cid = "ap2714-edit-first";
    const text = "Quarterly planning starts in the second week of the quarter.";
    const recordedId = await seedIncomplete(editAgent, cid, text);
    const EDITED = "Quarterly planning starts in the first week of the quarter.";

    const { response, competed, released, paused } = await withPaused(
      "auto-promote-adopt-selected",
      () => sweepResponse(harper, editAgent),
      async () => {
        const patch = await authSend(harper, editAgent, "PATCH", `/Memory/${recordedId}`, { content: EDITED });
        return { status: patch.status, text: (await patch.text()).slice(0, 300) };
      },
    );
    expect(paused, "the adoption did not pause after its selection").toBe(true);
    expect(released).toBe("go");
    expect(competed?.status, `the owner's edit was not applied: ${competed?.text}`).toBe(204);
    const edited = await readMemory(harper, recordedId);
    expect(edited.content).toBe(EDITED);
    expect(edited.promotionStatus ?? null, "the owner's content edit cleared the verdict").toBeNull();

    const text2 = await response.text();
    expect(response.status, text2.slice(0, 300)).toBe(200);
    const body = JSON.parse(text2);
    expect(body.promoted, "the edited row is not adopted").toEqual([]);
    expect(body.skipped).toEqual([{ id: cid, reason: "recorded_row_changed" }]);
    const cand = await readCandidate(harper, cid);
    expect(cand.status, "the candidate is not marked promoted pointing at the edited row").toBe("pending");
    expect(cand.promotedRowId).toBe(recordedId);

    // The next sweep no longer finds a qualifying recorded row and writes its own.
    const next = await sweep(harper, editAgent);
    expect(next.promoted.length).toBe(1);
    expect(next.promoted[0]).not.toBe(recordedId);
    const after = await readCandidate(harper, cid);
    expect(after.status).toBe("promoted");
    expect(after.promotedRowId).toBe(next.promoted[0]);
  }, 120_000);

  it("(h) an owner edit that arrives while the adoption holds the lock waits for it, then clears the verdict on the adopted row", async () => {
    const editAgent = mkAgent("ap2714-agent-edit-after");
    const cid = "ap2714-edit-after";
    const text = "Release candidates soak in staging for forty-eight hours.";
    const recordedId = await seedIncomplete(editAgent, cid, text);
    const EDITED = "Release candidates soak in staging for twenty-four hours.";

    let patchSettledWhilePaused = true;
    let patchPromise: Promise<Response> | undefined;
    const { response, released, paused } = await withPaused(
      "auto-promote-adopt-locked",
      () => sweepResponse(harper, editAgent),
      async () => {
        let settled = false;
        patchPromise = authSend(harper, editAgent, "PATCH", `/Memory/${recordedId}`, { content: EDITED });
        patchPromise.then(() => { settled = true; }, () => { settled = true; });
        // Well inside the owner verb's lock budget (memory-write-lock.ts).
        await new Promise((r) => setTimeout(r, 500));
        patchSettledWhilePaused = settled;
      },
    );
    expect(paused, "the adoption did not pause while holding the lock").toBe(true);
    expect(released).toBe("go");
    expect(patchSettledWhilePaused, "the owner's edit waits for the adoption's Memory lock").toBe(false);
    const patch = await patchPromise!;
    expect(patch.status, (await patch.clone().text()).slice(0, 300)).toBe(204);

    const body = JSON.parse(await response.text());
    expect(body.promoted, "the row qualified under the lock and was adopted").toEqual([recordedId]);
    const cand = await readCandidate(harper, cid);
    expect(cand.status).toBe("promoted");
    expect(cand.promotedRowId).toBe(recordedId);
    // The edit landed after the candidate update: it cleared the verdict on the
    // row the candidate points to, as an edit to any promoted Memory does.
    const edited = await readMemory(harper, recordedId);
    expect(edited.content).toBe(EDITED);
    expect(edited.promotionStatus ?? null).toBeNull();
  }, 120_000);
});
