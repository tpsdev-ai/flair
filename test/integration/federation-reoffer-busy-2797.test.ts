/**
 * federation-reoffer-busy-2797.test.ts — flair#2797 (real Harper, two instances).
 *
 * A generic Memory row the receiver refused `merge_target_busy` (its id's write
 * lock was held) is kept in the sender's FederationRetry table and offered
 * again on a later cycle, even though the sender's cursor has already advanced
 * past the row's own `updatedAt`. A first non-retryable refusal creates no
 * retry row; an existing pending row becomes terminal, and the retry path in
 * one sender run does not select it again (concurrent sender runs for one peer
 * are not serialized — a separate issue).
 *
 * The receiver holds the id's lock through the merge's existing pause point
 * (`federation-merge`): a second signed push from the same peer pauses there,
 * the sender syncs and is refused, the receiver's row is deleted, and the
 * paused merge then finds it gone (writes nothing). The retry row is the only
 * reason the next sync offers the row again.
 *
 * Two real, ephemeral, loopback, HOME-isolated Harpers. Fixtures are neutral
 * (`agent-a`, `flair_spoke_a`, `flair_hub_a`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { keystore } from "../../src/keystore";
import { FEDERATION_MEMORY_ATTRIBUTES } from "../../src/lib/federation-memory-attributes";
import { retryEntryKey } from "../../src/lib/federation-retry-row";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const SENDER_ID = "flair_spoke_a";
const HUB_ID = "flair_hub_a";
const AGENT = "agent-a";
const PEER = SENDER_ID;

const senderSeed = new Uint8Array(randomBytes(32));
const senderKp = nacl.sign.keyPair.fromSeed(senderSeed);
const hubKp = nacl.sign.keyPair();
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

let sender: HarperInstance;
let receiver: HarperInstance;
let pauseDir: string;
let proxy: any = null;
let capturedSyncBodies: any[] = [];

function assertOwnInstance(h: HarperInstance, what: string): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], `${what} ${url} must be loopback`).toContain(u.hostname);
    expect(["9925", "9926"], `${what} ${url} must avoid ports 9925/9926`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const basic = (h: HarperInstance) => "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");

async function ops(h: HarperInstance, operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic(h) },
    body: JSON.stringify({ database: "flair", ...operation }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation} on ${h.httpURL}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

const insertRow = (h: HarperInstance, table: string, row: Record<string, unknown>) =>
  ops(h, { operation: "insert", table, records: [row] });

async function readRow(h: HarperInstance, table: string, id: string): Promise<any> {
  const rows = await ops(h, { operation: "search_by_hash", table, hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function deleteRow(h: HarperInstance, table: string, id: string): Promise<void> {
  await ops(h, { operation: "delete", table, hash_values: [id] });
}

/** Remove every retry row so a case starts without an earlier case's obligation. */
async function clearRetries(): Promise<void> {
  const rows = await ops(sender, { operation: "sql", sql: "SELECT * FROM flair.FederationRetry" });
  for (const row of (Array.isArray(rows) ? rows : (rows?.results ?? [])) as any[]) {
    await deleteRow(sender, "FederationRetry", row.id);
  }
}

/** Put the sender's cursor at `at`. */
async function setCursor(at: Date): Promise<void> {
  const iso = at.toISOString();
  await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, lastSyncAt: iso, updatedAt: iso }] });
}

/** Put the sender's cursor ahead of every row already on the instance. */
async function setCursorNow(): Promise<void> {
  await setCursor(new Date());
}

/** Put the sender's cursor an hour back, so rows written now are past it. */
async function setCursorBehindRows(): Promise<void> {
  await setCursor(new Date(Date.now() - 3_600_000));
}

/** Delete every row of `table` on `h`, so an earlier case's row cannot be selected. */
async function clearTable(h: HarperInstance, table: string): Promise<void> {
  const rows = await ops(h, { operation: "sql", sql: `SELECT * FROM flair.${table}` });
  for (const row of (Array.isArray(rows) ? rows : (rows?.results ?? [])) as any[]) {
    await deleteRow(h, table, row.id);
  }
}

const MERGE_PAUSE = "federation-merge";

/**
 * How long cleanup waits for the pause point to record its result. A fixed
 * bound, so a release that is never acknowledged fails the case rather than
 * hanging it.
 */
const RELEASE_ACK_BOUND_MS = 10_000;

/**
 * The result the pause point recorded for `point`: `"go"` or `"timeout"` once
 * its wait has ended, null before that. It creates `released.<point>` empty
 * before waiting and writes the result afterwards
 * (resources/txn-pause-point.ts), so the file's content — not its existence —
 * is the completion signal.
 */
function pauseResult(point: string): string | null {
  try {
    const result = readFileSync(join(pauseDir, `released.${point}`), "utf8");
    return result.length > 0 ? result : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Wait, bounded, until the pause point has created `released.<point>` empty.
 * It creates `paused` before `released`, so `paused` alone does not mean the
 * release marker exists yet.
 */
async function waitForEmptyRelease(point: string): Promise<void> {
  const deadline = Date.now() + RELEASE_ACK_BOUND_MS;
  for (;;) {
    try {
      if (readFileSync(join(pauseDir, `released.${point}`), "utf8").length === 0) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the ${point} pause did not create its release marker within ${RELEASE_ACK_BOUND_MS}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function markerExists(name: string): boolean {
  try {
    readFileSync(join(pauseDir, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Release a pause an earlier case may still hold and remove every marker this
 * file arms. Both Harpers share one pause directory, and the pause point opens
 * its `claimed`/`paused`/`released` files with O_EXCL: a leftover marker makes
 * the next arm inert, while a leftover arm pauses the next push.
 *
 * A pause the case claimed may still be waiting, so `go` stays in place until
 * the pause point records its result in `released`; only then are the markers
 * removed.
 */
async function resetPauseMarkers(): Promise<void> {
  writeFileSync(join(pauseDir, `go.${MERGE_PAUSE}`), "");
  if (markerExists(`claimed.${MERGE_PAUSE}`) && pauseResult(MERGE_PAUSE) === null) {
    const deadline = Date.now() + RELEASE_ACK_BOUND_MS;
    while (pauseResult(MERGE_PAUSE) === null) {
      if (Date.now() >= deadline) {
        throw new Error(`did not observe the ${MERGE_PAUSE} pause release within ${RELEASE_ACK_BOUND_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  for (const name of [
    `arm.${MERGE_PAUSE}`,
    `claimed.${MERGE_PAUSE}`,
    `paused.${MERGE_PAUSE}`,
    `go.${MERGE_PAUSE}`,
    `released.${MERGE_PAUSE}`,
    "fail.federation-synclog",
  ]) {
    rmSync(join(pauseDir, name), { force: true });
  }
}

function retryRow(recordId: string, lastReason: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date(Date.now() - 60_000).toISOString();
  return {
    id: retryKey(recordId),
    peerId: HUB_ID,
    table: "Memory",
    recordId,
    state: "pending",
    firstRefusedAt: at,
    attempts: 1,
    lastReason,
    lastAttemptAt: at,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

async function sync(): Promise<{ pushed: number; skipped: number; error?: Error }> {
  const { runFederationSyncOnce } = await import("../../src/cli");
  return runFederationSyncOnce({
    target: sender.httpURL,
    opsTarget: sender.opsURL,
    adminUser: sender.admin.username,
    adminPass: sender.admin.password,
  });
}

/** One signed push of one Memory row, as the spoke. */
function push(memory: Record<string, unknown>): Promise<Response> {
  const body = signBodyFresh(
    {
      instanceId: PEER,
      records: [{
        originatorInstanceId: PEER,
        table: "Memory",
        id: memory.id,
        updatedAt: memory.updatedAt,
        data: memory,
      }],
      lamportClock: Date.now(),
    },
    senderKp.secretKey,
  );
  return fetch(`${receiver.httpURL}/FederationSync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
}

/** Wait until a direct push of this id is not refused merge_target_busy. */
async function waitForMergeLock(id: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const body = await (await push(memoryRow(id, `lock-probe-${i}`, new Date().toISOString()))).json() as any;
    if (!body.skippedReasons?.merge_target_busy) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the merge lock was never released");
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function memoryRow(id: string, content: string, updatedAt: string): Record<string, unknown> {
  return {
    id,
    agentId: AGENT,
    content,
    contentHash: `hash-${content}`,
    durability: "standard",
    visibility: "shared",
    archived: false,
    // The sender signs v2 records and includes principalId only for a row that
    // carries a provenance stamp with a `verified.agentId` field (the sender
    // parses that field; it does not verify the stamp); the receiver requires
    // the two to agree on a Memory row.
    provenance: JSON.stringify({ verified: { agentId: AGENT } }),
    createdAt: updatedAt,
    updatedAt,
  };
}

const retryKey = (id: string) => retryEntryKey(HUB_ID, "Memory", id);


beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2797-pause-"));
  keystore.setPrivateKeySeed(SENDER_ID, senderSeed);

  receiver = await startHarper({
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  sender = await startHarper({
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  assertOwnInstance(receiver, "receiver");
  assertOwnInstance(sender, "sender");

  const now = new Date().toISOString();
  await insertRow(receiver, "Instance", { id: HUB_ID, publicKey: b64url(hubKp.publicKey), role: "hub", createdAt: now });
  await insertRow(receiver, "Peer", { id: SENDER_ID, publicKey: b64url(senderKp.publicKey), role: "spoke", status: "paired", createdAt: now });
  await insertRow(sender, "Instance", { id: SENDER_ID, publicKey: b64url(senderKp.publicKey), role: "spoke", createdAt: now });
  await insertRow(sender, "Peer", { id: HUB_ID, publicKey: b64url(hubKp.publicKey), role: "hub", status: "paired", endpoint: receiver.httpURL, createdAt: now });
}, 480_000);

afterAll(async () => {
  if (proxy) proxy.stop(true);
  if (sender) await stopHarper(sender);
  if (receiver) await stopHarper(receiver);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS * 2 + 60_000);

describe("flair#2797 — a merge_target_busy refusal is re-offered after the lock clears", () => {
  beforeEach(async () => {
    await resetPauseMarkers();
    await clearTable(sender, "Memory");
    await clearTable(receiver, "Memory");
    await clearTable(receiver, "SyncLog");
    await clearRetries();
    await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, endpoint: receiver.httpURL, updatedAt: new Date().toISOString() }] });
  }, 120_000);

  afterEach(async () => {
    await resetPauseMarkers();
  }, 120_000);

  it("re-offers the refused row on the next sync, past the sender's cursor", async () => {
    await setCursorBehindRows();
    const id = "memory-reoffer-a";
    const updatedAt = new Date(Date.now() - 120_000).toISOString();
    const fromSpoke = memoryRow(id, "from-spoke", updatedAt);
    await insertRow(sender, "Memory", fromSpoke);
    await insertRow(receiver, "Memory", memoryRow(id, "on-hub", new Date(Date.now() - 180_000).toISOString()));

    // Hold the id's lock through the merge's own pause point with a second
    // signed push, then sync the sender: its offer is refused merge_target_busy.
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.federation-merge`), { force: true });
    writeFileSync(join(pauseDir, "arm.federation-merge"), "");
    const holder = push(memoryRow(id, "holder", new Date(Date.now() - 60_000).toISOString()));
    expect(await waitFor(join(pauseDir, "paused.federation-merge"), 120_000), "the merge never paused").toBe(true);

    const first = await sync();
    expect(first.error, String(first.error)).toBeUndefined();
    expect(first.skipped, JSON.stringify(first)).toBe(1);

    // The cursor advanced past the row's own updatedAt after the refusal; the
    // refusal is not lost because the sender recorded it.
    const hubPeer = await readRow(sender, "Peer", HUB_ID);
    expect(Date.parse(hubPeer.lastSyncAt), "the cursor did not advance past the row").toBeGreaterThan(Date.parse(updatedAt));
    const pending = await readRow(sender, "FederationRetry", retryKey(id));
    expect(pending, "the retryable refusal was not recorded").not.toBeNull();
    expect(pending.state).toBe("pending");
    expect(pending.lastReason).toBe("merge_target_busy");

    // The holder's merge finds its row deleted and writes nothing.
    await deleteRow(receiver, "Memory", id);
    writeFileSync(join(pauseDir, "go.federation-merge"), "");
    const holderBody = await (await holder).json() as any;
    expect(holderBody.skippedReasons?.merge_target_changed ?? 0, JSON.stringify(holderBody)).toBe(1);

    // Sync #2: only the retry row selects the row (its updatedAt is behind the
    // cursor). It lands and the obligation becomes terminal.
    const second = await sync();
    expect(second.error, String(second.error)).toBeUndefined();
    expect(second.pushed, `the retry row was not re-offered: ${JSON.stringify(second)}`).toBe(1);
    const landed = await readRow(receiver, "Memory", id);
    expect(landed).not.toBeNull();
    expect(landed.content).toBe("from-spoke");
    const done = await readRow(sender, "FederationRetry", retryKey(id));
    expect(done.state).toBe("terminal");
    expect(done.resolution).toBe("merged");
  }, 420_000);

  it("a non-retryable refusal is not recorded and is not re-offered", async () => {
    await setCursorBehindRows();
    const id = `memory.${randomBytes(3).toString("hex")}.content`;
    const updatedAt = new Date().toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "not-federated", updatedAt));

    const first = await sync();
    expect(first.error, String(first.error)).toBeUndefined();
    expect(first.skipped, JSON.stringify(first)).toBe(1);
    expect(await readRow(sender, "FederationRetry", retryKey(id)), "a non-retryable refusal was recorded").toBeNull();

    const second = await sync();
    expect(second.error, String(second.error)).toBeUndefined();
    expect(second.pushed, `the refused row was re-offered: ${JSON.stringify(second)}`).toBe(0);
    expect(await readRow(receiver, "Memory", id)).toBeNull();
  }, 240_000);

  it("the busy skip writes a SyncLog row naming its skippedReasons", async () => {
    await setCursorBehindRows();
    const id = "memory-synclog-a";
    const updatedAt = new Date().toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "logged", updatedAt));

    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.federation-merge`), { force: true });
    writeFileSync(join(pauseDir, "arm.federation-merge"), "");
    const holder = push(memoryRow(id, "holder-log", new Date(Date.now() - 60_000).toISOString()));
    expect(await waitFor(join(pauseDir, "paused.federation-merge"), 120_000), "the merge never paused").toBe(true);
    const result = await sync();
    expect(result.error, String(result.error)).toBeUndefined();
    expect(result.skipped, JSON.stringify(result)).toBe(1);
    writeFileSync(join(pauseDir, "go.federation-merge"), "");
    await holder;

    const rows = await ops(receiver, { operation: "sql", sql: "SELECT * FROM flair.SyncLog" });
    const list = Array.isArray(rows) ? rows : (rows?.results ?? []);
    const forPeer = (list as any[]).filter((r) => r.peerId === SENDER_ID);
    expect(forPeer.length).toBeGreaterThan(0);
    const busy = forPeer
      .map((row) => ({ row, reasons: JSON.parse(row.skippedReasons) }))
      .find((entry) => entry.reasons.merge_target_busy === 1);
    expect(busy, "no SyncLog row names the busy skip").toBeDefined();
    expect(busy!.row.skippedCount, JSON.stringify(busy!.row)).toBe(1);
    expect(busy!.row.status, JSON.stringify(busy!.row)).toBe("partial");
  }, 300_000);

  it("cleanup waits for a paused merge's release acknowledgement, and fails when it never arrives", async () => {
    const at = new Date().toISOString();
    const id = "memory-cleanup-ack";

    // A real merge is inside the pause when cleanup starts: no `go` has been
    // written, so the pause point has created `released` empty and not yet
    // recorded a result.
    writeFileSync(join(pauseDir, `arm.${MERGE_PAUSE}`), "");
    const holder = push(memoryRow(id, "cleanup-ack-holder", at));
    expect(await waitFor(join(pauseDir, `paused.${MERGE_PAUSE}`), 120_000), "the merge never paused").toBe(true);
    expect(pauseResult(MERGE_PAUSE), "the pause recorded a result before cleanup started").toBeNull();
    expect(markerExists(`claimed.${MERGE_PAUSE}`), "the pause never claimed the arm").toBe(true);

    await resetPauseMarkers();
    // Cleanup released the pause and only then removed the markers; the merge
    // it held can now finish.
    expect((await holder).status).toBe(200);
    expect(markerExists(`released.${MERGE_PAUSE}`), "cleanup left the released marker").toBe(false);

    // An outstanding pause that has not acknowledged holds cleanup open: it
    // creates `released` empty and writes its result only when its wait ends.
    writeFileSync(join(pauseDir, `claimed.${MERGE_PAUSE}`), "");
    writeFileSync(join(pauseDir, `released.${MERGE_PAUSE}`), "");
    let settled = false;
    const pending = resetPauseMarkers().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled, "cleanup resolved while the release was unacknowledged").toBe(false);
    writeFileSync(join(pauseDir, `released.${MERGE_PAUSE}`), "go");
    await pending;
    expect(markerExists(`released.${MERGE_PAUSE}`), "cleanup left the released marker").toBe(false);

    // Cleanup fails when it cannot observe the release acknowledgement. The
    // pause keeps its own open descriptor, so removing the marker hides its
    // result for good.
    writeFileSync(join(pauseDir, `arm.${MERGE_PAUSE}`), "");
    const stuck = push(memoryRow("memory-cleanup-ack-stuck", "stuck", at));
    try {
      await waitForEmptyRelease(MERGE_PAUSE);
      rmSync(join(pauseDir, `released.${MERGE_PAUSE}`), { force: true });
      const failingAt = Date.now();
      let failure: unknown = null;
      try {
        await resetPauseMarkers();
      } catch (error) {
        failure = error;
      }
      const failedAfter = Date.now() - failingAt;
      expect(failure, "cleanup resolved without the release acknowledgement").not.toBeNull();
      expect(String(failure)).toContain(
        `did not observe the ${MERGE_PAUSE} pause release within ${RELEASE_ACK_BOUND_MS}ms`,
      );
      expect(failedAfter).toBeGreaterThanOrEqual(RELEASE_ACK_BOUND_MS);
      expect(failedAfter).toBeLessThan(RELEASE_ACK_BOUND_MS + 6_000);
      expect((await stuck).status).toBe(200);
    } finally {
      for (const name of [
        `arm.${MERGE_PAUSE}`,
        `claimed.${MERGE_PAUSE}`,
        `paused.${MERGE_PAUSE}`,
        `go.${MERGE_PAUSE}`,
        `released.${MERGE_PAUSE}`,
      ]) {
        rmSync(join(pauseDir, name), { force: true });
      }
    }
  }, 240_000);

  it("a failed SyncLog write is reported in the response, not only logged", async () => {
    const id = "memory-synclog-unwritten";
    const updatedAt = new Date(Date.now() - 20_000).toISOString();
    const row = memoryRow(id, "unlogged", updatedAt);

    writeFileSync(join(pauseDir, "fail.federation-synclog"), "");
    const failed = await push(row);
    expect(failed.status).toBe(200);
    const failedBody = await failed.json() as any;
    expect(failedBody.merged, JSON.stringify(failedBody)).toBe(1);
    expect(failedBody.syncLogWritten, JSON.stringify(failedBody)).toBe(false);

    const retryId = "memory-synclog-written";
    const written = await push(memoryRow(retryId, "logged", updatedAt));
    expect(written.status).toBe(200);
    const writtenBody = await written.json() as any;
    expect(writtenBody.merged, JSON.stringify(writtenBody)).toBe(1);
    expect(writtenBody.syncLogWritten, JSON.stringify(writtenBody)).toBe(true);
  }, 120_000);

  it("re-offers a projected row: the signed batch carries only declared fields", async () => {
    await clearRetries();
    await setCursorNow();
    const id = "memory-projected-a";
    const at = new Date(Date.now() - 600_000).toISOString();
    await insertRow(sender, "Memory", { ...memoryRow(id, "projected", at), undeclaredProbe: "SENTINEL" });
    await insertRow(sender, "FederationRetry", retryRow(id, "merge_target_busy"));

    capturedSyncBodies = [];
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/FederationSync" || req.method !== "POST") return new Response("not found", { status: 404 });
        const text = await req.text();
        const body = JSON.parse(text);
        if (Array.isArray(body.records) && body.records.length > 0) capturedSyncBodies.push(body);
        return fetch(`${receiver.httpURL}/FederationSync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: text,
        });
      },
    });
    expect(proxy.port).not.toBe(9925);
    expect(proxy.port).not.toBe(9926);
    await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, endpoint: `http://127.0.0.1:${proxy.port}`, updatedAt: new Date().toISOString() }] });
    try {
      const result = await sync();
      expect(result.error, String(result.error)).toBeUndefined();
      expect(result.pushed, JSON.stringify(result)).toBe(1);
      expect(capturedSyncBodies).toHaveLength(1);
      const data = capturedSyncBodies[0].records[0].data;
      expect(data.content).toBe("projected");
      expect(Object.keys(data).every((key) => (FEDERATION_MEMORY_ATTRIBUTES as readonly string[]).includes(key))).toBe(true);
      expect(data.undeclaredProbe).toBeUndefined();
    } finally {
      await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, endpoint: receiver.httpURL, updatedAt: new Date().toISOString() }] });
      proxy.stop(true);
      proxy = null;
    }
  }, 180_000);

  it("a first indeterminate offer records a pending row before the cursor advances", async () => {
    await clearRetries();
    await setCursorBehindRows();
    const id = "memory-first-indeterminate";
    const updatedAt = new Date().toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "first-indeterminate", updatedAt));

    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.federation-merge`), { force: true });
    writeFileSync(join(pauseDir, "arm.federation-merge"), "");
    const first = await sync();
    expect(first.error, String(first.error)).toBeUndefined();
    expect(first.pushed, JSON.stringify(first)).toBe(0);

    const pending = await readRow(sender, "FederationRetry", retryKey(id));
    expect(pending, "a first indeterminate outcome recorded no obligation").not.toBeNull();
    expect(pending.state).toBe("pending");
    expect(pending.lastReason).toBe("retry_unknown");
    expect(pending.attempts).toBe(1);

    const hubPeer = await readRow(sender, "Peer", HUB_ID);
    expect(Date.parse(hubPeer.lastSyncAt), "the cursor did not advance").toBeGreaterThan(Date.parse(updatedAt));

    writeFileSync(join(pauseDir, "go.federation-merge"), "");
    expect(await waitFor(join(pauseDir, "released.federation-merge"), 30_000), "the merge never released").toBe(true);
    await waitForMergeLock(id);

    const second = await sync();
    expect(second.error, String(second.error)).toBeUndefined();
    expect(second.pushed, `the first indeterminate row was not re-offered: ${JSON.stringify(second)}`).toBe(1);
    const done = await readRow(sender, "FederationRetry", retryKey(id));
    expect(done.state).toBe("terminal");
    expect(done.resolution).toBe("merged");
  }, 420_000);

  it("a failed re-offer keeps the reserved attempt, so the next cycle waits its backoff", async () => {
    await clearRetries();
    await setCursorNow();
    const id = "memory-failed-reoffer";
    const at = new Date(Date.now() - 600_000).toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "failed-reoffer", at));
    await insertRow(sender, "FederationRetry", retryRow(id, "merge_target_busy", { attempts: 1 }));
    const before = await readRow(sender, "FederationRetry", retryKey(id));

    await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, endpoint: `${receiver.httpURL}/bad`, updatedAt: new Date().toISOString() }] });
    try {
      const failed = await sync();
      expect(failed.error, "the send to a 404 endpoint did not fail").toBeDefined();
    } finally {
      await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, endpoint: receiver.httpURL, updatedAt: new Date().toISOString() }] });
    }

    const reserved = await readRow(sender, "FederationRetry", retryKey(id));
    expect(reserved.attempts, "the failed offer did not reserve an attempt").toBe(2);
    expect(Date.parse(reserved.lastAttemptAt)).toBeGreaterThan(Date.parse(before.lastAttemptAt));

    // attempts=2 backs off 30s; the immediate next cycle must not offer it.
    const nextCycle = await sync();
    expect(nextCycle.error, String(nextCycle.error)).toBeUndefined();
    expect(nextCycle.pushed, `the row was offered before its backoff: ${JSON.stringify(nextCycle)}`).toBe(0);
    expect(await readRow(receiver, "Memory", id)).toBeNull();

    // Age the reservation past the backoff: the same row is then offered.
    const aged = { ...reserved, lastAttemptAt: new Date(Date.now() - 31_000).toISOString() };
    await ops(sender, { operation: "upsert", table: "FederationRetry", records: [aged] });
    const after = await sync();
    expect(after.error, String(after.error)).toBeUndefined();
    expect(after.pushed, `the row was not offered after its backoff: ${JSON.stringify(after)}`).toBe(1);
    expect((await readRow(receiver, "Memory", id)).content).toBe("failed-reoffer");
  }, 240_000);

  it("a cursor-selected source with a valid pending row reserves the attempt before a failed send", async () => {
    await clearRetries();
    await setCursorNow();
    const id = "memory-cursor-failed";
    // Past the cursor, inside the receiver's future allowance.
    const updatedAt = new Date(Date.now() + 5_000).toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "cursor-failed", updatedAt));
    await insertRow(sender, "FederationRetry", retryRow(id, "merge_target_busy", { attempts: 1 }));
    const before = await readRow(sender, "FederationRetry", retryKey(id));

    await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, endpoint: `${receiver.httpURL}/bad`, updatedAt: new Date().toISOString() }] });
    try {
      const failed = await sync();
      expect(failed.error, "the send to a 404 endpoint did not fail").toBeDefined();
    } finally {
      await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, endpoint: receiver.httpURL, updatedAt: new Date().toISOString() }] });
    }

    const stored = await readRow(sender, "FederationRetry", retryKey(id));
    expect(stored.state, JSON.stringify(stored)).toBe("pending");
    expect(stored.attempts, "the cursor-selected offer did not reserve an attempt").toBe(2);
    expect(stored.lastReason).toBe("merge_target_busy");
    expect(Date.parse(stored.lastAttemptAt)).toBeGreaterThan(Date.parse(before.lastAttemptAt));
    expect(await readRow(receiver, "Memory", id)).toBeNull();
    // Age the source behind the cursor so no later case selects it.
    await ops(sender, { operation: "update", table: "Memory", records: [{ id, updatedAt: new Date(Date.now() - 600_000).toISOString() }] });
  }, 240_000);

  it("a cursor-selected source with a valid pending row resolves that row when merged", async () => {
    await clearRetries();
    await setCursorNow();
    const id = "memory-cursor-merged";
    const updatedAt = new Date(Date.now() + 5_000).toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "cursor-merged", updatedAt));
    await insertRow(sender, "FederationRetry", retryRow(id, "merge_target_busy", { attempts: 1 }));

    const result = await sync();
    expect(result.error, String(result.error)).toBeUndefined();
    expect(result.pushed, JSON.stringify(result)).toBe(1);
    expect((await readRow(receiver, "Memory", id)).content).toBe("cursor-merged");
    const done = await readRow(sender, "FederationRetry", retryKey(id));
    expect(done.state, JSON.stringify(done)).toBe("terminal");
    expect(done.resolution).toBe("merged");
    expect(done.attempts, "the cursor-selected offer did not reserve its attempt").toBe(2);
    await ops(sender, { operation: "update", table: "Memory", records: [{ id, updatedAt: new Date(Date.now() - 600_000).toISOString() }] });
  }, 240_000);

  it("a cursor-selected source with a malformed pending row is offered and the row is left as stored", async () => {
    await clearRetries();
    await setCursorNow();
    const id = "memory-cursor-malformed";
    const updatedAt = new Date(Date.now() + 5_000).toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "cursor-malformed", updatedAt));
    await insertRow(sender, "FederationRetry", retryRow(id, "not_a_reason", { attempts: 1 }));

    const warn = mock((...args: any[]) => {
      void args;
    });
    const original = console.warn;
    console.warn = warn as any;
    try {
      const result = await sync();
      expect(result.error, String(result.error)).toBeUndefined();
      expect(result.pushed, JSON.stringify(result)).toBe(1);
      expect(warn.mock.calls.some((call) => String(call[0]).includes(retryKey(id)) && String(call[0]).includes("unknown_reason"))).toBe(true);
    } finally {
      console.warn = original;
    }
    expect((await readRow(receiver, "Memory", id)).content).toBe("cursor-malformed");
    const stored = await readRow(sender, "FederationRetry", retryKey(id));
    expect(stored.state, JSON.stringify(stored)).toBe("pending");
    expect(stored.attempts).toBe(1);
    expect(stored.lastReason).toBe("not_a_reason");
    await ops(sender, { operation: "update", table: "Memory", records: [{ id, updatedAt: new Date(Date.now() - 600_000).toISOString() }] });
  }, 240_000);

  it("a pending row with an unknown lastReason is not offered and is reported", async () => {
    await clearRetries();
    await setCursorNow();
    const id = "memory-bad-reason";
    const at = new Date(Date.now() - 600_000).toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "bad-reason", at));
    await insertRow(sender, "FederationRetry", retryRow(id, "not_a_reason"));

    const warn = mock((...args: any[]) => {
      void args;
    });
    const original = console.warn;
    console.warn = warn as any;
    try {
      const result = await sync();
      expect(result.error, String(result.error)).toBeUndefined();
      expect(result.pushed, JSON.stringify(result)).toBe(0);
      expect(warn.mock.calls.some((call) => String(call[0]).includes(retryKey(id)) && String(call[0]).includes("unknown_reason"))).toBe(true);
    } finally {
      console.warn = original;
    }
    expect(await readRow(receiver, "Memory", id)).toBeNull();
    const stored = await readRow(sender, "FederationRetry", retryKey(id));
    expect(stored.state).toBe("pending");
    expect(stored.attempts).toBe(1);
  }, 180_000);

  it("a pending row carrying an outcome is not offered and no batch reaches the receiver", async () => {
    await clearRetries();
    await setCursorNow();
    const id = "memory-bad-outcome";
    const at = new Date(Date.now() - 600_000).toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "bad-outcome", at));
    await insertRow(sender, "FederationRetry", retryRow(id, "merge_target_busy", { resolution: "merged" }));

    capturedSyncBodies = [];
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/FederationSync" || req.method !== "POST") return new Response("not found", { status: 404 });
        const text = await req.text();
        const body = JSON.parse(text);
        if (Array.isArray(body.records) && body.records.length > 0) capturedSyncBodies.push(body);
        return fetch(`${receiver.httpURL}/FederationSync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: text,
        });
      },
    });
    expect(proxy.port).not.toBe(9925);
    expect(proxy.port).not.toBe(9926);
    await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, endpoint: `http://127.0.0.1:${proxy.port}`, updatedAt: new Date().toISOString() }] });

    const warn = mock((...args: any[]) => {
      void args;
    });
    const original = console.warn;
    console.warn = warn as any;
    try {
      const result = await sync();
      expect(result.error, String(result.error)).toBeUndefined();
      expect(result.pushed, JSON.stringify(result)).toBe(0);
      expect(warn.mock.calls.some((call) => String(call[0]).includes(retryKey(id)) && String(call[0]).includes("outcome_mismatch"))).toBe(true);
      expect(capturedSyncBodies, "a retry batch reached the receiver").toEqual([]);
    } finally {
      console.warn = original;
      await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, endpoint: receiver.httpURL, updatedAt: new Date().toISOString() }] });
      proxy.stop(true);
      proxy = null;
    }
    expect(await readRow(receiver, "Memory", id)).toBeNull();
    const stored = await readRow(sender, "FederationRetry", retryKey(id));
    expect(stored.state).toBe("pending");
    expect(stored.attempts).toBe(1);
  }, 180_000);
});
