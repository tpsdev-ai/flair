// federation-content-suffix-2307.test.ts — flair#2307, the federation receive path.
//
// A paired peer pushes one signed batch to POST /FederationSync carrying a
// Memory row whose id ends in `.content` and an ordinary Memory row. The merge
// skips the first (`content_suffix_id_not_federated`) and merges the second;
// the response, the stored rows and the SyncLog row all say so.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const sfx = Date.now().toString(36);
const PEER = `fcs-peer-${sfx}`;
const AGENT = `fcs-agent-${sfx}`;
const SUFFIXED = `fcs-row-${sfx}.content`;
const SUFFIX_BASE = `fcs-row-${sfx}`;
const CONTROL = `fcs-control-${sfx}`;
const now = () => new Date().toISOString();

let harper: HarperInstance;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

const peerKeys = nacl.sign.keyPair();

function memoryRecord(id: string, content: string) {
  return {
    table: "Memory",
    id,
    data: { id, agentId: AGENT, content, visibility: "shared", createdAt: now() },
    updatedAt: now(),
  };
}

describe("flair#2307 — a federated Memory row whose id ends in `.content` is skipped", () => {
  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);
    await ops({
      operation: "upsert", database: "flair", table: "Peer",
      records: [{ id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: now() }],
    });
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("the suffixed row is skipped by name, the ordinary row merges, and SyncLog records both", async () => {
    const signed = signBodyFresh({
      instanceId: PEER,
      records: [memoryRecord(SUFFIXED, "a peer's suffixed row"), memoryRecord(CONTROL, "a peer's ordinary row")],
      lamportClock: Date.now(),
    }, peerKeys.secretKey);
    const res = await fetch(`${harper.httpURL}/FederationSync`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signed),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.merged, JSON.stringify(body)).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.skippedReasons).toEqual({ content_suffix_id_not_federated: 1 });

    const rows = await ops({
      operation: "search_by_hash", database: "flair", table: "Memory",
      hash_values: [SUFFIXED, SUFFIX_BASE, CONTROL], get_attributes: ["id", "agentId", "content"],
    });
    expect(rows).toEqual([{ id: CONTROL, agentId: AGENT, content: "a peer's ordinary row" }]);

    const logs = await ops({
      operation: "search_by_value", database: "flair", table: "SyncLog",
      search_attribute: "peerId", search_value: PEER, get_attributes: ["*"],
    });
    expect(logs.length, JSON.stringify(logs)).toBe(1);
    expect(logs[0]).toMatchObject({ direction: "pull", recordCount: 1, skippedCount: 1, status: "partial" });
    expect(JSON.parse(logs[0].skippedReasons)).toEqual({ content_suffix_id_not_federated: 1 });
  }, 60_000);
});
