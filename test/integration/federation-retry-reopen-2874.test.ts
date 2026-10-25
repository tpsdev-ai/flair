/**
 * federation-retry-reopen-2874.test.ts — flair#2874 (real Harper sender).
 *
 * A retry row that reached a terminal outcome and is refused again (or left
 * undecided) is stored as a pending row whose terminal fields are null or
 * absent, and the next cycle re-offers the record. The sender is a real,
 * ephemeral, loopback, HOME-isolated Harper, whose operations-API upsert is
 * the write under test.
 * The hub is a stand-in that answers FederationSync with the receiver's
 * response shape (`merged`, `skipped`, `refused`, `indeterminate`).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { keystore } from "../../src/keystore";
import { RETRY_ROW_FIELDS, retryOfferProblem } from "../../src/lib/federation-retry-queue";
import { retryEntryKey } from "../../src/lib/federation-retry-row";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const SENDER_ID = "flair_spoke_a";
const HUB_ID = "flair_hub_a";
const AGENT = "agent-a";

const senderSeed = new Uint8Array(randomBytes(32));
const senderKp = nacl.sign.keyPair.fromSeed(senderSeed);
const hubKp = nacl.sign.keyPair();
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

type HubMode = "merge" | "refuse-busy" | "indeterminate";

let sender: HarperInstance;
let hub: ReturnType<typeof Bun.serve> | null = null;
let hubMode: HubMode = "merge";
/** Memory ids the hub received during the last sync. */
let received: string[] = [];

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

async function readRow(table: string, id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_hash", table, hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function listIds(table: string): Promise<string[]> {
  const rows = await ops({ operation: "sql", sql: `SELECT id FROM flair.${table}` });
  return ((Array.isArray(rows) ? rows : (rows?.results ?? [])) as any[]).map((row) => String(row.id));
}

async function setCursor(iso: string): Promise<void> {
  await ops({ operation: "update", table: "Peer", records: [{ id: HUB_ID, lastSyncAt: iso, updatedAt: new Date().toISOString() }] });
}

/**
 * Age every Memory row behind the cursor, then either place `id` past it (the
 * cursor selects it, as after an edit) or leave it behind (only a retry row
 * can select it).
 */
async function placeSource(id: string, cursorSelects: boolean): Promise<void> {
  const old = new Date(Date.now() - 3_600_000).toISOString();
  for (const memoryId of await listIds("Memory")) {
    await ops({ operation: "update", table: "Memory", records: [{ id: memoryId, updatedAt: old }] });
  }
  const now = Date.now();
  if (cursorSelects) {
    await ops({ operation: "update", table: "Memory", records: [{ id, updatedAt: new Date(now - 60_000).toISOString() }] });
    await setCursor(new Date(now - 120_000).toISOString());
  } else {
    await setCursor(new Date(now).toISOString());
  }
}

function memoryRow(id: string): Record<string, unknown> {
  const at = new Date(Date.now() - 3_600_000).toISOString();
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

async function sync(mode: HubMode): Promise<{ pushed: number; skipped: number; error?: Error }> {
  hubMode = mode;
  received = [];
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
      if (memory) received.push(...records.map((r) => String(r.id)));
      if (!memory || hubMode === "merge") return Response.json({ merged: records.length, skipped: 0, refused: [], indeterminate: [] });
      if (hubMode === "indeterminate") {
        return Response.json({ merged: 0, skipped: 0, refused: [], indeterminate: records.map((r) => ({ table: r.table, id: r.id })) });
      }
      const refused = records.map((r) => ({ table: r.table, id: r.id, reason: "merge_target_busy" }));
      return Response.json({ merged: 0, skipped: refused.length, refused, indeterminate: [] });
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

afterAll(async () => {
  if (hub) hub.stop(true);
  if (sender) await stopHarper(sender);
}, HARPER_STOP_BUDGET_MS + 30_000);

describe("flair#2874 — a retry row reopened after a terminal outcome", () => {
  const cases: Array<[string, HubMode, string]> = [
    ["a retryable refusal", "refuse-busy", "merge_target_busy"],
    ["an indeterminate outcome", "indeterminate", "retry_unknown"],
  ];
  for (const [label, reopenMode, reopenReason] of cases) {
    it(`${label} stores a pending row with terminal fields null or absent, and the next cycle re-offers the record`, async () => {
      const id = `memory-reopen-${reopenMode}`;
      await ops({ operation: "insert", table: "Memory", records: [memoryRow(id)] });

      // 1. The sender records a refusal, then its retry path resolves the row as merged.
      await placeSource(id, true);
      const refused = await sync("refuse-busy");
      expect(refused.error, String(refused.error)).toBeUndefined();
      const pending = await readRow("FederationRetry", retryKey(id));
      expect(pending?.state, JSON.stringify(pending)).toBe("pending");

      await placeSource(id, false);
      const merged = await sync("merge");
      expect(merged.error, String(merged.error)).toBeUndefined();
      expect(received).toEqual([id]);
      const terminal = await readRow("FederationRetry", retryKey(id));
      expect(terminal.state, JSON.stringify(terminal)).toBe("terminal");
      expect(terminal.resolution).toBe("merged");
      // The fields the terminal outcome gave a non-null value on the stored row.
      const terminalFields = RETRY_ROW_FIELDS.filter((field) => (pending[field] ?? null) === null && (terminal[field] ?? null) !== null);
      expect(terminalFields).toContain("resolution");
      expect(terminalFields).toContain("completedAt");

      // 2. The record is edited and the hub does not take it: the row reopens.
      await placeSource(id, true);
      const reopened = await sync(reopenMode);
      const stored = await readRow("FederationRetry", retryKey(id));
      expect(stored.state, JSON.stringify(stored)).toBe("pending");
      expect(stored.lastReason).toBe(reopenReason);
      for (const field of new Set([...terminalFields, "bound"])) {
        expect(stored[field] ?? null, `the reopened row kept ${field}: ${JSON.stringify(stored)}`).toBeNull();
      }
      expect(retryOfferProblem(stored)).toBeNull();
      expect(reopened.error, String(reopened.error)).toBeUndefined();

      // 3. Only the retry row can select the record now; the next cycle offers it.
      await placeSource(id, false);
      const next = await sync("merge");
      expect(next.error, String(next.error)).toBeUndefined();
      expect(received, "the reopened record was not re-offered").toEqual([id]);
      expect(next.pushed).toBe(1);
      const done = await readRow("FederationRetry", retryKey(id));
      expect(done.state, JSON.stringify(done)).toBe("terminal");
      expect(done.resolution).toBe("merged");
    }, 180_000);
  }
});
