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
 * attempt). For the merge of Soul, Agent, Relationship and Message the helper
 * now compares the WHOLE stored row against the row the merge read (its
 * `wholeRow` option), because those tables carry no instanceToken or
 * contentHash and sameStoredRow's identity check reduces to id/agentId/createdAt
 * for them; a same-id REPLACE that keeps those fields and changes only a data
 * value is invisible to the identity check alone (see the "pre-window" cases
 * below). For Memory and the `_reindex` re-PUT (which carry a server-stamped
 * incarnation token and a content hash) the identity check is sameStoredRow's: a
 * DELETE, a PURGE (Memory has one) or a same-id REPLACE that changed the row's
 * identity (incarnation token, content hash, creation time or owner) or removed
 * it is refused. `_reindex` answers 409 stored_row_changed; a merge is skipped by
 * name (merge_target_changed). Harper has no compare-and-set on a table write, so
 * a change committed AFTER the final confirm read — taken inside the same
 * transaction, before its commit — is not seen (resources/write-back.ts).
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
  /**
   * A same-id REPLACE that KEEPS the identity fields sameStoredRow compares for
   * this table (id, agentId, createdAt — Soul/Agent/Relationship/Message carry
   * no instanceToken or contentHash) and changes only a data field. It is the
   * interleaving where the merge's own identity check, on its own, cannot tell
   * the row changed: only a WHOLE-ROW comparison against the row the merge read
   * catches it. Committed at `federation-merge-pre` (after the merge's read,
   * before the helper's in-transaction read).
   */
  staleReplace: (id: string, stored: any) => Record<string, unknown>;
  /** A field the merge is expected to land on a control run. */
  landed: (id: string) => Record<string, unknown>;
  readField: (row: any) => unknown;
}
const CASES: TableCase[] = [
  {
    table: "Soul",
    seed: (id, marker) => ({ id, agentId: owner.id, key: "identity", value: marker, createdAt: new Date(Date.now() - 60_000).toISOString() }),
    replace: (id) => ({ id, value: "replaced" }),
    staleReplace: (id, stored) => ({ id, agentId: stored.agentId, createdAt: stored.createdAt, value: "replaced" }),
    landed: (id) => ({ value: `merged ${id}` }),
    readField: (row) => row?.value,
  },
  {
    table: "Agent",
    seed: (id, marker) => ({ id, name: marker, publicKey: "pending", createdAt: new Date(Date.now() - 60_000).toISOString() }),
    replace: (id) => ({ id, name: "replaced" }),
    staleReplace: (id, stored) => ({ id, createdAt: stored.createdAt, name: "replaced" }),
    landed: (id) => ({ name: `merged ${id}` }),
    readField: (row) => row?.name,
  },
  {
    table: "Relationship",
    seed: (id, marker) => ({ id, agentId: owner.id, subject: "a", predicate: "manages", object: marker, createdAt: new Date(Date.now() - 60_000).toISOString() }),
    replace: (id) => ({ id, object: "replaced" }),
    staleReplace: (id, stored) => ({ id, agentId: stored.agentId, createdAt: stored.createdAt, subject: "a", predicate: "manages", object: "replaced" }),
    landed: (id) => ({ object: `merged ${id}` }),
    readField: (row) => row?.object,
  },
  {
    table: "Message",
    seed: (id, marker) => ({ id, from: owner.id, to: PEER, threadId: id, seq: 1, kind: "message", body: marker, state: "delivered", createdAt: new Date(Date.now() - 60_000).toISOString() }),
    replace: (id) => ({ id, body: "replaced" }),
    staleReplace: (id, stored) => ({ id, createdAt: stored.createdAt, from: stored.from, to: stored.to, threadId: stored.threadId, seq: stored.seq, kind: stored.kind, state: "delivered", body: "replaced" }),
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
      // Behaviour assertions FIRST (flair#2450 review): a mutation that stops this
      // merge running through the helper — a plain table.put — never reaches the
      // pause point, so an `expect(paused)` first would report "was not paused"
      // and hide the behaviour. These run whatever the pause did.
      const body = await response.json() as any;
      expect(response.status, JSON.stringify(body).slice(0, 200)).toBe(200);
      expect(body.merged, JSON.stringify(body)).toBe(0);
      expect(body.skippedReasons?.merge_target_changed, JSON.stringify(body)).toBe(1);
      expect(await readRow(c.table, id), `the merge re-created the deleted ${c.table} row`).toBeNull();
      expect(paused, `the ${c.table} merge was not paused`).toBe(true);
      expect(released).toBe("go");
    }, 60_000);

    it("a same-id REPLACE is not overwritten and the record is skipped by name", async () => {
      const id = `csr2-${c.table.toLowerCase()}-rep-${Date.now()}`;
      await insertRow(c.table, c.seed(id, "original"));
      const { response, released, paused } = await withPaused("federation-merge", () => push(id, `merged ${id}`), async () => {
        await updateRow(c.table, c.replace(id));
      });
      // Behaviour first, as in the DELETE case above.
      const body = await response.json() as any;
      expect(body.merged, JSON.stringify(body)).toBe(0);
      expect(body.skippedReasons?.merge_target_changed, JSON.stringify(body)).toBe(1);
      const row = await readRow(c.table, id);
      expect(c.readField(row), `the competing ${c.table} row is overwritten by the stale merge`).toBe("replaced");
      expect(paused, `the ${c.table} merge was not paused`).toBe(true);
      expect(released).toBe("go");
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

// ── item 2 (pre-window): the merge confirms the WHOLE stored row, not just the
// identity fields, for a table that carries no instanceToken/contentHash ──────
//
// Soul/Agent/Relationship/Message have no instanceToken and no contentHash, so
// sameStoredRow's comparison reduces to id/agentId/createdAt for them. A
// same-id REPLACE that keeps those three and changes only a data field is
// therefore invisible to the identity check. Committed at `federation-merge-pre`
// — after the merge read `local` and before the helper's in-transaction read —
// the stale merge (built from `local`, LWW decided against `local`) commits over
// the competitor and the row is overwritten. The whole-row check (the helper's
// WHOLE_ROW option) catches it. On the pre-fix head 44425196 each case below
// fails: the merge lands (`merged: 1`) and the competitor's value is gone.
for (const c of CASES) {
  describe(`flair#2450 — the ${c.table} merge confirms the WHOLE stored row (pre-window, real Harper)`, () => {
    const push = (id: string) => federatedPush({
      table: c.table,
      id,
      updatedAt: new Date().toISOString(),
      data: { id, ...c.landed(id) },
    });

    it("a same-id REPLACE between the merge read and the helper's in-transaction read is refused", async () => {
      const id = `csr2-${c.table.toLowerCase()}-pre-${Date.now()}`;
      await insertRow(c.table, c.seed(id, "original"));
      const stored = await readRow(c.table, id);
      const { response, released, paused } = await withPaused("federation-merge-pre", () => push(id), async () => {
        await updateRow(c.table, c.staleReplace(id, stored));
      });
      const body = await response.json() as any;
      // Behaviour first, so a run that never reached the pause still reports the
      // merge outcome, not the missing pause (see the mutation note in the PR).
      expect(body.merged, JSON.stringify(body)).toBe(0);
      expect(body.skippedReasons?.merge_target_changed, JSON.stringify(body)).toBe(1);
      const row = await readRow(c.table, id);
      expect(c.readField(row), `the competing ${c.table} row is overwritten by the stale merge`).toBe("replaced");
      expect(paused, "(diagnostic) the pre-window pause was not hit").toBe(true);
    }, 60_000);
  });
}

// ── item 3: is a merge_target_changed skip re-offered on the next sync? ─────
//
// ANSWER: DROPPED, not re-offered — by the sender's selection rule, not by any
// receiver-side retry state. The receiver (hub) records the skip
// (SyncLog.skippedReasons, and the response body's skipped/skippedReasons); it
// keeps NO per-record retry state, and no hub value is ever read to drive a
// re-send. The decision belongs to the SPOKE's outbound cursor, in
// src/commands/federation.ts:runFederationSyncOnce: the cursor is
// `hub.lastSyncAt` (the spoke's local Peer row for the hub), and the push
// selects `updatedAt > since`.
//
// stampLocalContact() advances that cursor to `queriedAt` — the timestamp
// captured BEFORE the table queries (the flair#146 no-miss comment) — and it
// runs ONCE, at the end of the whole run, ONLY when every batch returned 200
// AND the field-only cursor update matched the row (persistLocalPeerLastSyncAt:
// HTTP 200 alone is not success, a miss is a refusal, never an insert). It is
// NOT run "after any 200": a later batch that fails (or a cursor write that
// does not match) leaves the stamp where it was, so the next poll re-selects
// every record from the old cursor — a batch that failed after an earlier one
// succeeded re-offers the earlier records too.
//
// `updatedAt` is a DATA value, not a structural guarantee: a merged row keeps
// whatever updatedAt the remote sent (mergeRecord), and the receiver never
// rewrites it on a refusal. So the reason a refused record is not re-offered is
// that its stored `updatedAt` was already <= the advanced cursor — true for a
// row that existed before the query (the case here), but a row whose updatedAt
// is bumped by a writer DURING the run carries updatedAt > queriedAt and IS
// re-offered next cycle. "Can never re-offer" would be false; "was not
// re-offered while its updatedAt stayed put" is what holds.
//
// The hub's own `lastSyncCursor` (resources/Federation.ts) is written-only: set
// on the hub's Peer row for the spoke and read by nothing.
//
// SINGLE-INSTANCE CAVEAT: this file's Harper is BOTH the client's hub and the
// receiver. FederationSync.post writes `peerUpdate.lastSyncAt = nowIso` onto the
// hub's Peer row for the spoke — which, on one instance, is the very row the
// client reads back as `since`. So the "cursor advanced" observation below does
// NOT isolate the spoke-side stamp: it would hold with stampLocalContact removed
// too. What this case DOES show, on one instance, is the observable outcome — a
// byte-identical re-insert (same id, same updatedAt) is not re-offered on sync
// #2 (pushed 0) and its content stays un-merged, while bumping the row's own
// updatedAt (sync #3) IS re-offered. The spoke-side advance is pinned on its own
// — no second instance, no pause — by the batch-path unit test in
// test/unit/federation-liveness-ping.test.ts ("the cursor advances after a
// batch, and only when every batch got 200").
describe("flair#2450 item 3 — a merge_target_changed skip is dropped, not re-offered (real Harper)", () => {
  // The hub peer row id must be this instance's id: runFederationSyncOnce signs
  // the batch as its OWN instance, and FederationSync.post authenticates it via
  // Peer.get(instanceId). Pointing the spoke at its own instance is what lets one
  // real Harper exercise the whole protocol without a second instance and a
  // pairing. It is also why the advance of this row is NOT a spoke-side signal
  // (see SINGLE-INSTANCE CAVEAT above): the receiver writes the same row.
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

  it("a record the receiver refused is not re-offered while its updatedAt stays put", async () => {
    const id = `csr3-drop-${Date.now()}`;
    const T1 = new Date().toISOString();
    await insertRow("Soul", { id, agentId: owner.id, key: "identity", value: "original", durability: "permanent", createdAt: T1, updatedAt: T1 });
    expect(Date.parse((await readRow("Soul", id)).updatedAt), "seed row is not past the cursor").toBeGreaterThan(Date.parse((await hubPeerRow()).lastSyncAt));

    // Sync #1: the merge is refused — the competitor DELETEs the row at the
    // in-transaction `federation-merge` pause point (after the helper's
    // in-transaction read; `federation-merge-pre` is before it). A delete rather
    // than a same-id replace lets sync #2 re-create the row at the SAME updatedAt,
    // so sync #2's selection turns on `updatedAt > since` alone, not on content.
    const { result, released, paused } = await withPausedSync("federation-merge", () => syncOnce(), () => deleteRow("Soul", id));
    expect(paused, "the federation merge was not paused").toBe(true);
    expect(released).toBe("go");
    expect(result.error, String(result.error)).toBeUndefined();
    expect(result.pushed, JSON.stringify(result)).toBe(0);
    expect(result.skipped, JSON.stringify(result)).toBe(1);
    expect(await readRow("Soul", id), "the merge re-created the deleted row").toBeNull();

    // Where the cursor stands after sync #1. NOTE (SINGLE-INSTANCE CAVEAT above):
    // this row is advanced by FederationSync.post's own contact write as well as
    // by stampLocalContact, so this value alone is not evidence of the spoke-side
    // stamp. It is recorded because it is what sync #2 then selects against.
    // The window is the in-transaction `federation-merge` pause point — after the
    // helper's in-transaction read (distinct from `federation-merge-pre`, before
    // it) — where the competitor DELETEs the row.
    const cursorAfter1 = (await hubPeerRow()).lastSyncAt;
    expect(Date.parse(cursorAfter1), "the stored cursor did not move past T1").toBeGreaterThan(Date.parse(T1));

    // Sync #2: re-insert the byte-identical record (same id, same updatedAt).
    await insertRow("Soul", { id, agentId: owner.id, key: "identity", value: "original", durability: "permanent", createdAt: T1, updatedAt: T1 });
    const second = await syncOnce();
    expect(second.error, String(second.error)).toBeUndefined();
    expect(second.pushed, `the dropped record WAS re-offered: ${JSON.stringify(second)}`).toBe(0);
    expect(second.skipped).toBe(0);
    // Its content is still the un-merged original: the refused merge was lost,
    // not applied late.
    expect((await readRow("Soul", id)).value).toBe("original");

    // Sync #3: the ONLY re-offer path — the sender's OWN row changes again. A new
    // updatedAt past the cursor makes the next poll select and merge it. (This is
    // the re-offer that a mid-run updatedAt bump produces too: see the header
    // note on updatedAt being a data value, not a structural guarantee.)
    const T3 = new Date().toISOString();
    await updateRow("Soul", { id, value: "edited", updatedAt: T3 });
    const third = await syncOnce();
    expect(third.error, String(third.error)).toBeUndefined();
    expect(third.pushed, `a new version was not re-offered: ${JSON.stringify(third)}`).toBe(1);
  }, 120_000);
});
