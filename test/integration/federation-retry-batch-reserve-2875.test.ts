/**
 * federation-retry-batch-reserve-2875.test.ts — flair#2875 (real Harper sender).
 *
 * The sender reserves a Memory row's retry attempt immediately before the batch
 * carrying that row is sent. A selection spanning more than one batch whose
 * first batch fails therefore leaves the rows of the batches the run never
 * reached with the attempts and lastAttemptAt they had stored.
 *
 * The sender is a real, ephemeral, loopback, HOME-isolated Harper. The hub is a
 * stand-in that answers FederationSync with the receiver's response shape
 * (`merged`, `skipped`, `refused`, `indeterminate`), and refuses the first
 * Memory batch with a status the sender does not split and retry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { keystore } from "../../src/keystore";
import { retryEntryKey } from "../../src/lib/federation-retry-row";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const SENDER_ID = "flair_spoke_a";
const HUB_ID = "flair_hub_a";
const AGENT = "agent-a";

/** The sender's per-batch record cap; a run of ROWS rows therefore spans three batches. */
const RECORDS_PER_BATCH = 50;
const ROWS = 120;

const senderSeed = new Uint8Array(randomBytes(32));
const senderKp = nacl.sign.keyPair.fromSeed(senderSeed);
const hubKp = nacl.sign.keyPair();
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

type HubMode = "merge" | "fail-first-batch";

let sender: HarperInstance;
let hub: ReturnType<typeof Bun.serve> | null = null;
let hubMode: HubMode = "merge";
let firstBatchRefused = false;
/** Memory ids the hub received during the last sync, in arrival order. */
let received: string[] = [];
/** Record count of each Memory batch the hub received during the last sync. */
let batchSizes: number[] = [];

const basic = (h: HarperInstance) => "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(sender.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic(sender) },
    body: JSON.stringify({ database: "flair", ...operation }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function readAllRetries(): Promise<Map<string, any>> {
  const rows = await ops({ operation: "sql", sql: "SELECT * FROM flair.FederationRetry" });
  const list = (Array.isArray(rows) ? rows : (rows?.results ?? [])) as any[];
  return new Map(list.map((row) => [String(row.id), row]));
}

async function clearTable(table: string): Promise<void> {
  const rows = await ops({ operation: "sql", sql: `SELECT id FROM flair.${table}` });
  for (const row of (Array.isArray(rows) ? rows : (rows?.results ?? [])) as any[]) {
    await ops({ operation: "delete", table, hash_values: [String(row.id)] });
  }
}

async function setCursor(iso: string): Promise<void> {
  await ops({ operation: "update", table: "Peer", records: [{ id: HUB_ID, lastSyncAt: iso, updatedAt: new Date().toISOString() }] });
}

function memoryRow(id: string, at: string): Record<string, unknown> {
  return {
    id,
    agentId: AGENT,
    content: `content ${id}`,
    contentHash: `hash-${id}`,
    durability: "standard",
    visibility: "shared",
    archived: false,
    provenance: JSON.stringify({ verified: { agentId: AGENT } }),
    createdAt: at,
    updatedAt: at,
  };
}

const retryKey = (id: string) => retryEntryKey(HUB_ID, "Memory", id);

function retryRow(id: string, at: string): Record<string, unknown> {
  return {
    id: retryKey(id),
    peerId: HUB_ID,
    table: "Memory",
    recordId: id,
    state: "pending",
    firstRefusedAt: at,
    attempts: 1,
    lastReason: "merge_target_busy",
    lastAttemptAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Seed `count` Memory rows behind the cursor, each with a due pending retry
 * row, so the retry path alone selects the whole set.
 */
async function seedSelection(count: number, prefix: string): Promise<string[]> {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const ids: string[] = [];
  const memories: Record<string, unknown>[] = [];
  const retries: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    ids.push(id);
    memories.push(memoryRow(id, at));
    retries.push(retryRow(id, at));
  }
  await ops({ operation: "insert", table: "Memory", records: memories });
  await ops({ operation: "insert", table: "FederationRetry", records: retries });
  await setCursor(new Date().toISOString());
  return ids;
}

async function sync(mode: HubMode): Promise<{ pushed: number; skipped: number; error?: Error }> {
  hubMode = mode;
  firstBatchRefused = false;
  received = [];
  batchSizes = [];
  const { runFederationSyncOnce } = await import("../../src/cli");
  return runFederationSyncOnce({
    target: sender.httpURL,
    opsTarget: sender.opsURL,
    adminUser: sender.admin.username,
    adminPass: sender.admin.password,
  });
}

beforeAll(async () => {
  keystore.setPrivateKeySeed(SENDER_ID, senderSeed);
  hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/FederationSync" || req.method !== "POST") return new Response("not found", { status: 404 });
      const body = await req.json() as any;
      const records = (Array.isArray(body.records) ? body.records : []) as Array<{ table: string; id: string }>;
      // One batch carries one table; the mode applies to Memory batches.
      const memory = records.length > 0 && records[0].table === "Memory";
      if (!memory) return Response.json({ merged: records.length, skipped: 0, refused: [], indeterminate: [] });
      received.push(...records.map((r) => String(r.id)));
      batchSizes.push(records.length);
      if (hubMode === "fail-first-batch" && !firstBatchRefused) {
        firstBatchRefused = true;
        // A status the sender neither splits nor treats as an outcome.
        return new Response("hub unavailable", { status: 404 });
      }
      return Response.json({ merged: records.length, skipped: 0, refused: [], indeterminate: [] });
    },
  });
  sender = await startHarper({});
  for (const url of [sender.httpURL, sender.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], `${url} must be loopback`).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must avoid ports 9925/9926`).not.toContain(u.port);
  }
  expect(sender.process?.pid).toBeGreaterThan(0);

  const now = new Date().toISOString();
  await ops({ operation: "insert", table: "Instance", records: [{ id: SENDER_ID, publicKey: b64url(senderKp.publicKey), role: "spoke", createdAt: now }] });
  await ops({
    operation: "insert",
    table: "Peer",
    records: [{ id: HUB_ID, publicKey: b64url(hubKp.publicKey), role: "hub", status: "paired", endpoint: `http://127.0.0.1:${hub.port}`, createdAt: now }],
  });
}, 240_000);

beforeEach(async () => {
  await clearTable("FederationRetry");
  await clearTable("Memory");
}, 180_000);

afterAll(async () => {
  if (hub) hub.stop(true);
  if (sender) await stopHarper(sender);
}, HARPER_STOP_BUDGET_MS + 30_000);

describe("flair#2875 — attempts are reserved per batch, just before that batch is sent", () => {
  it("a failed first batch leaves the rows of the never-sent batches at their stored attempts and lastAttemptAt", async () => {
    const ids = await seedSelection(ROWS, "memory-batch");
    const before = await readAllRetries();
    expect(before.size).toBe(ROWS);
    for (const id of ids) {
      expect(before.get(retryKey(id))?.attempts, JSON.stringify(before.get(retryKey(id)))).toBe(1);
    }

    const failed = await sync("fail-first-batch");
    expect(failed.error, "the refused first batch did not fail the run").toBeDefined();

    // Three batches would be needed; only the first was offered.
    expect(received.length, `the hub received ${received.length} records`).toBe(RECORDS_PER_BATCH);
    expect(ROWS).toBeGreaterThan(2 * RECORDS_PER_BATCH);
    expect(batchSizes).toEqual([RECORDS_PER_BATCH]);

    const after = await readAllRetries();
    expect(after.size).toBe(ROWS);
    const offered = new Set(received);
    const sentRows = [...after.values()].filter((row) => offered.has(String(row.recordId)));
    const unsentRows = [...after.values()].filter((row) => !offered.has(String(row.recordId)));
    expect(sentRows.length).toBe(RECORDS_PER_BATCH);
    expect(unsentRows.length).toBe(ROWS - RECORDS_PER_BATCH);

    for (const row of sentRows) {
      expect(row.attempts, `${row.id} was not reserved exactly once: ${JSON.stringify(row)}`).toBe(2);
      expect(Date.parse(row.lastAttemptAt), `${row.id} kept its stored lastAttemptAt`).toBeGreaterThan(
        Date.parse(before.get(row.id)!.lastAttemptAt),
      );
    }
    for (const row of unsentRows) {
      expect(row.attempts, `${row.id} lost an attempt without being offered: ${JSON.stringify(row)}`).toBe(1);
      expect(row.lastAttemptAt, `${row.id} moved lastAttemptAt without being offered`).toBe(before.get(row.id)!.lastAttemptAt);
    }
  }, 420_000);

  it("a successful run reserves each row exactly once", async () => {
    const ids = await seedSelection(ROWS, "memory-batch-ok");
    const before = await readAllRetries();
    expect(before.size).toBe(ROWS);

    const result = await sync("merge");
    expect(result.error, String(result.error)).toBeUndefined();
    expect(result.pushed, JSON.stringify(result)).toBe(ROWS);
    expect(received.length).toBe(ROWS);
    expect(batchSizes).toEqual([RECORDS_PER_BATCH, RECORDS_PER_BATCH, ROWS - 2 * RECORDS_PER_BATCH]);

    const after = await readAllRetries();
    for (const id of ids) {
      const row = after.get(retryKey(id));
      expect(row?.state, `${id}: ${JSON.stringify(row)}`).toBe("terminal");
      expect(row?.resolution).toBe("merged");
      expect(row?.attempts, `${id} was reserved more than once: ${JSON.stringify(row)}`).toBe(2);
    }
  }, 420_000);
});
