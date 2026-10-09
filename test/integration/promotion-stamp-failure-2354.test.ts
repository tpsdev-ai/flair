/**
 * promotion-stamp-failure-2354.test.ts — flair#2354, the manual promotion
 * (POST /PromoteMemoryCandidate) when its verdict stamp fails.
 *
 * Runs against a composed copy of the built component that adds a test-only
 * module (test/helpers/host-pointer-failing-component.ts,
 * FAILING_STAMP_MODULE_SRC): a Memory table write carrying an approved verdict
 * for an agent whose id contains `stamp-failure` throws, and its message says
 * whether the write's context carried an open transaction. Everything else is
 * production. The manual workflow's Memory write and its stamp share that
 * transaction, so the failed request leaves no Memory row and the candidate
 * stays pending.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import {
  componentWithFailingPromotionStamp, FAILING_STAMP_MODULE_REL, FAILING_STAMP_MODULE_SRC, type FailingComponent,
} from "../helpers/host-pointer-failing-component";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${agent.id}:${ts}:${nonce}:${method}:${path}`), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

let harper: HarperInstance;
let component: FailingComponent;
const failing = mkAgent("psf-stamp-failure-agent");
const control = mkAgent("psf-control-agent");

/** Refuse any target that is not the ephemeral instance this file started. */
function assertOwnInstance(): void {
  for (const u of [new URL(harper.httpURL), new URL(harper.opsURL)]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} is not an instance this test started`);
  }
}
async function adminOp(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
  const text = await res.text();
  expect(res.status, `${String(op.operation)} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return JSON.parse(text);
}
async function promote(agent: TestAgent, candidateId: string): Promise<Response> {
  const path = "/PromoteMemoryCandidate";
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify({ candidateId, rationale: "reviewed the claim" }),
  });
}
async function memoryRowsFor(agentId: string): Promise<any[]> {
  const rows = await adminOp({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "agentId", search_value: agentId, get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows : [];
}
async function candidate(id: string): Promise<any> {
  return (await adminOp({ operation: "search_by_hash", database: "flair", table: "MemoryCandidate", hash_values: [id], get_attributes: ["*"] }))[0] ?? null;
}
async function seedCandidate(agentId: string, id: string, claim: string): Promise<void> {
  await adminOp({
    operation: "insert", database: "flair", table: "MemoryCandidate",
    records: [{ id, agentId, claim, status: "pending", generatedAt: new Date().toISOString(), generatedBy: "test-seed", sourceMemoryIds: [], scopeTag: `adk:app:${agentId}` }],
  });
}

beforeAll(async () => {
  component = componentWithFailingPromotionStamp();
  harper = await startHarper({ cwd: component.dir });
  assertOwnInstance();
  await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [failing, control].map((a) => ({ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() })),
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (component) component.cleanup();
});

describe("flair#2354 — a failed manual promotion stamp (real Harper)", () => {
  it("ctrl: the composed copy carries the failing stamp module, and an unmarked agent's promotion is stamped", async () => {
    expect(readFileSync(join(component.dir, FAILING_STAMP_MODULE_REL), "utf8")).toBe(FAILING_STAMP_MODULE_SRC);
    const claim = "Control promotion claim about release verification.";
    await seedCandidate(control.id, "psf-control-cand", claim);
    const res = await promote(control, "psf-control-cand");
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    const { memoryId } = await res.json() as { memoryId: string };
    const row = (await memoryRowsFor(control.id)).find((r) => r.id === memoryId);
    expect(row?.promotionStatus).toBe("approved");
    expect(row?.promotedBy).toBe(control.id);
    expect((await candidate("psf-control-cand"))?.status).toBe("promoted");
  }, 60_000);

  it("a stamp failure inside the open transaction fails the request, leaves no Memory row and the candidate pending", async () => {
    const claim = "Failing promotion claim about deploy verification.";
    await seedCandidate(failing.id, "psf-failing-cand", claim);
    const res = await promote(failing, "psf-failing-cand");
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBeGreaterThanOrEqual(500);
    expect(text, "the injected failure ran inside an open transaction").toContain("forced promotion stamp failure (transaction open)");
    // A control promotion commits after the failed request returns; the
    // absence checks run once its row is readable.
    await seedCandidate(control.id, "psf-control-after", "Second control claim about rollback verification.");
    const after = await promote(control, "psf-control-after");
    expect(after.status, (await after.clone().text()).slice(0, 300)).toBe(200);
    const { memoryId } = await after.json() as { memoryId: string };
    expect((await memoryRowsFor(control.id)).some((r) => r.id === memoryId)).toBe(true);
    expect((await memoryRowsFor(failing.id)).filter((r) => r.content === claim)).toEqual([]);
    expect((await candidate("psf-failing-cand"))?.status).toBe("pending");
  }, 60_000);
});
