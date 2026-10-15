/** Real-Harper coverage for validated unique keys and both sides of commit submission. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { SKIP_REASONS } from "../../resources/federation-classify.js";
import { parseSyncBatchCounts } from "../../src/commands/federation";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

const owner = mkAgent("frc-owner");
const peerKeys = nacl.sign.keyPair();
const PEER = "frc-peer";
const PAUSE = "federation-merge";

let harper: HarperInstance;
let pauseDir: string;

/** Refuse any target that is not the ephemeral instance this file started. */
function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const basicAuth = () => "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  await ops({ operation: "insert", database: "flair", table, records: [row] });
}

async function readRow(table: string, id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_hash", database: "flair", table, hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** One signed FederationSync push of a batch from PEER. */
async function federatedPush(records: Record<string, unknown>[]): Promise<Response> {
  const body = signBodyFresh(
    { instanceId: PEER, records: records.map((r) => ({ originatorInstanceId: PEER, ...r })), lamportClock: Date.now() },
    peerKeys.secretKey,
  );
  return fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

function memoryRecord(id: string, over: Record<string, unknown> = {}, updatedAt = new Date().toISOString()) {
  return {
    table: "Memory",
    id,
    updatedAt,
    data: {
      id, agentId: owner.id, content: `body ${id}`, contentHash: `hash-${id}`,
      durability: "persistent", visibility: "shared", archived: false,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      ...over,
    },
  };
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2455-receiver-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
  const now = new Date().toISOString();
  await insertRow("Agent", { id: owner.id, name: owner.id, role: "agent", publicKey: owner.publicKey, createdAt: now });
  await insertRow("Peer", {
    id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"),
    role: "spoke", status: "paired", createdAt: now,
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2455 slice 2 — validated batch keys and the commit-submission deadline (real Harper)", () => {
  it("a pre-submission timeout is refused after rollback", async () => {
    const id = `frc-deadline-${Date.now()}`;
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${PAUSE}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${PAUSE}`), "");

    const pending = federatedPush([memoryRecord(id)]);
    const paused = await waitFor(join(pauseDir, `paused.${PAUSE}`), 20_000);
    expect(paused, "the merge never reached its in-transaction pause").toBe(true);

    await new Promise((r) => setTimeout(r, 5_500));
    writeFileSync(join(pauseDir, `go.${PAUSE}`), "");
    const res = await pending;
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.merged, JSON.stringify(body)).toBe(0);
    expect(body.refused, JSON.stringify(body)).toEqual([{ table: "Memory", id, reason: "merge_error" }]);
    expect(await waitFor(join(pauseDir, `released.${PAUSE}`), 20_000)).toBe(true);
    for (let i = 0; i < 15; i++) {
      expect(await readRow("Memory", id), `the merge late-committed after being reported refused (poll ${i})`).toBeNull();
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 60_000);

  it("a submitted commit held past the deadline reports merged and lands", async () => {
    const id = `frc-submitted-${Date.now()}`;
    const point = "federation-merge-submitted";
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${point}`), "");
    let responded = false;
    const pending = federatedPush([memoryRecord(id)]).then((res) => {
      responded = true;
      return res;
    });
    try {
      expect(await waitFor(join(pauseDir, `paused.${point}`), 20_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 5_500));
      expect(responded, "the receiver answered while the submitted outcome was held").toBe(false);
    } finally {
      writeFileSync(join(pauseDir, `go.${point}`), "");
    }
    const res = await pending;
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.merged).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.refused).toEqual([]);
    const row = await readRow("Memory", id);
    expect(row?.content).toBe(`body ${id}`);
    expect(row?.agentId).toBe(owner.id);
  }, 60_000);

  it("a numeric key refuses the whole batch before any merge", async () => {
    const id = `frc-invalid-${Date.now()}`;
    const res = await federatedPush([
      memoryRecord(id),
      { table: "Presence", id: 42, data: { id: 42 }, updatedAt: new Date().toISOString() },
    ]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_sync_batch_key" });
    expect(await readRow("Memory", id)).toBeNull();
  }, 60_000);

  it("a duplicate key refuses the whole batch before any merge", async () => {
    const id = `frc-duplicate-${Date.now()}`;
    const record = memoryRecord(id);
    const res = await federatedPush([record, record]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "duplicate_sync_batch_key" });
    expect(await readRow("Memory", id)).toBeNull();
  }, 60_000);

  it("CONTROL: an un-paused merge lands and reports no refusal", async () => {
    const id = `frc-ok-${Date.now()}`;
    const body = await (await federatedPush([memoryRecord(id)])).json() as any;
    expect(body.merged, JSON.stringify(body)).toBe(1);
    expect(body.refused, JSON.stringify(body)).toEqual([]);
    expect(await readRow("Memory", id)).not.toBeNull();
  }, 60_000);

  it("names refused validated unique keys with a closed reason", async () => {
    const ts = Date.now();
    const mergedId = `frc-merged-${ts}`;
    const futureId = `frc-future-${ts}`;
    const noopId = `frc-noop-${ts}`;
    const unknownId = `frc-unknown-${ts}`;
    const hashNoop = `hash-noop-${ts}`;

    // A local row whose contentHash matches the push, older push → no_op_same_hash.
    await insertRow("Memory", {
      id: noopId, agentId: owner.id, content: `noop ${noopId}`, contentHash: hashNoop,
      instanceToken: randomUUID(), durability: "persistent", visibility: "shared", archived: false,
      createdAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const records = [
      memoryRecord(mergedId),
      memoryRecord(futureId, {}, new Date(Date.now() + 60 * 60 * 1000).toISOString()),
      memoryRecord(noopId, { contentHash: hashNoop }, new Date(Date.now() - 120_000).toISOString()),
      { table: "Presence", id: unknownId, updatedAt: new Date().toISOString(), data: { id: unknownId, activity: "idle" } },
    ];
    const body = await (await federatedPush(records)).json() as any;

    // These validated unique keys are merged or refused.
    expect(body.total, JSON.stringify(body)).toBe(records.length);
    expect(body.merged, JSON.stringify(body)).toBe(1);
    expect(body.merged + body.refused.length, JSON.stringify(body)).toBe(body.total);
    const offered = new Set(records.map((r) => `${r.table}/${r.id}`));
    const keys = body.refused.map((e: any) => `${e.table}/${e.id}`);
    expect(new Set(keys).size, "a refused key was listed more than once").toBe(keys.length);
    for (const entry of body.refused) {
      expect(offered.has(`${entry.table}/${entry.id}`), `refused ${entry.table}/${entry.id} was not offered`).toBe(true);
      expect(SKIP_REASONS.has(entry.reason), `reason ${entry.reason} is not in the closed enum`).toBe(true);
    }
    const reasonById = new Map(body.refused.map((e: any) => [e.id, e.reason]));
    expect(reasonById.get(futureId)).toBe("future_timestamp");
    expect(reasonById.get(noopId)).toBe("no_op_same_hash");
    expect(reasonById.get(unknownId)).toBe("unknown_table");
    expect(reasonById.has(mergedId), "the merged key was also listed refused").toBe(false);
    // Per-reason counts agree with the tally the receiver already returned.
    const counts: Record<string, number> = {};
    for (const entry of body.refused) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
    expect(counts).toEqual(body.skippedReasons);

    // The shipped sender parser ignores the added field.
    expect(parseSyncBatchCounts(body, records.length)).toEqual({ merged: body.merged, skipped: body.skipped });

    // And the refusals are real: only the mergeable record landed.
    expect(await readRow("Memory", mergedId)).not.toBeNull();
    expect(await readRow("Memory", futureId)).toBeNull();
    expect(await readRow("Memory", noopId)).not.toBeNull();
    expect(await readRow("Presence", unknownId)).toBeNull();
  }, 60_000);
});
