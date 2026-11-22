/**
 * federation-presence-pause-2578.test.ts — flair#2578 slice 1, real Harper: the
 * Presence receipt's write-back runs the SAME conflict and indeterminate
 * handling as the generic sync merge.
 *
 * Two interleavings at the Presence merge's own pause points
 * (resources/Federation.ts, resources/txn-pause-point.ts):
 *   - a HOME change before the owned transaction opens (presence-merge-pre): the
 *     fresh home recheck during write-back sees it and the record is refused by name;
 *   - a ROW change inside the transaction (presence-merge): the committed-row
 *     confirmation sees it, the write aborts, and the key is refused as
 *     merge_target_changed — the SAME named conflict the generic merge reports.
 *
 * The spawned Harper carries the test-only pause (FLAIR_ENABLE_TEST_FAULT_INJECTION
 * and FLAIR_TEST_PAUSE_DIR) while this test starts it, then restores nothing (the
 * env is passed per-spawn).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const LOCAL_INSTANCE = "fp-pause-receiver";
const PEER = "fp-pause-peer";
const peerKeys = nacl.sign.keyPair();
const AGENT = "fp-pause-agent";

let harper: HarperInstance;
let pauseDir: string;

const basicAuth = () => "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must avoid ports 9925/9926`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

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

function presenceRecord(agentId: string, over: Record<string, unknown> = {}) {
  return {
    table: "Presence",
    id: agentId,
    updatedAt: new Date().toISOString(),
    data: {
      id: agentId,
      agentId,
      lastHeartbeatAt: Date.now(),
      activity: "coding",
      currentTask: "from peer",
      flairVersion: "0.61.0",
      harperVersion: "5.3.1",
      originatorInstanceId: PEER,
      ...over,
    },
  };
}

async function sendBatch(records: Record<string, unknown>[]): Promise<Response> {
  const body = signBodyFresh(
    { instanceId: PEER, records: records.map((r) => ({ originatorInstanceId: PEER, ...r })), lamportClock: Date.now() },
    peerKeys.secretKey,
  );
  return fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Arm `point`, start `write`, and once the merge pauses run `compete`, then
 * release. Returns the batch response and how the pause ended.
 */
async function withPausedMerge<T>(point: string, write: () => Promise<Response>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = write();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 15_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, competed, released };
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-fp-pause-"));
  harper = await startHarper({
    serverEnv: {
      FLAIR_FEDERATION_PRESENCE_RECEIVE: "1",
      FLAIR_ENABLE_TEST_FAULT_INJECTION: "1",
      FLAIR_TEST_PAUSE_DIR: pauseDir,
    },
  });
  assertOwnInstance(harper);
  const now = new Date().toISOString();
  await insertRow("Instance", { id: LOCAL_INSTANCE, publicKey: "test-instance-key", role: "spoke", createdAt: now });
  await insertRow("Peer", { id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: now });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2578 slice 1 — Presence write-back interleavings (real Harper)", () => {
  it("a HOME change before the transaction opens is refused by name, and the row is not written", async () => {
    const agent = "fp-pause-home";
    await insertRow("Agent", { id: agent, name: agent, role: "agent", publicKey: "k-home", createdAt: new Date().toISOString(), originatorInstanceId: PEER });
    const { response, competed, released } = await withPausedMerge(
      "presence-merge-pre",
      () => sendBatch([presenceRecord(agent)]),
      () => ops({ operation: "update", database: "flair", table: "Agent", records: [{ id: agent, originatorInstanceId: "some-other-instance" }] }).then(() => "applied"),
    );
    expect(released, "the merge was not paused and released by this test").toBe("go");
    expect(competed, "the competing home change failed").toBe("applied");
    const body = await response.json() as any;
    expect(body.refused, JSON.stringify(body)).toEqual([{ table: "Presence", id: agent, reason: "presence_agent_homed_elsewhere" }]);
    expect(await readRow("Presence", agent)).toBeNull();
  }, 60_000);

  it("a ROW change inside the transaction refuses the key as merge_target_changed, and the competing row is kept", async () => {
    const agent = "fp-pause-row";
    const hbOld = Date.now() - 5_000;
    await insertRow("Agent", { id: agent, name: agent, role: "agent", publicKey: "k-row", createdAt: new Date().toISOString(), originatorInstanceId: PEER });
    await insertRow("Presence", { agentId: agent, lastHeartbeatAt: hbOld, activity: "coding", currentTask: "stored", activityUpdatedAt: hbOld });
    const { response, competed, released } = await withPausedMerge(
      "presence-merge",
      () => sendBatch([presenceRecord(agent, { lastHeartbeatAt: hbOld + 1_000, currentTask: "from peer" })]),
      () => ops({ operation: "update", database: "flair", table: "Presence", records: [{ agentId: agent, currentTask: "competing" }] }).then(() => "applied"),
    );
    expect(released, "the merge was not paused and released by this test").toBe("go");
    expect(competed, "the competing row change failed").toBe("applied");
    const body = await response.json() as any;
    expect(body.refused, JSON.stringify(body)).toEqual([{ table: "Presence", id: agent, reason: "merge_target_changed" }]);
    const row = await readRow("Presence", agent);
    expect(row.currentTask).toBe("competing");
  }, 60_000);
});
