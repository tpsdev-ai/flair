/**
 * federation-retry-malformed-nonpending-2877.test.ts — flair#2877 (real Harper sender).
 *
 * Before an outcome write the sender reads the stored retry row whatever its
 * state. A row that breaks a sender convention is reported with its id and the
 * malformed field, and left as stored: the outcome write is skipped for it. A
 * well-formed row in a non-pending state keeps the behaviour it has on main.
 *
 * The sender is a real, ephemeral, loopback, HOME-isolated Harper. The hub is a
 * stand-in that answers FederationSync with the receiver's response shape and
 * refuses the Memory record under test for a retryable reason.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
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
let hub: ReturnType<typeof Bun.serve> | null = null;
/** Memory ids the hub received during the last sync. */
let received: string[] = [];
/** Memory ids the hub refuses with `merge_target_busy`. */
let refusedIds = new Set<string>();

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

async function readRetryRow(id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_hash", table: "FederationRetry", hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
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

function storedRetryRow(id: string, at: string, over: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...over,
  };
}

/** Seed one Memory row past the cursor, plus one stored retry row in `over`'s state. */
async function seedOne(id: string, over: Record<string, unknown>): Promise<any> {
  const at = new Date(Date.now() + 5_000).toISOString();
  await ops({ operation: "insert", table: "Memory", records: [memoryRow(id, at)] });
  await ops({ operation: "insert", table: "FederationRetry", records: [storedRetryRow(id, at, over)] });
  await setCursor(new Date(Date.now() - 3_600_000).toISOString());
  return readRetryRow(retryKey(id));
}

async function sync(): Promise<{ pushed: number; skipped: number; error?: Error }> {
  received = [];
  refusedIds = new Set();
  const { runFederationSyncOnce } = await import("../../src/cli");
  return runFederationSyncOnce({
    target: sender.httpURL,
    opsTarget: sender.opsURL,
    adminUser: sender.admin.username,
    adminPass: sender.admin.password,
  });
}

/** Run a sync while capturing console.warn, and return the warnings alongside the result. */
async function syncCapturingWarnings(): Promise<{ result: any; warnings: string[] }> {
  const warnings: string[] = [];
  const warn = mock((...args: any[]) => {
    warnings.push(String(args[0]));
  });
  const original = console.warn;
  console.warn = warn as any;
  try {
    const result = await sync();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
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
      const memory = records.filter((r) => r.table === "Memory");
      received.push(...memory.map((r) => String(r.id)));
      refusedIds = new Set(memory.map((r) => String(r.id)));
      const refused = memory.map((r) => ({ table: "Memory", id: String(r.id), reason: "merge_target_busy" }));
      return Response.json({ merged: records.length - memory.length, skipped: refused.length, refused, indeterminate: [] });
    },
  });
  sender = await startHarper({});
  assertOwnInstance(sender);

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

describe("flair#2877 — a malformed non-pending retry row is left as stored and reported", () => {
  it("a terminal row with a stray bound is unchanged on read-back and is reported with its id and field", async () => {
    const id = "memory-terminal-malformed";
    const before = await seedOne(id, { state: "terminal", resolution: "merged", bound: "attempts", completedAt: new Date().toISOString() });
    expect(before.state).toBe("terminal");

    const { result, warnings } = await syncCapturingWarnings();
    expect(result.error, String(result.error)).toBeUndefined();
    expect(received).toContain(id);

    const after = await readRetryRow(retryKey(id));
    expect(after, "the malformed row did not survive the outcome write").toEqual(before);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(warnings.some((line) =>
      line.includes(retryKey(id)) && line.includes("outcome_mismatch") && line.includes("bound"),
    ), `no malformed report for ${retryKey(id)}: ${JSON.stringify(warnings)}`).toBe(true);
  }, 240_000);

  it("a pending row with a terminal field is malformed exactly as the write read-back says (#2882 agreement)", async () => {
    const id = "memory-pending-completed";
    const before = await seedOne(id, { state: "pending", completedAt: new Date().toISOString() });
    expect(before.resolution ?? null).toBeNull();
    expect(before.bound ?? null).toBeNull();

    const { result, warnings } = await syncCapturingWarnings();
    expect(result.error, String(result.error)).toBeUndefined();

    const after = await readRetryRow(retryKey(id));
    expect(after, "the malformed pending row was transitioned").toEqual(before);
    expect(warnings.some((line) =>
      line.includes(retryKey(id)) && line.includes("outcome_mismatch") && line.includes("completedAt"),
    ), `no completedAt report for ${retryKey(id)}: ${JSON.stringify(warnings)}`).toBe(true);
  }, 240_000);

  it("a well-formed terminal row behaves as on main: the refusal starts a fresh obligation", async () => {
    const id = "memory-terminal-wellformed";
    await seedOne(id, {
      state: "terminal",
      resolution: "merged",
      bound: null,
      completedAt: new Date().toISOString(),
    });

    const { result, warnings } = await syncCapturingWarnings();
    expect(result.error, String(result.error)).toBeUndefined();
    expect(warnings.some((line) => line.includes(retryKey(id))), JSON.stringify(warnings)).toBe(false);

    const after = await readRetryRow(retryKey(id));
    expect(after.state, JSON.stringify(after)).toBe("pending");
    expect(after.attempts).toBe(1);
    expect(after.lastReason).toBe("merge_target_busy");
    expect(after.resolution ?? null).toBeNull();
    expect(after.bound ?? null).toBeNull();
    expect(after.completedAt ?? null).toBeNull();
  }, 240_000);
});
