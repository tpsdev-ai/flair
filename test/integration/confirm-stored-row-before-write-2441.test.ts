/**
 * confirm-stored-row-before-write-2441.test.ts — the three Memory writers that
 * read a row and write it back (carrying its server-stamped instanceToken) now
 * confirm, in the SAME transaction as the write, that the stored row is still
 * the one they read (flair#2441):
 *
 *   - the usage-recording count bump (resources/usage-recording.ts),
 *   - the federation Memory merge (resources/Federation.ts),
 *   - Memory.put's ordinary row write (resources/Memory.ts; not the admin-only
 *     `_reindex` re-PUT, which does not run this confirmation).
 *
 * Real Harper. Each writer's test-only pause point (resources/txn-pause-point.ts,
 * armed through FLAIR_ENABLE_TEST_FAULT_INJECTION / FLAIR_TEST_PAUSE_DIR) holds the
 * writer between its read and its write while this test commits a competitor:
 *   - a PURGE — refused busy while the writer holds the id, so the row survives the
 *     writer's own write; once the writer commits, a purge removes it;
 *   - an owner DELETE — holds the id itself, so the count bump skips its write; the
 *     DELETE lands and the row stays gone;
 *   - a raw operations DELETE, which takes no lock — the count bump's confirmation
 *     sees the row gone and settles as a skip, not a count write;
 *   - a same-id REPLACE with a new token — the writer does not overwrite it.
 * Memory.put is also held AFTER its write is staged and before its commit
 * (`memory-put-staged`), and the same three competitors commit there: the
 * competitor's row stands, and the committed-row re-check aborts the put and
 * answers 409 stored_row_changed. Without the re-check the competitor's row
 * still stands (Harper orders the staged put by its transaction's earlier
 * timestamp), but the put answers 200 `written: true` for a write that did not
 * land: the 409 assertion is the one that fails. A put that also carries a
 * host-source pointer stages a pointer row no competitor versions, so that case
 * shows the refused put's transaction is aborted: no pointer row is committed.
 * A control case per writer shows the ordinary path is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

/** A bare current stamp: the boot embedding-stamp migration treats a seeded row
 *  as current-space and never re-embeds it, so a case that does not mean to
 *  race that background writer keeps it out of the selection. */
const SEED_MODEL_ID = stripEnginePrefix(getModelId());

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

const owner = mkAgent("csr-owner");
const peerKeys = nacl.sign.keyPair();
const PEER = "csr-peer";

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

async function readRow(id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}
async function insertRow(row: Record<string, unknown>): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "Memory",
    records: [{ visibility: "shared", archived: false, embeddingModel: SEED_MODEL_ID, createdAt: new Date(Date.now() - 60_000).toISOString(), ...row }],
  });
}
async function updateRow(row: Record<string, unknown>): Promise<void> {
  await ops({ operation: "update", database: "flair", table: "Memory", records: [row] });
}
async function deleteRow(id: string): Promise<void> {
  await ops({ operation: "delete", database: "flair", table: "Memory", ids: [id] });
}
async function purgeBusy(id: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${harper.httpURL}/MemoryPurge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ ids: [id] }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.json() };
}
async function purgeRow(id: string): Promise<void> {
  const { status, body } = await purgeBusy(id);
  expect(status, `MemoryPurge: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
}

/** Rows in MemoryDeletionHistory for one memory id. */
async function historyRows(id: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "MemoryDeletionHistory",
    search_attribute: "memoryId", search_type: "equals", search_value: id, get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows : [];
}
/** Rows in MemoryHostSource for one memory id. */
async function pointerRows(id: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "MemoryHostSource",
    search_attribute: "memoryId", search_type: "equals", search_value: id, get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows : [];
}
/** Rows in MemoryUsage for one (agent, memory) contribution. */
async function ledgerRow(agentId: string, memoryId: string): Promise<any> {
  const rows = await ops({
    operation: "search_by_id", database: "flair", table: "MemoryUsage",
    ids: [`${agentId}:${memoryId}`], get_attributes: ["*"],
  });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** The last settled write-back outcome this run recorded for one row's write. */
async function attemptOutcome(label: string, id: string): Promise<string | undefined> {
  const path = join(pauseDir, "attempts.write-back");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.startsWith(`${label}\t${id}\t`));
      const fields = (lines.at(-1) ?? "").split("\t");
      if (fields.length >= 4) return fields[3];
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

async function insertPointer(id: string, token: string): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "MemoryHostSource",
    records: [{
      memoryId: id, hostSource: JSON.stringify({ v: 1, host: "host-a", kind: "run", id: "run-a" }),
      scopeAtWrite: null, authorId: owner.id, memoryInstanceToken: token, receivedAt: new Date().toISOString(),
    }],
  });
}

function authSend(agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

/** One signed FederationSync push of a single Memory record from PEER. */
async function federatedPush(record: Record<string, unknown>): Promise<Response> {
  const body = signBodyFresh(
    { instanceId: PEER, records: [{ table: "Memory", originatorInstanceId: PEER, ...record }], lamportClock: Date.now() },
    peerKeys.secretKey,
  );
  return fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** The captured server log, for a case that asserts which path the writer took. */
function serverLog(): string {
  return harper.getLog?.() ?? "";
}
/** Wait for text appended since `from` to satisfy `matches`; the child flushes
 *  its console output slightly after the request returns. */
async function waitForLogSince(from: number, matches: (appended: string) => boolean, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let appended = serverLog().slice(from);
  while (Date.now() < deadline) {
    if (matches(appended)) return appended;
    await new Promise((r) => setTimeout(r, 25));
    appended = serverLog().slice(from);
  }
  return matches(appended) ? appended : null;
}

/**
 * Arm `point`, start `trigger`, run `compete` once the trigger is paused inside
 * that point, release, and await the trigger. Returns the trigger's response
 * and how the pause ended. A false observation fails before writing `go`.
 */
async function withPaused<T>(
  point: string,
  trigger: () => Promise<Response>,
  compete: () => Promise<T>,
  observeCommitted?: () => Promise<boolean>,
) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  void pending.catch(() => {});
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  let competed: T | undefined;
  let observed: boolean | undefined;
  if (paused) competed = await compete();
  if (paused && observeCommitted) {
    observed = await observeCommitted();
    expect(observed, `the competitor's committed state was not observed at ${point}`).toBe(true);
  }
  writeFileSync(join(pauseDir, `go.${point}`), "");
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, competed, released, paused, observed };
}

/** Arm `point` without starting a trigger: for a case that runs two writers,
 *  each held at its own point, and releases them in a chosen order. */
function armPoint(point: string): void {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
}
/** Release an armed point (its holder's marker `go.<point>`). */
function releasePoint(point: string): void {
  writeFileSync(join(pauseDir, `go.${point}`), "");
}
/** Wait until a fresh read observes `id` absent — the delete's commit is visible. */
async function waitForRowGone(id: string, timeoutMs: number): Promise<boolean> {
  return waitForCommitted(id, (row) => row === null, timeoutMs);
}
/** Wait until a fresh read observes `id` in the competitor's committed end state. */
async function waitForCommitted(id: string, matches: (row: any) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (matches(await readRow(id))) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2441-pause-"));
  harper = await startHarper({ serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir } });
  assertOwnInstance(harper);
  await ops({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: owner.id, name: owner.id, role: "agent", publicKey: owner.publicKey, createdAt: new Date().toISOString() }],
  });
  await ops({
    operation: "insert", database: "flair", table: "Peer",
    records: [{ id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: new Date().toISOString() }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

it("a false observation rejects before the helper writes go", async () => {
  const point = "observation-timeout";
  await expect(withPaused(
    point,
    async () => {
      writeFileSync(join(pauseDir, `paused.${point}`), "");
      return new Response();
    },
    async () => {},
    async () => false,
  )).rejects.toThrow("the competitor's committed state was not observed");
  expect(existsSync(join(pauseDir, `go.${point}`))).toBe(false);
});

// ── usage-recording: the usageCount count bump ─────────────────────────────

describe("flair#2441 — the usage-recording count bump confirms the stored row (real Harper)", () => {
  const seed = (id: string, token: string) =>
    insertRow({ id, agentId: owner.id, content: `usage ${id}`, contentHash: id, instanceToken: token, durability: "persistent" });
  const record = (id: string) => authSend(owner, "POST", "/RecordUsage", { memoryIds: [id] });

  // flair#2478 slice 1 part 2: the owner DELETE holds the id's write lock for
  // the whole transaction, including at `memory-delete`. The count bump takes
  // the same lock once, without waiting, so it writes nothing (no ledger row,
  // no bump) and RecordUsage answers its invariant response.
  it("an owner DELETE holding the id makes the contribution observe the busy skip, not a caught exception; the DELETE lands and the row stays deleted", async () => {
    const id = `csr-usage-del-${Date.now()}`;
    await seed(id, randomUUID());
    armPoint("memory-delete");
    const delPending = authSend(owner, "DELETE", `/Memory/${id}`);
    expect(await waitFor(join(pauseDir, "paused.memory-delete"), 15_000), "the owner delete was not paused").toBe(true);
    // The DELETE holds the id here. The contribution cannot take the lock, so
    // it skips the whole contribution rather than writing unserialized. The
    // response is the invariant one for a skip AND for a caught exception, so
    // this case reads the server log the skip itself emits: the busy-lock
    // branch warns "contribution skipped: busy for memory <id>", while a
    // thrown per-id failure is logged by RecordUsage.post's catch instead.
    const logFrom = serverLog().length;
    const rec = await record(id);
    expect(rec.status, (await rec.clone().text()).slice(0, 200)).toBe(200);
    expect(await rec.json()).toEqual({ recorded: true });
    const held = await readRow(id);
    expect(held?.usageCount ?? null, "the skipped contribution bumped the count").toBeNull();
    expect(held?.writeBackWriteId ?? null, "the skipped contribution staged a bump").toBeNull();
    expect(await ledgerRow(owner.id, id), "the skipped contribution wrote a ledger row").toBeNull();
    const skipLine = `[usage-recording] contribution skipped: busy for memory ${id}`;
    const appended = await waitForLogSince(logFrom, (text) => text.includes(skipLine), 10_000);
    expect(appended, "the contribution did not report the busy skip server-side").not.toBeNull();
    expect(appended, "the busy skip was reported as a caught per-id exception").not.toContain("RecordUsage.post:");
    releasePoint("memory-delete");
    const del = await delPending;
    expect(del.status, (await del.clone().text()).slice(0, 200)).toBeLessThan(300);
    expect(await waitForRowGone(id, 15_000), "the row survived the owner DELETE").toBe(true);
  }, 60_000);

  // The original flair#2441 property, with a delete the per-id lock does not
  // serialize: the raw operations API takes no lock. The bump is held after its
  // read; the row is deleted underneath it; its committed-row confirmation
  // aborts the staged bump, and it settles as a skip instead of re-creating the
  // row.
  it("a raw DELETE between the count bump's read and its write leaves the row deleted", async () => {
    const id = `csr-usage-raw-del-${Date.now()}`;
    await seed(id, randomUUID());
    const { response, paused, released, observed } = await withPaused(
      "usage-count", () => record(id), () => deleteRow(id),
      () => waitForRowGone(id, 15_000),
    );
    expect(paused, "the count bump was not paused").toBe(true);
    expect(released).toBe("go");
    expect(observed, "the raw DELETE did not become visible to a fresh read").toBe(true);
    expect(response.status, (await response.clone().text()).slice(0, 200)).toBe(200);
    expect(await response.json()).toEqual({ recorded: true });
    expect(await readRow(id), "the count bump re-created the deleted row").toBeNull();
    expect(await attemptOutcome("usage-recording", id), "the count bump did not settle as a skip").toBe("skipped");
  }, 60_000);

  // flair#2478 slice 3b: the count bump holds the id's per-id write lock and
  // the purge takes it, so a purge that arrives while the bump holds the id is
  // refused busy and deletes nothing; once the bump has committed, a purge
  // removes the row.
  it("a PURGE between the read and the write is refused busy and lands once the count bump commits", async () => {
    const id = `csr-usage-purge-${Date.now()}`;
    await seed(id, randomUUID());
    const { response, paused, released, competed } = await withPaused("usage-count", () => record(id), () => purgeBusy(id));
    expect(paused, "the usage count bump was not paused").toBe(true);
    expect(released).toBe("go");
    expect(competed?.status).toBe(503);
    expect(competed?.body).toEqual({ error: "memory_busy", caller: "admin" });
    expect(response.status, (await response.clone().text()).slice(0, 200)).toBe(200);
    expect((await readRow(id))?.usageCount, "the refused purge removed the row, or the count bump did not land").toBe(1);
    await purgeRow(id);
    expect(await readRow(id), "the purge did not remove the row the count bump committed").toBeNull();
  }, 60_000);

  it("a same-id REPLACE with a new token is not overwritten", async () => {
    const id = `csr-usage-rep-${Date.now()}`;
    const T2 = randomUUID();
    await seed(id, randomUUID());
    const { response, paused, released, observed } = await withPaused("usage-count", () => record(id), async () => {
      await updateRow({ id, instanceToken: T2, content: "replaced" });
    }, () => waitForCommitted(id, (row) => row?.instanceToken === T2 && row?.content === "replaced", 15_000));
    expect(paused, "the usage count bump was not paused").toBe(true);
    expect(released).toBe("go");
    expect(observed, "the REPLACE did not become visible to a fresh read").toBe(true);
    expect(response.status, (await response.clone().text()).slice(0, 200)).toBe(200);
    const row = await readRow(id);
    expect(row?.instanceToken, "the competing incarnation token is overwritten by the stale bump").toBe(T2);
    expect(row?.content, "the competing content is overwritten").toBe("replaced");
    expect(row?.usageCount ?? null, "the stale bump still incremented the replaced row").toBeNull();
  }, 60_000);

  it("CONTROL: with no competitor the count bump lands", async () => {
    const id = `csr-usage-ok-${Date.now()}`;
    await seed(id, randomUUID());
    const res = await record(id);
    expect(res.status).toBe(200);
    const row = await readRow(id);
    expect(row?.usageCount, "the ordinary count bump did not land").toBe(1);
  }, 60_000);
});

// ── federation: the Memory merge ───────────────────────────────────────────

describe("flair#2441 — the federation Memory merge confirms the stored row (real Harper)", () => {
  const seed = (id: string, token: string, content: string) =>
    insertRow({ id, agentId: owner.id, content, contentHash: id, instanceToken: token, durability: "persistent" });
  const push = (id: string, content: string) =>
    federatedPush({ id, updatedAt: new Date().toISOString(), data: { id, agentId: owner.id, content, visibility: "shared", createdAt: new Date().toISOString() } });

  it("a DELETE between the read and the write leaves the row deleted", async () => {
    const id = `csr-fed-del-${Date.now()}`;
    await seed(id, randomUUID(), "federated v1");
    const { response, released, paused, observed } = await withPaused(
      "federation-merge", () => push(id, "federated v2"), () => deleteRow(id),
      () => waitForRowGone(id, 15_000),
    );
    expect(paused, "the federation merge was not paused").toBe(true);
    expect(released).toBe("go");
    expect(observed, "the DELETE did not become visible to a fresh read").toBe(true);
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body).slice(0, 200)).toBe(200);
    expect(body.merged, JSON.stringify(body)).toBe(0);
    expect(body.skippedReasons?.merge_target_changed, JSON.stringify(body)).toBe(1);
    expect(await readRow(id), "the merge re-created the deleted row").toBeNull();
  }, 60_000);

  // flair#2478 slices 3b and 3c: the merge holds the target's per-id write lock
  // at this point and the purge takes it too, so a purge that arrives while the
  // merge holds the id is refused busy and deletes nothing; once the merge has
  // committed, a purge removes the row.
  it("a PURGE between the read and the write is refused busy and lands once the merge commits", async () => {
    const id = `csr-fed-purge-${Date.now()}`;
    await seed(id, randomUUID(), "federated v1");
    const { response, paused, released, competed } = await withPaused("federation-merge", () => push(id, "federated v2"), () => purgeBusy(id));
    expect(paused, "the federation merge was not paused").toBe(true);
    expect(released).toBe("go");
    expect(competed?.status).toBe(503);
    expect(competed?.body).toEqual({ error: "memory_busy", caller: "admin" });
    const body = await response.json() as any;
    expect(body.merged, JSON.stringify(body)).toBe(1);
    expect((await readRow(id))?.content, "the refused purge removed the row").toBe("federated v2");
    await purgeRow(id);
    expect(await readRow(id), "the purge did not remove the row the merge committed").toBeNull();
  }, 60_000);

  it("a same-id REPLACE with a new token is not overwritten", async () => {
    const id = `csr-fed-rep-${Date.now()}`;
    const T2 = randomUUID();
    await seed(id, randomUUID(), "federated v1");
    const { response, paused, released, observed } = await withPaused("federation-merge", () => push(id, "federated v2"), async () => {
      await updateRow({ id, instanceToken: T2, content: "replaced" });
    }, () => waitForCommitted(id, (row) => row?.instanceToken === T2 && row?.content === "replaced", 15_000));
    expect(paused, "the federation merge was not paused").toBe(true);
    expect(released).toBe("go");
    expect(observed, "the REPLACE did not become visible to a fresh read").toBe(true);
    const body = await response.json() as any;
    expect(body.merged, JSON.stringify(body)).toBe(0);
    const row = await readRow(id);
    expect(row?.instanceToken, "the competing incarnation token is overwritten by the stale merge").toBe(T2);
    expect(row?.content, "the competing content is overwritten").toBe("replaced");
  }, 60_000);

  it("CONTROL: with no competitor the merge lands and keeps the stored token", async () => {
    const id = `csr-fed-ok-${Date.now()}`;
    const TOKEN = randomUUID();
    await seed(id, TOKEN, "federated v1");
    const body = await (await push(id, "federated v2")).json() as any;
    expect(body.merged, JSON.stringify(body)).toBe(1);
    const row = await readRow(id);
    expect(row?.content, "the ordinary merge did not land").toBe("federated v2");
    expect(row?.instanceToken, "the merge did not preserve the stored incarnation token").toBe(TOKEN);
  }, 60_000);
});

// ── Memory.put ─────────────────────────────────────────────────────────────

describe("flair#2441 — Memory.put confirms the stored row (real Harper)", () => {
  const seed = (id: string, token: string) =>
    insertRow({ id, agentId: owner.id, content: `put ${id}`, contentHash: id, instanceToken: token, durability: "persistent" });
  const put = (id: string, content: string) => authSend(owner, "PUT", `/Memory/${id}`, { agentId: owner.id, content });

  it("a DELETE between the read and the write is refused and the row stays deleted", async () => {
    const id = `csr-put-del-${Date.now()}`;
    await seed(id, randomUUID());
    const { response, released, paused, observed } = await withPaused(
      "memory-put", () => put(id, "put v2"), () => deleteRow(id),
      () => waitForRowGone(id, 15_000),
    );
    expect(paused, "Memory.put was not paused").toBe(true);
    expect(released).toBe("go");
    expect(observed, "the DELETE did not become visible to a fresh read").toBe(true);
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    expect(await readRow(id), "Memory.put re-created the deleted row").toBeNull();
  }, 60_000);

  // flair#2478 slice 3b: the purge takes the target's per-id write lock, so a
  // purge that arrives while the put holds the id is refused busy and deletes
  // nothing; once the put has committed, a purge removes the row.
  it("a PURGE between the read and the write is refused busy and lands once the put commits", async () => {
    const id = `csr-put-purge-${Date.now()}`;
    await seed(id, randomUUID());
    const { response, paused, released, competed } = await withPaused("memory-put", () => put(id, "put v2"), () => purgeBusy(id));
    expect(paused, "Memory.put was not paused").toBe(true);
    expect(released).toBe("go");
    expect(competed?.status).toBe(503);
    expect(competed?.body).toEqual({ error: "memory_busy", caller: "admin" });
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBeLessThan(300);
    expect(await readRow(id), "the refused purge removed the row").not.toBeNull();
    await purgeRow(id);
    expect(await readRow(id), "the purge did not remove the row the put committed").toBeNull();
  }, 60_000);

  it("a same-id REPLACE with a new token is refused and not overwritten", async () => {
    const id = `csr-put-rep-${Date.now()}`;
    const T2 = randomUUID();
    await seed(id, randomUUID());
    const { response, paused, released, observed } = await withPaused("memory-put", () => put(id, "put v2"), async () => {
      await updateRow({ id, instanceToken: T2, content: "replaced" });
    }, () => waitForCommitted(id, (row) => row?.instanceToken === T2 && row?.content === "replaced", 15_000));
    expect(paused, "Memory.put was not paused").toBe(true);
    expect(released).toBe("go");
    expect(observed, "the REPLACE did not become visible to a fresh read").toBe(true);
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    const row = await readRow(id);
    expect(row?.instanceToken, "the competing incarnation token is overwritten by the stale put").toBe(T2);
    expect(row?.content, "the competing content is overwritten").toBe("replaced");
  }, 60_000);

  // The window AFTER the row is staged and before the commit: the competitor
  // commits while the put's write is staged; the committed-row re-check aborts
  // the put's transaction and refuses it by name (see the file header for what
  // each assertion discriminates).
  it("a DELETE between the staged write and its commit is refused and the row stays deleted", async () => {
    const id = `csr-put-staged-del-${Date.now()}`;
    await seed(id, randomUUID());
    const { response, released, paused, observed } = await withPaused(
      "memory-put-staged", () => put(id, "put v2"), () => deleteRow(id),
      () => waitForRowGone(id, 15_000),
    );
    expect(paused, "Memory.put was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    expect(observed, "the DELETE did not become visible to a fresh read").toBe(true);
    // The competitor's row stands, and the put is refused by name, not answered with success.
    expect(await readRow(id), "Memory.put re-created the deleted row").toBeNull();
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
  }, 60_000);

  it("a PURGE between the staged write and its commit is refused busy and lands once the put commits", async () => {
    const id = `csr-put-staged-purge-${Date.now()}`;
    await seed(id, randomUUID());
    const { response, paused, released, competed } = await withPaused("memory-put-staged", () => put(id, "put v2"), () => purgeBusy(id));
    expect(paused, "Memory.put was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    expect(competed?.status).toBe(503);
    expect(competed?.body).toEqual({ error: "memory_busy", caller: "admin" });
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBeLessThan(300);
    expect(await readRow(id), "the refused purge removed the row").not.toBeNull();
    await purgeRow(id);
    expect(await readRow(id), "the purge did not remove the row the put committed").toBeNull();
  }, 60_000);

  it("a same-id REPLACE between the staged write and its commit is refused and not overwritten", async () => {
    const id = `csr-put-staged-rep-${Date.now()}`;
    const T2 = randomUUID();
    await seed(id, randomUUID());
    const { response, paused, released, observed } = await withPaused("memory-put-staged", () => put(id, "put v2"), async () => {
      await updateRow({ id, instanceToken: T2, content: "replaced" });
    }, () => waitForCommitted(id, (row) => row?.instanceToken === T2 && row?.content === "replaced", 15_000));
    expect(paused, "Memory.put was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    expect(observed, "the REPLACE did not become visible to a fresh read").toBe(true);
    // The competitor's row stands, and the put is refused by name, not answered with success.
    const row = await readRow(id);
    expect(row?.instanceToken, "the competing incarnation token is overwritten by the stale put").toBe(T2);
    expect(row?.content, "the competing content is overwritten").toBe("replaced");
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
  }, 60_000);

  // The pointer row this put stages has no competing version, so Harper's
  // timestamp ordering cannot hide it: it stays absent only if the refused put's
  // transaction (the HTTP request's own, which the put joins) is aborted.
  it("a DELETE between the staged write and its commit leaves no host-source pointer row", async () => {
    const id = `csr-put-staged-ptr-${Date.now()}`;
    await seed(id, randomUUID());
    const pointer = { v: 1, host: "openclaw", kind: "run", id: "run-csr2441" };
    const { response, paused, released, observed } = await withPaused(
      "memory-put-staged",
      () => authSend(owner, "PUT", `/Memory/${id}`, { agentId: owner.id, content: "put v2", hostSource: pointer, hostSourceScope: "record" }),
      () => deleteRow(id),
      () => waitForRowGone(id, 15_000),
    );
    expect(paused, "Memory.put was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    expect(observed, "the DELETE did not become visible to a fresh read").toBe(true);
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    expect(await readRow(id), "Memory.put re-created the deleted row").toBeNull();
    const pointers = await ops({
      operation: "search_by_value", database: "flair", table: "MemoryHostSource",
      search_attribute: "memoryId", search_type: "equals", search_value: id, get_attributes: ["*"],
    });
    expect(pointers, "the refused put's staged pointer row was committed").toEqual([]);
  }, 60_000);

  it("CONTROL: a held put with a host-source pointer and no competitor writes its pointer row", async () => {
    const id = `csr-put-staged-ptr-ok-${Date.now()}`;
    await seed(id, randomUUID());
    const pointer = { v: 1, host: "openclaw", kind: "run", id: "run-csr2441" };
    const { response, paused, released } = await withPaused(
      "memory-put-staged",
      () => authSend(owner, "PUT", `/Memory/${id}`, { agentId: owner.id, content: "put v2", hostSource: pointer, hostSourceScope: "record" }),
      async () => {},
    );
    expect(paused, "Memory.put was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    expect(response.status, (await response.clone().text()).slice(0, 200)).toBeLessThan(300);
    const pointers = await ops({
      operation: "search_by_value", database: "flair", table: "MemoryHostSource",
      search_attribute: "memoryId", search_type: "equals", search_value: id, get_attributes: ["*"],
    });
    expect(pointers.length, "the ordinary held put did not write its pointer row").toBe(1);
  }, 60_000);

  it("CONTROL: held at the staged write with no competitor, the put lands", async () => {
    const id = `csr-put-staged-ok-${Date.now()}`;
    await seed(id, randomUUID());
    const { response, paused, released } = await withPaused("memory-put-staged", () => put(id, "put v2"), async () => {});
    expect(paused, "Memory.put was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    expect(response.status, (await response.clone().text()).slice(0, 200)).toBeLessThan(300);
    const row = await readRow(id);
    expect(row?.content, "the held put did not land").toBe("put v2");
  }, 60_000);

  it("CONTROL: with no competitor the put lands", async () => {
    const id = `csr-put-ok-${Date.now()}`;
    await seed(id, randomUUID());
    const res = await put(id, "put v2");
    expect(res.status, (await res.clone().text()).slice(0, 200)).toBeLessThan(300);
    const row = await readRow(id);
    expect(row?.content, "the ordinary put did not land").toBe("put v2");
  }, 60_000);
});

// ── Memory DELETE: the committed removal ───────────────────────────────────
//
// flair#2632 — ordinary, non-skill DELETE confirms removal after commit and
// compensates dropped attempts before retrying. The skill path closes the live head.

describe("flair#2632 — an ordinary, non-skill owner DELETE confirms row removal (real Harper)", () => {
  const seed = (id: string, token: string) =>
    insertRow({ id, agentId: owner.id, content: `delete ${id}`, contentHash: id, instanceToken: token, durability: "persistent" });
  const del = (id: string) => authSend(owner, "DELETE", `/Memory/${id}`);

  it("a newer write committed while the DELETE is paused: 2xx and the row is gone after the retry", async () => {
    const id = `csr-del-newer-${Date.now()}`;
    const token = randomUUID();
    await seed(id, token);
    const { response, paused, released } = await withPaused(
      "memory-delete",
      () => del(id),
      async () => { await updateRow({ id, content: "a newer write committed while the delete was paused" }); },
    );
    expect(paused, "the owner DELETE was not paused").toBe(true);
    expect(released).toBe("go");
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 300)).toBeLessThan(300);
    expect(await readRow(id), "the DELETE answered success with the row still stored").toBeNull();
    const history = await historyRows(id);
    expect(history.length, "the confirmed removal must keep exactly one deletion-history record").toBe(1);
    expect(history[0]?.memoryInstanceToken, "the kept history record is not this row's").toBe(token);
  }, 60_000);

  it("a same-owner replacement before the first DELETE attempt is refused and unchanged", async () => {
    const id = `csr-del-pre-replaced-${Date.now()}`;
    const token = randomUUID();
    const replacementToken = randomUUID();
    await seed(id, token);
    await insertPointer(id, token);
    const originalPointers = await pointerRows(id);
    let replacement: any;
    const { response, paused, released, observed } = await withPaused(
      "memory-delete-pre",
      () => del(id),
      async () => {
        await deleteRow(id);
        await seed(id, replacementToken);
        replacement = await readRow(id);
        expect(replacement?.agentId).toBe(owner.id);
        expect(replacement?.instanceToken).toBe(replacementToken);
      },
      () => waitForCommitted(id, (row) => row?.instanceToken === replacementToken, 15_000),
    );
    expect(paused, "the owner DELETE was not paused before its first attempt").toBe(true);
    expect(released).toBe("go");
    expect(observed).toBe(true);
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    expect(await readRow(id), "the replacement row changed").toEqual(replacement);
    expect(await historyRows(id)).toEqual([]);
    expect(await pointerRows(id)).toEqual(originalPointers);
  }, 60_000);

  it("a same-id replacement with a new token while the DELETE is paused is refused and not deleted", async () => {
    const id = `csr-del-replaced-${Date.now()}`;
    const token = randomUUID();
    const replacementToken = randomUUID();
    await seed(id, token);
    await insertPointer(id, token);
    const originalPointer = (await pointerRows(id))[0];
    const { response, paused, released } = await withPaused(
      "memory-delete",
      () => del(id),
      async () => { await updateRow({ id, instanceToken: replacementToken, content: "a replacement row under the same id" }); },
    );
    expect(paused, "the owner DELETE was not paused").toBe(true);
    expect(released).toBe("go");
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    const row = await readRow(id);
    expect(row?.instanceToken, "the replacement row was deleted").toBe(replacementToken);
    expect(await historyRows(id), "a row that was not deleted kept a deletion-history record").toEqual([]);
    const restored = await pointerRows(id);
    expect(restored.length).toBe(1);
    for (const field of ["memoryId", "hostSource", "scopeAtWrite", "authorId", "memoryInstanceToken", "receivedAt"]) {
      expect(restored[0]?.[field], `the old pointer's ${field} was not restored`).toEqual(originalPointer?.[field]);
    }
  }, 60_000);

  for (const point of ["memory-delete-pointer-restore", "memory-delete-pointer-restore-staged"]) {
    it(`preserves a replacement pointer committed at ${point}`, async () => {
      const id = `csr-del-pointer-replaced-${Date.now()}`;
      const token = randomUUID();
      const replacementToken = randomUUID();
      await seed(id, token);
      await insertPointer(id, token);
      armPoint("memory-delete");
      let replacement: any;
      const { response, paused, released } = await withPaused(
        point,
        async () => {
          const pending = del(id);
          try {
            expect(await waitFor(join(pauseDir, "paused.memory-delete"), 15_000)).toBe(true);
            await updateRow({ id, instanceToken: replacementToken, content: "replacement for pointer compensation" });
          } finally {
            releasePoint("memory-delete");
          }
          return await pending;
        },
        async () => {
          expect(await pointerRows(id), "the failed attempt's pointer delete did not commit").toEqual([]);
          await insertPointer(id, replacementToken);
          replacement = (await pointerRows(id))[0];
          expect(replacement?.memoryInstanceToken).toBe(replacementToken);
        },
      );
      expect(paused, `compensation did not pause at ${point}`).toBe(true);
      expect(released).toBe("go");
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBe(409);
      expect((await response.json()).error).toBe("stored_row_changed");
      expect((await readRow(id))?.instanceToken).toBe(replacementToken);
      expect(await historyRows(id)).toEqual([]);
      expect(await pointerRows(id), "compensation overwrote the replacement pointer").toEqual([replacement]);
    }, 60_000);
  }

  it("an owner change committed while the DELETE is paused is refused and the row survives", async () => {
    const id = `csr-del-owner-${Date.now()}`;
    const token = randomUUID();
    const other = mkAgent("csr-other");
    await ops({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: other.id, name: other.id, role: "agent", publicKey: other.publicKey, createdAt: new Date().toISOString() }],
    });
    await seed(id, token);
    const { response, paused, released } = await withPaused(
      "memory-delete",
      () => del(id),
      async () => { await updateRow({ id, agentId: other.id }); },
    );
    expect(paused, "the owner DELETE was not paused").toBe(true);
    expect(released).toBe("go");
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text).error).toBe("owner_changed");
    expect((await readRow(id))?.agentId, "the replacement row was deleted").toBe(other.id);
    expect(await historyRows(id), "a row that was not deleted kept a deletion-history record").toEqual([]);
  }, 60_000);

  it("CONTROL: with no competitor a DELETE answers 2xx, removes the row and records it", async () => {
    const id = `csr-del-ok-${Date.now()}`;
    const token = randomUUID();
    await seed(id, token);
    const res = await del(id);
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBeLessThan(300);
    expect(await readRow(id), "the row survived an ordinary DELETE").toBeNull();
    const history = await historyRows(id);
    expect(history.length, "the ordinary DELETE did not record its removal").toBe(1);
    expect(history[0]?.memoryInstanceToken).toBe(token);
  }, 60_000);
});
