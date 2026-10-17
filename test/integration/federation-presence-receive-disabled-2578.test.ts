/**
 * federation-presence-receive-disabled-2578.test.ts — flair#2578 slice 1: with
 * the receive flag OFF (the default), an eligible Presence record reaching
 * receipt skips as `presence_receive_disabled`; earlier key/classifier refusals
 * answer first. Real Harper.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const PEER = "fpdis-peer";
const peerKeys = nacl.sign.keyPair();
const AGENT = "fpdis-agent";

let harper: HarperInstance;
const basicAuth = () => "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ operation: "insert", database: "flair", table, records: [row] }),
    signal: AbortSignal.timeout(20_000),
  });
  expect(res.status).toBe(200);
}

async function readRow(table: string, id: string): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ operation: "search_by_hash", database: "flair", table, hash_values: [id], get_attributes: ["*"] }),
    signal: AbortSignal.timeout(20_000),
  });
  const rows = await res.json() as any[];
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
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

beforeAll(async () => {
  // No FLAIR_FEDERATION_PRESENCE_RECEIVE — the default-off path.
  harper = await startHarper();
  const now = new Date().toISOString();
  await insertRow("Peer", { id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: now });
  await insertRow("Agent", { id: AGENT, name: AGENT, role: "agent", publicKey: "k-dis", createdAt: now, originatorInstanceId: PEER });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair#2578 slice 1 — Presence receive flag OFF (real Harper)", () => {
  it("skips a known Presence record as presence_receive_disabled, never unknown_table, and stores nothing", async () => {
    const res = await sendBatch([
      {
        table: "Presence",
        id: AGENT,
        updatedAt: new Date().toISOString(),
        data: { id: AGENT, agentId: AGENT, lastHeartbeatAt: Date.now(), activity: "coding", originatorInstanceId: PEER },
      },
    ]);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.merged).toBe(0);
    expect(body.skippedReasons, JSON.stringify(body)).toEqual({ presence_receive_disabled: 1 });
    expect(body.refused).toEqual([{ table: "Presence", id: AGENT, reason: "presence_receive_disabled" }]);
    expect(await readRow("Presence", AGENT)).toBeNull();
  }, 60_000);

  it("leaves the rest of the receive path unchanged (a Memory record still merges)", async () => {
    const id = `fpdis-mem-${Date.now()}`;
    const res = await sendBatch([
      {
        table: "Memory",
        id,
        updatedAt: new Date().toISOString(),
        data: { id, agentId: AGENT, content: `body ${id}`, contentHash: `hash-${id}`, durability: "persistent", visibility: "shared", archived: false, createdAt: new Date().toISOString() },
      },
    ]);
    const body = await res.json() as any;
    expect(body.merged, JSON.stringify(body)).toBe(1);
    expect(await readRow("Memory", id)).not.toBeNull();
  }, 60_000);
});
