/**
 * federation-peer-field-update-1835.test.ts — flair#1835 PR-B MERGE BLOCKER.
 *
 * The design replaces `persistLocalPeerLastSyncAt`'s read + FULL-row upsert with
 * a FIELD-ONLY `update` (`{id, lastSyncAt, updatedAt}`). That is only safe if the
 * supported Harper guarantees BOTH:
 *   (a) `operation: "update"` preserves every OTHER field of the targeted row, and
 *   (b) it does NOT insert when the id matches no row.
 *
 * This boots a real, HOME-isolated Harper (startHarper: ROOTPATH=HOME=<temp>) and
 * proves both against the pinned Harper version, plus the result-check contract
 * (`update_hashes` / `skipped_hashes`) the new write depends on. If Harper could
 * not guarantee these, the design would have to change — this is the gate.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { persistLocalPeerLastSyncAt } from "../../src/commands/federation.ts";

let harper: HarperInstance;

const LEGACY = "flair_legacy_hub_1835";
const ABSENT = "flair_absent_peer_1835";
const SEED_PAIRED_AT = "2026-01-01T00:00:00.000Z";
const SEED_CREATED_AT = "2026-01-01T00:00:00.000Z";

function auth(): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

async function ops(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth() },
    body: JSON.stringify(op),
  });
}

async function searchPeer(id: string): Promise<any[]> {
  const res = await ops({
    operation: "search_by_value",
    schema: "flair",
    table: "Peer",
    search_attribute: "id",
    search_type: "equals",
    search_value: id,
    get_attributes: ["*"],
  });
  expect(res.ok, `search failed: ${res.status}`).toBe(true);
  return (await res.json()) as any[];
}

describe("flair#1835 PR-B — Harper field-only update is safe (merge blocker)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    // A legacy spoke-side hub row: paired before the public key was recorded.
    const seed = await ops({
      operation: "upsert",
      database: "flair",
      table: "Peer",
      records: [{
        id: LEGACY,
        publicKey: "",
        role: "hub",
        status: "paired",
        endpoint: "https://hub.example",
        lastSyncAt: "",
        relayOnly: false,
        pairedAt: SEED_PAIRED_AT,
        createdAt: SEED_CREATED_AT,
        updatedAt: SEED_PAIRED_AT,
      }],
    });
    expect(seed.ok, `seed Peer: ${seed.status} ${await seed.text()}`).toBe(true);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("(a) the field-only update preserves every other field of a keyless row", async () => {
    const stamp = new Date().toISOString();
    const result = await persistLocalPeerLastSyncAt({
      opsEndpoint: harper.opsURL,
      auth: auth(),
      peerId: LEGACY,
      lastSyncAt: stamp,
    });
    expect(result.ok).toBe(true);

    const rows = await searchPeer(LEGACY);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.lastSyncAt).toBe(stamp);
    expect(row.updatedAt).toBe(stamp);
    // Every other field is untouched — the keyless publicKey especially.
    expect(row.publicKey).toBe("");
    expect(row.role).toBe("hub");
    expect(row.status).toBe("paired");
    expect(row.endpoint).toBe("https://hub.example");
    expect(row.relayOnly).toBe(false);
    expect(row.pairedAt).toBe(SEED_PAIRED_AT);
    expect(row.createdAt).toBe(SEED_CREATED_AT);
  }, 30_000);

  test("(a2) a key repair is not reverted by a following cursor update", async () => {
    const repaired = "repaired-public-key-b64url";
    const repair = await ops({
      operation: "update",
      database: "flair",
      table: "Peer",
      records: [{ id: LEGACY, publicKey: repaired }],
    });
    expect(repair.ok, `repair: ${repair.status}`).toBe(true);

    const stamp = new Date().toISOString();
    const result = await persistLocalPeerLastSyncAt({
      opsEndpoint: harper.opsURL,
      auth: auth(),
      peerId: LEGACY,
      lastSyncAt: stamp,
    });
    expect(result.ok).toBe(true);
    expect((await searchPeer(LEGACY))[0].publicKey).toBe(repaired);
  }, 30_000);

  test("(b) an update on a missing id does NOT insert; the function refuses", async () => {
    const result = await persistLocalPeerLastSyncAt({
      opsEndpoint: harper.opsURL,
      auth: auth(),
      peerId: ABSENT,
      lastSyncAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toMatch(/re-?pair|#1837|repair/i);
    // Nothing was created.
    expect(await searchPeer(ABSENT)).toEqual([]);
  }, 30_000);

  test("the result-check contract: Harper reports update_hashes/skipped_hashes", async () => {
    const stamp = new Date().toISOString();
    const hit = await ops({
      operation: "update",
      database: "flair",
      table: "Peer",
      records: [{ id: LEGACY, lastSyncAt: stamp, updatedAt: stamp }],
    });
    const hitBody = (await hit.json()) as any;
    expect(Array.isArray(hitBody.update_hashes)).toBe(true);
    expect(hitBody.update_hashes).toContain(LEGACY);

    const miss = await ops({
      operation: "update",
      database: "flair",
      table: "Peer",
      records: [{ id: ABSENT, lastSyncAt: stamp, updatedAt: stamp }],
    });
    const missBody = (await miss.json()) as any;
    expect(missBody.update_hashes ?? []).not.toContain(ABSENT);
    expect(missBody.skipped_hashes ?? []).toContain(ABSENT);
  }, 30_000);
});
