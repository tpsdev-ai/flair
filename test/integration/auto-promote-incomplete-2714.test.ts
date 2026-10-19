// flair#2714 — an auto-promotion whose candidate update fails is reported as
// incomplete, and the next sweep finalizes it without a second Memory row.
//
// AutoPromoteCandidates writes the promoted Memory row, stamps it, and only
// then marks the candidate `promoted`. When that last write throws, the row is
// written and stamped while the candidate stays pending (the deliberate safe
// failure state). These cases run against a real ephemeral Harper:
//
//   (a) the candidate update fails once: the response lists the promotion under
//       `incomplete` (memory id, candidate id, error), not under `promoted`;
//       exactly one Memory row exists, stamped; the candidate is still pending
//       with that row recorded on it.
//   (b) the next sweep, with no fault: the candidate ends `promoted`, still
//       exactly one Memory row, and the response reports it under `promoted`.
//   (c) the per-call cap counts only candidates marked promoted: incomplete
//       promotions do not stop the sweep, and adopted rows do count.
//   (d) a recorded row whose verdict is not this sweep's own (another
//       reviewer, another status, or a binding that does not match its
//       content) is not adopted.
//
// The fault comes from a test-only module installed into a PRIVATE composed
// copy of the built component (the componentWithRetryProbe pattern,
// test/helpers/federation-retry-probe-component.ts): it makes ONE
// MemoryCandidate.put that sets `status: "promoted"` throw, when the test arms
// a marker file for that candidate id under FLAIR_TEST_PAUSE_DIR. The arm file
// is consumed by the throw. Nothing under resources/ or src/ changes.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { MACHINE_REVIEWER_ADK_AUTO_PROMOTE } from "../../resources/auto-promote-lib.ts";
import { promotionContentHash } from "../../resources/promotion-binding.ts";

const FAULT_MODULE_REL = join("dist", "resources", "zz-test-failing-candidate-update-2714.js");
const FAULT_MESSAGE = "test component: forced candidate update failure (flair#2714)";
const FAULT_MODULE_SRC = `import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { databases } from "harper";
const table = databases.flair.MemoryCandidate;
const put = table.put;
table.put = function (record, ...rest) {
  const dir = process.env.FLAIR_TEST_PAUSE_DIR;
  const id = record && record.id;
  if (dir && record && record.status === "promoted" && typeof id === "string" && /^[a-z0-9-]{1,80}$/.test(id)) {
    let armed = false;
    try {
      unlinkSync(join(dir, "arm.candidate-update-fail." + id));
      armed = true;
    } catch {
      // Not armed for this candidate.
    }
    if (armed) {
      writeFileSync(join(dir, "fired.candidate-update-fail." + id), "");
      throw new Error(${JSON.stringify(FAULT_MESSAGE)});
    }
  }
  return put.call(this, record, ...rest);
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

async function sweep(harper: HarperInstance, agent: TestAgent, body: Record<string, unknown> = {}): Promise<any> {
  const path = "/AutoPromoteCandidates";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: agent.id, ...body }),
  });
  const text = await res.text();
  expect(res.status, `sweep returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

let harper: HarperInstance;
let faultDir: string;
let appDir: string;

function armCandidateUpdateFault(candidateId: string): void {
  rmSync(join(faultDir, `fired.candidate-update-fail.${candidateId}`), { force: true });
  writeFileSync(join(faultDir, `arm.candidate-update-fail.${candidateId}`), "");
}
function faultFired(candidateId: string): boolean {
  return existsSync(join(faultDir, `fired.candidate-update-fail.${candidateId}`));
}
function faultArmed(candidateId: string): boolean {
  return existsSync(join(faultDir, `arm.candidate-update-fail.${candidateId}`));
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
  harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd(), env: { FLAIR_TEST_PAUSE_DIR: faultDir } });
  assertOwnInstance(harper);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (faultDir) rmSync(faultDir, { recursive: true, force: true });
  if (appDir) rmSync(appDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2714 — a failed candidate update is reported incomplete and finalized next cycle (real Harper)", () => {
  const agent = mkAgent("ap2714-agent-a");
  const candidateId = "ap2714-cand-a";
  const claim = "The team ships the weekly release notes every Thursday afternoon.";
  let memoryId = "";

  it("(a) the candidate update fails once: incomplete, not promoted; one stamped Memory row; candidate still pending", async () => {
    await seedAgent(harper, agent);
    await seedCandidate(harper, agent.id, candidateId, claim);
    armCandidateUpdateFault(candidateId);

    const body = await sweep(harper, agent);

    expect(faultFired(candidateId), "the injected candidate update fault fired").toBe(true);
    expect(body.promoted, "a promotion whose candidate update failed is not reported promoted").toEqual([]);
    expect(body.count).toBe(0);
    expect(body.considered).toBe(1);
    expect(body.skipped).toEqual([]);
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

  it("(b) the next sweep, no fault: the candidate ends promoted, still one Memory row, reported promoted", async () => {
    expect(memoryId, "case (a) recorded the incomplete promotion's memory id").not.toBe("");
    expect(faultArmed(candidateId), "case (a) consumed the one-shot fault").toBe(false);
    rmSync(join(faultDir, `fired.candidate-update-fail.${candidateId}`), { force: true });

    const body = await sweep(harper, agent);

    expect(faultFired(candidateId), "no fault in this sweep").toBe(false);
    expect(body.incomplete).toEqual([]);
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

  it("(c) the cap counts only candidates marked promoted: incomplete ones do not stop the sweep", async () => {
    const capAgent = mkAgent("ap2714-agent-cap");
    await seedAgent(harper, capAgent);
    const claims: Record<string, string> = {
      "ap2714-cap-1": "Deploy windows close at five in the afternoon on Fridays.",
      "ap2714-cap-2": "The on-call rotation hands over every Monday at nine.",
      "ap2714-cap-3": "Design reviews require two approvals before merge.",
    };
    for (const [id, text] of Object.entries(claims)) {
      await seedCandidate(harper, capAgent.id, id, text);
      armCandidateUpdateFault(id);
    }

    // limit 1, every candidate update fails: none counts toward the cap, so
    // all three are attempted and reported incomplete.
    const first = await sweep(harper, capAgent, { limit: 1 });
    expect(first.count).toBe(0);
    expect(first.promoted).toEqual([]);
    expect(first.considered, "an incomplete promotion does not count toward the cap").toBe(3);
    expect(first.incomplete.map((e: any) => e.candidateId).sort()).toEqual(Object.keys(claims).sort());
    for (const id of Object.keys(claims)) {
      expect(faultFired(id), `the fault fired for ${id}`).toBe(true);
      expect(faultArmed(id)).toBe(false);
      expect((await readCandidate(harper, id)).status).toBe("pending");
    }
    const memoryIdByCandidate = new Map<string, string>(first.incomplete.map((e: any) => [e.candidateId, e.memoryId]));
    expect((await memoryRowsForAgent(harper, capAgent.id)).length).toBe(3);

    // limit 1, no fault: an adopted row counts toward the cap.
    const second = await sweep(harper, capAgent, { limit: 1 });
    expect(second.incomplete).toEqual([]);
    expect(second.count).toBe(1);
    expect(second.promoted.length).toBe(1);
    const finalized = [...memoryIdByCandidate].filter(([, mem]) => mem === second.promoted[0]).map(([cand]) => cand);
    expect(finalized.length, "the promoted id is one of the recorded rows").toBe(1);

    // The rest are finalized by the next sweep; no new rows.
    const third = await sweep(harper, capAgent, { limit: 5 });
    expect(third.incomplete).toEqual([]);
    expect(third.count).toBe(2);
    for (const [cand, mem] of memoryIdByCandidate) {
      const row = await readCandidate(harper, cand);
      expect(row.status, `${cand} ends promoted`).toBe("promoted");
      expect(row.promotedRowId, `${cand} keeps its recorded row`).toBe(mem);
    }
    const rows = await memoryRowsForAgent(harper, capAgent.id);
    expect(rows.length, "no second row for any candidate").toBe(3);
    expect(rows.map((r) => r.id).sort()).toEqual([...memoryIdByCandidate.values()].sort());
  }, 180_000);

  // (d) The adoption gate: only a row carrying this sweep's own verdict, bound
  // to its current content, is adopted. Each tamper below is applied through
  // the admin operations API (it bypasses the resource layer, so it leaves the
  // row's incarnation token unchanged) to the recorded row of an incomplete
  // promotion; the next sweep must not adopt it and writes its own row.
  const tampers: { slug: string; fields: Record<string, unknown> }[] = [
    { slug: "reviewer", fields: { promotedBy: "someone-else" } },
    { slug: "status", fields: { promotionStatus: "rejected" } },
    { slug: "binding", fields: { promotionContentHash: "0".repeat(64) } },
  ];
  for (const tamper of tampers) {
    it(`(d) a recorded row with another ${tamper.slug} on its verdict is not adopted`, async () => {
      const gateAgent = mkAgent(`ap2714-agent-gate-${tamper.slug}`);
      await seedAgent(harper, gateAgent);
      const cid = `ap2714-gate-${tamper.slug}`;
      const text = `Gate case ${tamper.slug}: the archive job runs nightly at two.`;
      await seedCandidate(harper, gateAgent.id, cid, text);
      armCandidateUpdateFault(cid);

      const first = await sweep(harper, gateAgent);
      expect(first.incomplete.length).toBe(1);
      const recordedId = first.incomplete[0].memoryId;
      const before = (await rowsWithClaim(harper, gateAgent.id, text))[0];
      const res = await adminOp(harper, { operation: "update", database: "flair", table: "Memory", records: [{ id: recordedId, ...tamper.fields }] });
      expect(res.status, `tamper update returned ${res.status}`).toBe(200);
      const tampered = (await rowsWithClaim(harper, gateAgent.id, text)).find((r) => r.id === recordedId);
      expect(tampered.instanceToken, "the tamper keeps the incarnation token").toBe(before.instanceToken);

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
});
