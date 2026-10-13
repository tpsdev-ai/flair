// federation-retry-transition-2455.test.ts — flair#2455 slice 1, the atomic
// pending → terminal transition, against REAL Harper.
//
// Runs against a composed copy of the built component (test/helpers/
// federation-retry-probe-component.ts) that adds an admin-only probe whose POST
// calls the real transition, and a test-only module that makes ONE
// FederationRetry.put throw on demand; that failure switch exists only in the
// composed copy. To pause a transition after its read, the probe passes the
// transition's optional `pausePoint` callback: an in-process function argument
// that no request can supply and no shipped resource passes.
//
// Each refusal exercised here on a seeded row (already terminal, a missing or
// stray bound, a malformed row, a failed write, a busy lock) is checked against
// the WHOLE stored row: the refused call left it as it was. No other operation
// writes the row being compared between a refusal assertion's before and after
// reads (the lock-refusal case seeds a different peer's row in that interval).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRetryEntryKey, retryEntryKey } from "../../resources/federation-retry-lib.js";
import { componentWithRetryProbe, type RetryProbeComponent } from "../helpers/federation-retry-probe-component";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const sfx = Date.now().toString(36);
const PEER = `retry-transition-peer-${sfx}`;
const PROBE = "/ZzFederationRetryProbe";
const now = () => new Date().toISOString();

let harper: HarperInstance;
let component: RetryProbeComponent;
let pauseDir: string;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  if (!h.installDir.startsWith(tmpdir())) throw new Error(`refusing to run: ${h.installDir} is not a temp tree`);
}

function adminAuth(): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function readRetryRow(key: string): Promise<any> {
  const rows = await ops({
    operation: "search_by_hash", database: "flair", table: "FederationRetry",
    hash_values: [key], get_attributes: ["*"],
  });
  return (rows as any[])[0] ?? null;
}

/** A pending row whose peerId, table and recordId are the tuple `key` encodes. */
function pendingRow(key: string, over: Record<string, unknown> = {}) {
  const tuple = parseRetryEntryKey(key);
  if (!tuple) throw new Error(`not a retry key: ${key}`);
  return { id: key, ...tuple, state: "pending", firstRefusedAt: now(), attempts: 1, lastReason: "merge_error", createdAt: now(), ...over };
}

async function seedRow(row: Record<string, unknown>): Promise<void> {
  await ops({ operation: "upsert", database: "flair", table: "FederationRetry", records: [row] });
}

async function seedPending(key: string): Promise<void> {
  await seedRow(pendingRow(key));
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function probe(body: Record<string, unknown>, auth = true): Promise<Response> {
  return fetch(`${harper.httpURL}${PROBE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: adminAuth() } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

describe("flair#2455 — retry transition is atomic and fail-closed (real Harper)", () => {
  beforeAll(async () => {
    pauseDir = mkdtempSync(join(tmpdir(), "flair-2455-pause-"));
    const saved = process.env.FLAIR_TEST_PAUSE_DIR;
    process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
    try {
      component = componentWithRetryProbe();
      harper = await startHarper({ cwd: component.dir });
    } finally {
      if (saved === undefined) delete process.env.FLAIR_TEST_PAUSE_DIR;
      else process.env.FLAIR_TEST_PAUSE_DIR = saved;
    }
    assertOwnInstance(harper);
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (component) component.cleanup();
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  });

  test("the transition probe is admin-only", async () => {
    const res = await probe({ peerId: PEER, table: "Memory", recordId: "x", resolution: "merged" }, false);
    expect([401, 403], `anon probe returned ${res.status}`).toContain(res.status);
  });

  test("a pending row moves to terminal with its named outcome", async () => {
    const key = retryEntryKey(PEER, "Memory", `ok-${sfx}`);
    await seedPending(key);
    const res = await probe({ peerId: PEER, table: "Memory", recordId: `ok-${sfx}`, resolution: "retry_exhausted", bound: "attempts" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: key });

    const row = await readRetryRow(key);
    expect(row.state).toBe("terminal");
    expect(row.resolution).toBe("retry_exhausted");
    expect(row.bound).toBe("attempts");

    // A second transition on the same row is refused, and the row is unchanged.
    const again = (await (await probe({ peerId: PEER, table: "Memory", recordId: `ok-${sfx}`, resolution: "merged" })).json()) as any;
    expect(again.ok).toBe(false);
    expect(again.code).toBe("already_terminal");
    expect(await readRetryRow(key)).toEqual(row);
  });

  test("a retry_exhausted outcome without its bound is refused, and the row is unchanged", async () => {
    const key = retryEntryKey(PEER, "Memory", `nobound-${sfx}`);
    await seedPending(key);
    const before = await readRetryRow(key);
    for (const bound of [undefined, null]) {
      const out = (await (await probe({ peerId: PEER, table: "Memory", recordId: `nobound-${sfx}`, resolution: "retry_exhausted", bound })).json()) as any;
      expect(out.ok, `bound ${String(bound)}`).toBe(false);
      expect(out.code).toBe("invalid");
    }
    expect(await readRetryRow(key)).toEqual(before);
  });

  test("a bound on any resolution other than retry_exhausted is refused, and the row is unchanged", async () => {
    const key = retryEntryKey(PEER, "Memory", `strayb-${sfx}`);
    await seedPending(key);
    const before = await readRetryRow(key);
    for (const [resolution, bound] of [
      ["merged", "attempts"],
      ["refused_terminal", "age"],
      ["source_deleted", "both"],
      ["source_ineligible", "attempts"],
      ["peer_unavailable", "age"],
    ] as const) {
      const out = (await (await probe({ peerId: PEER, table: "Memory", recordId: `strayb-${sfx}`, resolution, bound })).json()) as any;
      expect(out.ok, `${resolution} + ${bound}`).toBe(false);
      expect(out.code).toBe("invalid");
    }
    expect(await readRetryRow(key)).toEqual(before);

    // The same resolution without a bound is accepted, and records a null bound.
    const ok = (await (await probe({ peerId: PEER, table: "Memory", recordId: `strayb-${sfx}`, resolution: "refused_terminal" })).json()) as any;
    expect(ok.ok).toBe(true);
    const row = await readRetryRow(key);
    expect(row.resolution).toBe("refused_terminal");
    expect(row.bound ?? null).toBeNull();
  });

  test("a malformed row (an id that is not its tuple's key, or an unknown state) is refused as malformed and never transitioned", async () => {
    // The id encodes `mm-…`, but the stored recordId says otherwise.
    const mismatchKey = retryEntryKey(PEER, "Memory", `mm-${sfx}`);
    await seedRow(pendingRow(mismatchKey, { recordId: `elsewhere-${sfx}` }));
    // A consistent id with a state that is neither pending nor terminal.
    const stateKey = retryEntryKey(PEER, "Memory", `badstate-${sfx}`);
    await seedRow(pendingRow(stateKey, { state: "paused" }));

    for (const [key, recordId] of [[mismatchKey, `mm-${sfx}`], [stateKey, `badstate-${sfx}`]] as const) {
      const before = await readRetryRow(key);
      const out = (await (await probe({ peerId: PEER, table: "Memory", recordId, resolution: "merged" })).json()) as any;
      expect(out.ok, recordId).toBe(false);
      expect(out.code, recordId).toBe("malformed");
      expect(await readRetryRow(key)).toEqual(before);
    }
  });

  test("a missing entry is refused by name and writes nothing", async () => {
    const out = (await (await probe({ peerId: PEER, table: "Memory", recordId: `absent-${sfx}`, resolution: "merged" })).json()) as any;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("not_found");
    expect(await readRetryRow(retryEntryKey(PEER, "Memory", `absent-${sfx}`))).toBeNull();
  });

  test("a bookkeeping write failure is fail-closed: the row stays pending, then recovers", async () => {
    const key = retryEntryKey(PEER, "Memory", `fail-${sfx}`);
    await seedPending(key);
    const before = await readRetryRow(key);

    // Arm the one-shot write failure, then attempt the transition.
    writeFileSync(join(pauseDir, "arm.retry-write-fail"), "");
    const failed = (await (await probe({ peerId: PEER, table: "Memory", recordId: `fail-${sfx}`, resolution: "retry_exhausted", bound: "age" })).json()) as any;
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe("write_failed");

    // Fail-closed: no terminal outcome was reported AND the row did not move.
    expect(await readRetryRow(key)).toEqual(before);

    // The failure was one-shot; a later attempt succeeds.
    const ok = (await (await probe({ peerId: PEER, table: "Memory", recordId: `fail-${sfx}`, resolution: "retry_exhausted", bound: "age" })).json()) as any;
    expect(ok.ok).toBe(true);
    expect((await readRetryRow(key)).state).toBe("terminal");
  });

  test("a transition paused after its read holds the peer's lock: a second transition of that peer is refused lock_busy and writes nothing", async () => {
    const key = retryEntryKey(PEER, "Memory", `race-${sfx}`);
    await seedPending(key);
    const before = await readRetryRow(key);
    // A row of ANOTHER peer, to show the lock is per peer, not global.
    const otherPeer = `${PEER}-other`;
    const otherKey = retryEntryKey(otherPeer, "Memory", `race-${sfx}`);
    await seedPending(otherKey);

    const tag = `race-${sfx}`;
    const first = probe({ peerId: PEER, table: "Memory", recordId: `race-${sfx}`, resolution: "merged", pauseTag: tag }).then((r) => r.json());
    try {
      // The first transition has read the pending row inside its transaction
      // and is paused there, holding the peer's lock.
      await waitForFile(join(pauseDir, `reached.${tag}`), 15_000);

      const second = (await (await probe({ peerId: PEER, table: "Memory", recordId: `race-${sfx}`, resolution: "retry_exhausted", bound: "attempts" })).json()) as any;
      expect(second.ok).toBe(false);
      expect(second.code).toBe("lock_busy");
      expect(await readRetryRow(key)).toEqual(before);

      const other = (await (await probe({ peerId: otherPeer, table: "Memory", recordId: `race-${sfx}`, resolution: "merged" })).json()) as any;
      expect(other.ok, "another peer's transition is not blocked").toBe(true);
    } finally {
      writeFileSync(join(pauseDir, `release.${tag}`), "");
    }

    expect(await first).toEqual({ ok: true, id: key });
    const row = await readRetryRow(key);
    expect(row.state).toBe("terminal");
    expect(row.resolution).toBe("merged");
    expect(row.bound ?? null).toBeNull();
  }, 30_000);
});
