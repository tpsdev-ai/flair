/**
 * federation-retry-reserve-fault-2875.test.ts — flair#2875 / #2904 follow-up (real Harper sender).
 *
 * A reservation write that fails partway through a batch aborts the run before
 * that batch is sent: the hub receives no POST for the batch, the rows already
 * reserved carry their reserved attempt, and the rows the run had not reached
 * keep the attempts and lastAttemptAt they had stored.
 *
 * No existing fault-injection seam covers the sender's operations-API writes:
 * the composed probe in federation-retry-probe-component.ts patches the
 * resource's own `put`, while an operations-API upsert of an existing row
 * reaches the table through the data layer. This test puts a loopback proxy in front of the
 * sender's ops endpoint and fails the second FederationRetry write of the run;
 * the proxy is test-only and nothing in the product enables it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { keystore } from "../../src/keystore";
import { retryEntryKey } from "../../src/lib/federation-retry-row";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const SENDER_ID = "flair_spoke_a";
const HUB_ID = "flair_hub_a";
const AGENT = "agent-a";

const senderSeed = new Uint8Array(randomBytes(32));
const senderKp = nacl.sign.keyPair.fromSeed(senderSeed);
const hubKp = nacl.sign.keyPair();
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

let sender: HarperInstance;
let opsProxy: ReturnType<typeof Bun.serve> | null = null;
let hub: ReturnType<typeof Bun.serve> | null = null;
/** Fail this FederationRetry write number in the run; 0 disarms. */
let failWriteAt = 0;
/** FederationRetry writes the proxy has seen since the last reset. */
let retryWrites = 0;
/** Memory ids the hub received during the last sync. */
let received: string[] = [];

const basic = (h: HarperInstance) => "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], `${url} must be loopback`).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must avoid ports 9925/9926`).not.toContain(u.port);
  }
  if (!h.installDir.startsWith(tmpdir())) throw new Error(`refusing to run: ${h.installDir} is not a temp tree`);
}

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
  return new Map((Array.isArray(rows) ? rows : (rows?.results ?? [])).map((row: any) => [String(row.id), row]));
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

/** Seed `count` Memory rows behind the cursor, each with a due pending retry row. */
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

async function sync(): Promise<{ pushed: number; skipped: number; error?: Error }> {
  received = [];
  const { runFederationSyncOnce } = await import("../../src/cli");
  return runFederationSyncOnce({
    target: sender.httpURL,
    opsTarget: opsProxy!.url.origin,
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
      received.push(...records.filter((r) => r.table === "Memory").map((r) => String(r.id)));
      return Response.json({ merged: records.length, skipped: 0, refused: [], indeterminate: [] });
    },
  });
  sender = await startHarper({});
  assertOwnInstance(sender);

  opsProxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const bodyText = req.method === "POST" ? await req.text() : "";
      let operation: any = null;
      try {
        operation = bodyText.length > 0 ? JSON.parse(bodyText) : null;
      } catch {
        operation = null;
      }
      if (operation?.table === "FederationRetry" && (operation.operation === "upsert" || operation.operation === "update")) {
        retryWrites += 1;
        if (failWriteAt > 0 && retryWrites === failWriteAt) {
          failWriteAt = 0;
          return new Response("ops proxy: forced retry write failure", { status: 500 });
        }
      }
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("content-length");
      return fetch(new URL(url.pathname + url.search, sender.opsURL), {
        method: req.method,
        headers,
        body: req.method === "POST" ? bodyText : undefined,
      });
    },
  });
  const proxyUrl = new URL(opsProxy.url);
  expect(["127.0.0.1", "localhost"], `${proxyUrl} must be loopback`).toContain(proxyUrl.hostname);
  expect(["9925", "9926"], `${proxyUrl} must avoid ports 9925/9926`).not.toContain(proxyUrl.port);

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
  retryWrites = 0;
  failWriteAt = 0;
}, 180_000);

afterAll(async () => {
  if (hub) hub.stop(true);
  if (opsProxy) opsProxy.stop(true);
  if (sender) await stopHarper(sender);
}, HARPER_STOP_BUDGET_MS + 30_000);

describe("flair#2875 — a reservation write failure aborts the batch before it is sent", () => {
  it("fails the second reservation write of a batch: no POST, one reserved row, the rest untouched", async () => {
    const ids = await seedSelection(3, "memory-fault");
    const before = await readAllRetries();
    expect(before.size).toBe(3);
    for (const id of ids) {
      expect(before.get(retryKey(id))?.attempts, JSON.stringify(before.get(retryKey(id)))).toBe(1);
    }

    // Fail the SECOND FederationRetry write of the run: the first reservation
    // succeeds, the second aborts the run before sendBatch.
    failWriteAt = 2;

    const result = await sync();
    expect(received, `the hub received ${received.length} records`).toEqual([]);
    expect(result.error, "the failed reservation did not fail the run").toBeDefined();

    const after = await readAllRetries();
    expect(after.size).toBe(3);
    const reserved = [...after.values()].filter((row) => row.attempts === 2);
    const untouched = [...after.values()].filter((row) => row.attempts === 1);
    expect(reserved.length, JSON.stringify([...after.values()])).toBe(1);
    expect(untouched.length).toBe(2);
    for (const row of reserved) {
      expect(row.state, JSON.stringify(row)).toBe("pending");
      expect(row.lastReason).toBe("merge_target_busy");
      expect(Date.parse(row.lastAttemptAt)).toBeGreaterThan(Date.parse(before.get(row.id)!.lastAttemptAt));
      expect(row.firstRefusedAt).toBe(before.get(row.id)!.firstRefusedAt);
    }
    for (const row of untouched) {
      expect(row.lastAttemptAt, JSON.stringify(row)).toBe(before.get(row.id)!.lastAttemptAt);
      expect(row.updatedAt).toBe(before.get(row.id)!.updatedAt);
    }
  }, 420_000);
});
