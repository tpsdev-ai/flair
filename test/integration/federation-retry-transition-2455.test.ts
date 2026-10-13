// federation-retry-transition-2455.test.ts — flair#2455 slice 1, the atomic
// pending → terminal transition, against REAL Harper.
//
// Runs against a composed copy of the built component (test/helpers/
// federation-retry-probe-component.ts) that adds an admin-only probe whose POST
// calls the real transition, and a test-only module that makes ONE
// FederationRetry.put throw on demand. Nothing under resources/ ships a failure
// switch.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryEntryKey } from "../../resources/federation-retry-lib.js";
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

async function seedPending(key: string): Promise<void> {
  await ops({
    operation: "upsert", database: "flair", table: "FederationRetry",
    records: [{ id: key, peerId: PEER, table: "Memory", recordId: `row-${sfx}`, state: "pending", firstRefusedAt: now(), attempts: 1, createdAt: now() }],
  });
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
    expect((await readRetryRow(key)).resolution).toBe("retry_exhausted");
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

    // Arm the one-shot write failure, then attempt the transition.
    writeFileSync(join(pauseDir, "arm.retry-write-fail"), "");
    const failed = (await (await probe({ peerId: PEER, table: "Memory", recordId: `fail-${sfx}`, resolution: "retry_exhausted", bound: "age" })).json()) as any;
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe("write_failed");

    // Fail-closed: no terminal outcome was reported AND the row did not move.
    const row = await readRetryRow(key);
    expect(row.state).toBe("pending");
    expect(row.resolution ?? null).toBeNull();

    // The failure was one-shot; a later attempt succeeds.
    const ok = (await (await probe({ peerId: PEER, table: "Memory", recordId: `fail-${sfx}`, resolution: "retry_exhausted", bound: "age" })).json()) as any;
    expect(ok.ok).toBe(true);
    expect((await readRetryRow(key)).state).toBe("terminal");
  });

  test("two concurrent transitions of one row: exactly one wins", async () => {
    const key = retryEntryKey(PEER, "Memory", `race-${sfx}`);
    await seedPending(key);
    const [a, b] = await Promise.all([
      probe({ peerId: PEER, table: "Memory", recordId: `race-${sfx}`, resolution: "merged" }).then((r) => r.json()),
      probe({ peerId: PEER, table: "Memory", recordId: `race-${sfx}`, resolution: "retry_exhausted", bound: "attempts" }).then((r) => r.json()),
    ]);
    const wins = [a, b].filter((o: any) => o.ok === true).length;
    expect(wins).toBe(1);
    expect((await readRetryRow(key)).state).toBe("terminal");
  });
});
