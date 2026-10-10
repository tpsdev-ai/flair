/**
 * confirm-stored-row-2450.test.ts — flair#2450 items 1 and 2 (real Harper).
 *
 * Two read-then-write paths that carry a row's server-stamped incarnation token
 * (or re-write a full row) did not confirm, in the SAME transaction as the write,
 * that the stored row is still the one they read:
 *
 *   - Memory.put's admin-only `_reindex` re-PUT (item 1);
 *   - the FederationSync merge of EVERY synced table — Soul, Agent,
 *     Relationship and Message (flair#2441 covered the Memory merge only; item 2).
 *
 * Each now confirms the COMMITTED row inside the write's transaction (item 1
 * before and after staging; item 2 through the shared write-back helper, one
 * attempt). A DELETE, a PURGE (Memory has one) or a same-id REPLACE committed
 * between the read and the write leaves the row gone (never re-created) or the
 * competitor's row standing (never overwritten), and the outcome is named: 409
 * stored_row_changed for the re-PUT, and the merge_target_changed skip for the
 * merge.
 *
 * Each writer's test-only pause point (resources/txn-pause-point.ts, armed
 * through FLAIR_ENABLE_TEST_FAULT_INJECTION / FLAIR_TEST_PAUSE_DIR) holds it
 * between its read and its write while this test commits the competitor. A
 * control case per writer shows the ordinary path is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { runFederationSyncOnce } from "../../src/cli.js";
import { keystore } from "../../src/keystore.js";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

let harper: HarperInstance;
let pauseDir: string;

const owner = mkAgent("csr2-owner");
const admin = mkAgent("csr2-admin");
const peerKeys = nacl.sign.keyPair();
const PEER = "csr2-peer";

/** Refuse any target that is not the ephemeral instance this file started. */
function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

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

async function readRow(table: string, id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_hash", database: "flair", table, hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}
async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  await ops({ operation: "insert", database: "flair", table, records: [row] });
}
async function updateRow(table: string, row: Record<string, unknown>): Promise<void> {
  await ops({ operation: "update", database: "flair", table, records: [row] });
}
async function deleteRow(table: string, id: string): Promise<void> {
  await ops({ operation: "delete", database: "flair", table, ids: [id] });
}
async function purgeRow(id: string): Promise<void> {
  const res = await fetch(`${harper.httpURL}/MemoryPurge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ ids: [id] }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `MemoryPurge: ${text.slice(0, 300)}`).toBe(200);
}

function authSend(agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

/** One signed FederationSync push of a single record from PEER. */
async function federatedPush(record: Record<string, unknown>): Promise<Response> {
  const body = signBodyFresh(
    { instanceId: PEER, records: [{ originatorInstanceId: PEER, ...record }], lamportClock: Date.now() },
    peerKeys.secretKey,
  );
  return fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

/** One admin `_reindex` re-PUT of an existing row. */
function reindexPut(id: string, body: Record<string, unknown> = {}): Promise<Response> {
  return authSend(admin, "PUT", `/Memory/${id}`, { id, _reindex: true, ...body });
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Arm `point`, start `trigger`, run `compete` once the trigger is paused inside
 * that point, release, and await the trigger. Returns the trigger's response
 * and how the pause ended.
 */
async function withPaused<T>(point: string, trigger: () => Promise<Response>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, competed, released, paused };
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2450-pause-"));
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
  await ops({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: owner.id, name: owner.id, role: "agent", publicKey: owner.publicKey, createdAt: new Date().toISOString() }],
  });
  await ops({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: admin.id, name: admin.id, role: "admin", publicKey: admin.publicKey, createdAt: new Date().toISOString() }],
  });
  await ops({
    operation: "insert", database: "flair", table: "Peer",
    records: [{ id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: new Date().toISOString() }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

// ── item 1: Memory.put's admin _reindex re-PUT ───────────────────────────────

describe("flair#2450 — the _reindex re-PUT confirms the stored row (real Harper)", () => {
  const seed = (id: string, token: string) =>
    insertRow("Memory", { id, agentId: owner.id, content: `reindex ${id}`, contentHash: id, instanceToken: token, durability: "persistent", visibility: "shared", archived: false, createdAt: new Date(Date.now() - 60_000).toISOString() });

  it("a DELETE between the read and the write is refused and the row stays deleted", async () => {
    const id = `csr2-reidx-del-${Date.now()}`;
    await seed(id, randomUUID());
    const { response, released, paused } = await withPaused("memory-reindex", () => reindexPut(id), () => deleteRow("Memory", id));
    expect(paused, "the reindex re-PUT was not paused").toBe(true);
    expect(released).toBe("go");
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    expect(await readRow("Memory", id), "the re-PUT re-created the deleted row").toBeNull();
  }, 60_000);

  it("a PURGE between the read and the write is refused and the row stays purged", async () => {
    const id = `csr2-reidx-purge-${Date.now()}`;
    await seed(id, randomUUID());
    const { response, released, paused } = await withPaused("memory-reindex", () => reindexPut(id), () => purgeRow(id));
    expect(paused, "the reindex re-PUT was not paused").toBe(true);
    expect(released).toBe("go");
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    expect(await readRow("Memory", id), "the re-PUT re-created the purged row").toBeNull();
  }, 60_000);

  it("a same-id REPLACE with a new token is refused and not overwritten", async () => {
    const id = `csr2-reidx-rep-${Date.now()}`;
    const T2 = randomUUID();
    await seed(id, randomUUID());
    const { response, released, paused } = await withPaused("memory-reindex", () => reindexPut(id), async () => {
      await updateRow("Memory", { id, instanceToken: T2, content: "replaced" });
    });
    expect(paused, "the reindex re-PUT was not paused").toBe(true);
    expect(released).toBe("go");
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    const row = await readRow("Memory", id);
    expect(row?.instanceToken, "the competing incarnation token is overwritten by the stale re-PUT").toBe(T2);
    expect(row?.content, "the competing content is overwritten").toBe("replaced");
  }, 60_000);

  it("a DELETE between the staged write and its commit is refused and the row stays deleted", async () => {
    const id = `csr2-reidx-staged-del-${Date.now()}`;
    await seed(id, randomUUID());
    const { response, released, paused } = await withPaused("memory-reindex-staged", () => reindexPut(id), () => deleteRow("Memory", id));
    expect(paused, "the reindex re-PUT was not paused after staging").toBe(true);
    expect(released).toBe("go");
    expect(await readRow("Memory", id), "the re-PUT re-created the deleted row").toBeNull();
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
  }, 60_000);

  it("CONTROL: with no competitor the re-PUT lands and keeps the stored token", async () => {
    const id = `csr2-reidx-ok-${Date.now()}`;
    const TOKEN = randomUUID();
    await seed(id, TOKEN);
    const res = await reindexPut(id);
    expect(res.status, (await res.clone().text()).slice(0, 200)).toBeLessThan(300);
    const row = await readRow("Memory", id);
    expect(row?.content, "the ordinary re-PUT did not land").toBe(`reindex ${id}`);
    expect(row?.instanceToken, "the re-PUT did not preserve the stored token").toBe(TOKEN);
  }, 60_000);
});

// ── item 2: the FederationSync merge of each non-Memory synced table ─────────

interface TableCase {
  table: string;
  seed: (id: string, marker: string) => Record<string, unknown>;
  replace: (id: string) => Record<string, unknown>;
  /** A field the merge is expected to land on a control run. */
  landed: (id: string) => Record<string, unknown>;
  readField: (row: any) => unknown;
}
const CASES: TableCase[] = [
  {
    table: "Soul",
    seed: (id, marker) => ({ id, agentId: owner.id, key: "identity", value: marker, createdAt: new Date(Date.now() - 60_000).toISOString() }),
    replace: (id) => ({ id, value: "replaced" }),
    landed: (id) => ({ value: `merged ${id}` }),
    readField: (row) => row?.value,
  },
  {
    table: "Agent",
    seed: (id, marker) => ({ id, name: marker, publicKey: "pending", createdAt: new Date(Date.now() - 60_000).toISOString() }),
    replace: (id) => ({ id, name: "replaced" }),
    landed: (id) => ({ name: `merged ${id}` }),
    readField: (row) => row?.name,
  },
  {
    table: "Relationship",
    seed: (id, marker) => ({ id, agentId: owner.id, subject: "a", predicate: "manages", object: marker, createdAt: new Date(Date.now() - 60_000).toISOString() }),
    replace: (id) => ({ id, object: "replaced" }),
    landed: (id) => ({ object: `merged ${id}` }),
    readField: (row) => row?.object,
  },
  {
    table: "Message",
    seed: (id, marker) => ({ id, from: owner.id, to: PEER, threadId: id, seq: 1, kind: "message", body: marker, state: "delivered", createdAt: new Date(Date.now() - 60_000).toISOString() }),
    replace: (id) => ({ id, body: "replaced" }),
    landed: (id) => ({ body: `merged ${id}` }),
    readField: (row) => row?.body,
  },
];

for (const c of CASES) {
  describe(`flair#2450 — the ${c.table} merge confirms the stored row (real Harper)`, () => {
    const push = (id: string, marker: string) => federatedPush({
      table: c.table,
      id,
      updatedAt: new Date().toISOString(),
      data: { id, ...c.landed(id) },
    });

    it("a DELETE between the read and the write leaves the row deleted", async () => {
      const id = `csr2-${c.table.toLowerCase()}-del-${Date.now()}`;
      await insertRow(c.table, c.seed(id, "original"));
      const { response, released, paused } = await withPaused("federation-merge", () => push(id, `merged ${id}`), () => deleteRow(c.table, id));
      expect(paused, `the ${c.table} merge was not paused`).toBe(true);
      expect(released).toBe("go");
      const body = await response.json() as any;
      expect(response.status, JSON.stringify(body).slice(0, 200)).toBe(200);
      expect(body.merged, JSON.stringify(body)).toBe(0);
      expect(body.skippedReasons?.merge_target_changed, JSON.stringify(body)).toBe(1);
      expect(await readRow(c.table, id), `the merge re-created the deleted ${c.table} row`).toBeNull();
    }, 60_000);

    it("a same-id REPLACE is not overwritten and the record is skipped by name", async () => {
      const id = `csr2-${c.table.toLowerCase()}-rep-${Date.now()}`;
      await insertRow(c.table, c.seed(id, "original"));
      const { response, released, paused } = await withPaused("federation-merge", () => push(id, `merged ${id}`), async () => {
        await updateRow(c.table, c.replace(id));
      });
      expect(paused, `the ${c.table} merge was not paused`).toBe(true);
      expect(released).toBe("go");
      const body = await response.json() as any;
      expect(body.merged, JSON.stringify(body)).toBe(0);
      expect(body.skippedReasons?.merge_target_changed, JSON.stringify(body)).toBe(1);
      const row = await readRow(c.table, id);
      expect(c.readField(row), `the competing ${c.table} row is overwritten by the stale merge`).toBe("replaced");
    }, 60_000);

    it("CONTROL: with no competitor the merge lands", async () => {
      const id = `csr2-${c.table.toLowerCase()}-ok-${Date.now()}`;
      await insertRow(c.table, c.seed(id, "original"));
      const body = await (await push(id, `merged ${id}`)).json() as any;
      expect(body.merged, JSON.stringify(body)).toBe(1);
      const row = await readRow(c.table, id);
      expect(c.readField(row), `the ordinary ${c.table} merge did not land`).toBe(`merged ${id}`);
    }, 60_000);
  });
}

// ── item 3: is a merge_target_changed skip re-offered on the next sync? ─────
//
// ANSWER: DROPPED, not re-offered. The receiver (hub) records the skip
// (SyncLog.skippedReasons, and the response body's skipped/skippedReasons); it
// keeps NO per-record retry state, and no hub value is ever read to drive a
// re-send. The decision belongs entirely to the SPOKE's outbound cursor. In
// src/commands/federation.ts:runFederationSyncOnce the cursor is
// `hub.lastSyncAt` (the spoke's local Peer row for the hub), the push selects
// `updatedAt > since`, and — after ANY 200 from a batch — `stampLocalContact()`
// advances it to `queriedAt`, the timestamp captured BEFORE the table queries
// (see the flair#146 no-miss comment). A refused record carries `updatedAt <=
// queriedAt` (it existed before the query), so the advanced cursor sits past it
// and the next poll's `updatedAt > since` filter cannot select it again. The
// hub's own `lastSyncCursor` (resources/Federation.ts) is written-only: it is
// set on the hub's Peer row for the spoke and read by nothing.
//
// The real-Harper case below drives the REAL client (runFederationSyncOnce)
// against a real Harper: sync #1 refuses one Soul record (merge_target_changed,
// competitor deletes it at the pause point); the cursor still advances past it;
// a byte-identical re-insert (same id, same updatedAt) is NOT re-offered on
// sync #2 (pushed 0) — it is dropped. Sync #3 shows the only path that DOES
// re-offer: the spoke's own row changing again (a new updatedAt > cursor).
describe("flair#2450 item 3 — a merge_target_changed skip is dropped, not re-offered (real Harper)", () => {
  // The hub peer row id must be this instance's id: runFederationSyncOnce signs
  // the batch as its OWN instance, and FederationSync.post authenticates it via
  // Peer.get(instanceId). Pointing the spoke at its own instance is what lets
  // one real Harper exercise the whole protocol (a distinct hub would need a
  // second instance and a pairing); it changes nothing about the cursor logic.
  let hubId: string;

  async function hubPeerRow(): Promise<any> {
    const rows = await ops({ operation: "search_by_hash", database: "flair", table: "Peer", hash_values: [hubId], get_attributes: ["*"] });
    return Array.isArray(rows) ? (rows[0] ?? null) : null;
  }
  const syncOnce = () => runFederationSyncOnce({
    target: harper.httpURL,
    opsTarget: harper.opsURL,
    adminPass: harper.admin.password,
    adminUser: harper.admin.username,
  });

  /** Arm `point`, run `trigger`, do `compete` while paused, release, await. */
  async function withPausedSync(point: string, trigger: () => Promise<any>, compete: () => Promise<any>) {
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${point}`), "");
    const pending = trigger();
    const paused = await waitFor(join(pauseDir, `paused.${point}`), 30_000);
    try {
      if (paused) await compete();
    } finally {
      writeFileSync(join(pauseDir, `go.${point}`), "");
    }
    const result = await pending;
    const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
    return { result, released, paused };
  }

  beforeAll(async () => {
    const res = await fetch(`${harper.httpURL}/FederationInstance`, { headers: { Authorization: basicAuth() } });
    expect(res.status, (await res.clone().text()).slice(0, 200)).toBe(200);
    const instance = await res.json() as any;
    hubId = instance.id;

    // Seed the test-process keystore with the key the client will sign with, and
    // pin the SAME public key on the hub peer row it authenticates against. The
    // real Harper's own identity (in its own HOME) is irrelevant here.
    const seed = nacl.randomBytes(32);
    keystore.setPrivateKeySeed(hubId, seed);
    const kp = nacl.sign.keyPair.fromSeed(seed);

    // Cursor = now: only rows written AFTER this are federable this run.
    const T0 = new Date().toISOString();
    await insertRow("Peer", {
      id: hubId, role: "hub", status: "paired", endpoint: harper.httpURL,
      publicKey: Buffer.from(kp.publicKey).toString("base64url"),
      lastSyncAt: T0, createdAt: T0,
    });
  }, 60_000);

  it("the refused record is not re-offered: the cursor advances past it", async () => {
    const id = `csr3-drop-${Date.now()}`;
    const T1 = new Date().toISOString();
    await insertRow("Soul", { id, agentId: owner.id, key: "identity", value: "original", durability: "permanent", createdAt: T1, updatedAt: T1 });
    expect(Date.parse((await readRow("Soul", id)).updatedAt), "seed row is not past the cursor").toBeGreaterThan(Date.parse((await hubPeerRow()).lastSyncAt));

    // Sync #1: the merge is refused — the competitor DELETEs the row at the
    // pause point. (A delete rather than a same-id replace lets sync #2 re-create
    // the row at the SAME updatedAt, so "not re-offered" isolates the cursor.)
    const { result, released, paused } = await withPausedSync("federation-merge", () => syncOnce(), () => deleteRow("Soul", id));
    expect(paused, "the federation merge was not paused").toBe(true);
    expect(released).toBe("go");
    expect(result.error, String(result.error)).toBeUndefined();
    expect(result.pushed, JSON.stringify(result)).toBe(0);
    expect(result.skipped, JSON.stringify(result)).toBe(1);
    expect(await readRow("Soul", id), "the merge re-created the deleted row").toBeNull();

    // THE PROOF: the cursor advanced past a record the receiver refused. No state
    // on either side remembers the skip, and `updatedAt > since` can no longer
    // select it — so `federation sync` can never re-offer it.
    const cursorAfter1 = (await hubPeerRow()).lastSyncAt;
    expect(Date.parse(cursorAfter1), "the cursor did not advance past the skipped record").toBeGreaterThan(Date.parse(T1));

    // Sync #2: re-insert the byte-identical record (same id, same updatedAt).
    await insertRow("Soul", { id, agentId: owner.id, key: "identity", value: "original", durability: "permanent", createdAt: T1, updatedAt: T1 });
    const second = await syncOnce();
    expect(second.error, String(second.error)).toBeUndefined();
    expect(second.pushed, `the dropped record WAS re-offered: ${JSON.stringify(second)}`).toBe(0);
    expect(second.skipped).toBe(0);
    // Its content is still the un-merged original: the refused merge was lost,
    // not applied late.
    expect((await readRow("Soul", id)).value).toBe("original");

    // Sync #3: the ONLY re-offer path — the spoke's OWN row changes again. A new
    // updatedAt past the cursor makes the next poll select and merge it.
    const T3 = new Date().toISOString();
    await updateRow("Soul", { id, value: "edited", updatedAt: T3 });
    const third = await syncOnce();
    expect(third.error, String(third.error)).toBeUndefined();
    expect(third.pushed, `a new version was not re-offered: ${JSON.stringify(third)}`).toBe(1);
  }, 120_000);
});
