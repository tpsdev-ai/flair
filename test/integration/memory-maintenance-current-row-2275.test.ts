/**
 * memory-maintenance-current-row-2275.test.ts — flair#2275, real Harper.
 *
 * Every MemoryMaintenance action (expiry delete, orphan pointer cleanup,
 * archive) re-reads the row inside a transaction it owns and acts only when the
 * row is STILL the one the scan selected; a changed row is skipped. These cases
 * commit a competing change to the row around that transaction:
 *
 *   - (pause) maintenance's owned transaction opens first and pauses between its
 *     read and its act (resources/txn-pause-point.ts, enabled by
 *     FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, set for this
 *     file's Harper only). The test arms the pause, starts maintenance, waits
 *     until it is paused, commits the competing change, then releases it. The
 *     change is visible at the confirmation (committed) re-read, so the action
 *     is skipped and the competing change survives.
 *   - (pre) the competing writer's transaction opens first: the pause holds the
 *     scan-selected row still before maintenance's transaction opens, the
 *     competing change commits, and maintenance's in-transaction read then sees
 *     it. The action is skipped and the competing change survives.
 *
 * Unchanged rows are still maintained (the control cases).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

const PAST = "2000-01-01T00:00:00.000Z";
const POINTER = { v: 1, host: "host-a", kind: "run", id: "run-aaaaaaaa" };

function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}

let harper: HarperInstance;
let pauseDir: string;
const adminBasic = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminBasic() },
    body: JSON.stringify(op),
  });
}
async function adminFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: adminBasic() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function insertMemory(records: Record<string, any>[]): Promise<void> {
  const res = await adminOp({ operation: "insert", database: "flair", table: "Memory", records });
  expect(res.status, `Memory insert returned ${res.status}`).toBe(200);
}
async function updateMemory(records: Record<string, any>[]): Promise<void> {
  const res = await adminOp({ operation: "update", database: "flair", table: "Memory", records });
  expect(res.status, `Memory update returned ${res.status}`).toBe(200);
}
async function insertPointer(memoryId: string): Promise<void> {
  const res = await adminOp({
    operation: "insert", database: "flair", table: "MemoryHostSource",
    records: [{ memoryId, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "host-a", memoryInstanceToken: randomUUID(), receivedAt: new Date().toISOString() }],
  });
  expect(res.status, `MemoryHostSource insert returned ${res.status}`).toBe(200);
}
async function deletePointer(memoryId: string): Promise<void> {
  const res = await adminOp({ operation: "delete", database: "flair", table: "MemoryHostSource", hash_values: [memoryId] });
  expect([200, 404]).toContain(res.status);
}
async function readMemory(id: string): Promise<any> {
  const res = await adminOp({ operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"] });
  expect(res.status, `search_by_hash returned ${res.status}`).toBe(200);
  return (JSON.parse(await res.text()) as any[])[0] ?? null;
}
async function readPointers(memoryId: string): Promise<any[]> {
  const res = await adminOp({ operation: "search_by_value", database: "flair", table: "MemoryHostSource", search_attribute: "memoryId", search_type: "equals", search_value: memoryId, get_attributes: ["*"] });
  expect(res.status, `pointer search returned ${res.status}`).toBe(200);
  return JSON.parse(await res.text());
}
async function maintain(agentId?: string): Promise<any> {
  const res = await adminFetch("POST", "/MemoryMaintenance", agentId === undefined ? {} : { agentId });
  const text = await res.text();
  expect(res.status, `maintenance returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Arm `point`, start `run` (the maintenance pass), and once it is paused inside
 * its owned transaction run `compete` (the competing write), then release it.
 * Returns the pass's result, the competing step's result and how the pause
 * ended.
 */
async function withPausedAction<T>(point: string, run: () => Promise<any>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = run();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 15_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const result = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { result, competed, released };
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-mc-2275-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    // The spawned Harper has its copy; no later Harper in this process inherits it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2275 — MemoryMaintenance acts on the current row (real Harper)", () => {
  it("expiry control: an unchanged expired ephemeral row is still deleted", async () => {
    await insertMemory([{ id: "mc-exp-ctrl", agentId: "mc-exp-ctrl", content: "expired body", contentHash: "mc-exp-ctrl", visibility: "shared", durability: "ephemeral", expiresAt: PAST, createdAt: PAST, archived: false, instanceToken: randomUUID() }]);
    const result = await maintain("mc-exp-ctrl");
    expect(result.expired, JSON.stringify(result)).toBe(1);
    expect(await readMemory("mc-exp-ctrl")).toBeNull();
  }, 60_000);

  it("expiry (pause): a content edit committed while the delete is paused is kept and the delete is skipped", async () => {
    const EDITED = "expiry target body AFTER the competing edit";
    await insertMemory([{ id: "mc-exp-pause", agentId: "mc-exp-pause", content: "expiry target body before", contentHash: "mc-exp-pause", visibility: "shared", durability: "ephemeral", expiresAt: PAST, createdAt: PAST, archived: false, instanceToken: randomUUID() }]);
    const { result, released } = await withPausedAction(
      "maintenance-expiry",
      () => maintain("mc-exp-pause"),
      () => updateMemory([{ id: "mc-exp-pause", content: EDITED }]),
    );
    expect(released, "maintenance was not paused and released by this test").toBe("go");
    expect(result.expired, JSON.stringify(result)).toBe(0);
    expect(result.skipped, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
    const row = await readMemory("mc-exp-pause");
    expect(row, "the changed row was hard-deleted").not.toBeNull();
    expect(row?.content).toBe(EDITED); // assertion: the competing edit is kept
  }, 60_000);

  it("expiry (pre): an edit committed before the delete's transaction opens is kept and the delete is skipped", async () => {
    const EDITED = "expiry pre target body AFTER the competing edit";
    await insertMemory([{ id: "mc-exp-pre", agentId: "mc-exp-pre", content: "expiry pre target body before", contentHash: "mc-exp-pre", visibility: "shared", durability: "ephemeral", expiresAt: PAST, createdAt: PAST, archived: false, instanceToken: randomUUID() }]);
    const { result, released } = await withPausedAction(
      "maintenance-expiry-pre",
      () => maintain("mc-exp-pre"),
      () => updateMemory([{ id: "mc-exp-pre", content: EDITED }]),
    );
    expect(released, "maintenance was not paused and released by this test").toBe("go");
    expect(result.expired, JSON.stringify(result)).toBe(0);
    expect(result.skipped, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
    const row = await readMemory("mc-exp-pre");
    expect(row, "the changed row was hard-deleted").not.toBeNull();
    expect(row?.content).toBe(EDITED); // assertion: the competing edit is kept
  }, 60_000);

  it("archive control: an unchanged validTo-expired row is still archived", async () => {
    await insertMemory([{ id: "mc-arch-ctrl", agentId: "mc-arch-ctrl", content: "archival body", contentHash: "mc-arch-ctrl", visibility: "shared", durability: "standard", validTo: PAST, createdAt: PAST, archived: false, instanceToken: randomUUID() }]);
    const result = await maintain("mc-arch-ctrl");
    expect(result.archived, JSON.stringify(result)).toBe(1);
    expect((await readMemory("mc-arch-ctrl"))?.archived).toBe(true);
  }, 60_000);

  it("archive (pause): a content edit committed while the archive is paused is kept and the archive is skipped", async () => {
    const EDITED = "archive target body AFTER the competing edit";
    await insertMemory([{ id: "mc-arch-pause", agentId: "mc-arch-pause", content: "archive target body before", contentHash: "mc-arch-pause", visibility: "shared", durability: "standard", validTo: PAST, createdAt: PAST, archived: false, instanceToken: randomUUID() }]);
    const { result, released } = await withPausedAction(
      "maintenance-archive",
      () => maintain("mc-arch-pause"),
      () => updateMemory([{ id: "mc-arch-pause", content: EDITED }]),
    );
    expect(released, "maintenance was not paused and released by this test").toBe("go");
    expect(result.archived, JSON.stringify(result)).toBe(0);
    expect(result.skipped, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
    const row = await readMemory("mc-arch-pause");
    expect(row?.archived ?? false, "the stale scan copy was written over the competing edit").toBe(false);
    expect(row?.content).toBe(EDITED); // assertion: the competing edit is kept
  }, 60_000);

  it("archive (pre): a content edit committed before the archive's transaction opens is kept and the archive is skipped", async () => {
    const EDITED = "archive pre target body AFTER the competing edit";
    await insertMemory([{ id: "mc-arch-pre", agentId: "mc-arch-pre", content: "archive pre target body before", contentHash: "mc-arch-pre", visibility: "shared", durability: "standard", validTo: PAST, createdAt: PAST, archived: false, instanceToken: randomUUID() }]);
    const { result, released } = await withPausedAction(
      "maintenance-archive-pre",
      () => maintain("mc-arch-pre"),
      () => updateMemory([{ id: "mc-arch-pre", content: EDITED }]),
    );
    expect(released, "maintenance was not paused and released by this test").toBe("go");
    expect(result.archived, JSON.stringify(result)).toBe(0);
    expect(result.skipped, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
    const row = await readMemory("mc-arch-pre");
    expect(row?.archived ?? false, "the stale scan copy was written over the competing edit").toBe(false);
    expect(row?.content).toBe(EDITED); // assertion: the competing edit is kept
  }, 60_000);
});

describe("flair#2275 — MemoryMaintenance orphan sweep acts on the current row (real Harper)", () => {
  it("orphan control: an unchanged archived row's pointer is still cleaned", async () => {
    await insertMemory([{ id: "mc-orph-ctrl", agentId: "mc-orph-ctrl", content: "orphan ctrl body", contentHash: "mc-orph-ctrl", visibility: "shared", durability: "permanent", createdAt: PAST, archived: true, instanceToken: randomUUID() }]);
    await insertPointer("mc-orph-ctrl");
    const result = await maintain("mc-orph-ctrl");
    expect(result.orphans, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
    expect(await readPointers("mc-orph-ctrl")).toEqual([]);
  }, 60_000);

  it("orphan (pause): an edit committed while the pointer cleanup is paused keeps the pointer", async () => {
    const EDITED = "orphan target body AFTER the competing edit";
    await insertMemory([{ id: "mc-orph-pause", agentId: "mc-orph-pause", content: "orphan target body before", contentHash: "mc-orph-pause", visibility: "shared", durability: "permanent", createdAt: PAST, archived: true, instanceToken: randomUUID() }]);
    await insertPointer("mc-orph-pause");
    try {
      const { result, released } = await withPausedAction(
        "maintenance-orphan",
        () => maintain("mc-orph-pause"),
        () => updateMemory([{ id: "mc-orph-pause", content: EDITED }]),
      );
      expect(released, "maintenance was not paused and released by this test").toBe("go");
      expect(result.skipped, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
      expect((await readPointers("mc-orph-pause")).length, "the pointer of a changed row was swept").toBe(1);
      expect((await readMemory("mc-orph-pause"))?.content).toBe(EDITED); // assertion: the competing edit is kept
    } finally {
      await deletePointer("mc-orph-pause");
    }
  }, 60_000);

  it("orphan (pre): an edit committed before the pointer cleanup's transaction opens keeps the pointer", async () => {
    const EDITED = "orphan pre target body AFTER the competing edit";
    await insertMemory([{ id: "mc-orph-pre", agentId: "mc-orph-pre", content: "orphan pre target body before", contentHash: "mc-orph-pre", visibility: "shared", durability: "permanent", createdAt: PAST, archived: true, instanceToken: randomUUID() }]);
    await insertPointer("mc-orph-pre");
    try {
      const { result, released } = await withPausedAction(
        "maintenance-orphan-pre",
        () => maintain("mc-orph-pre"),
        () => updateMemory([{ id: "mc-orph-pre", content: EDITED }]),
      );
      expect(released, "maintenance was not paused and released by this test").toBe("go");
      expect(result.skipped, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
      expect((await readPointers("mc-orph-pre")).length, "the pointer of a changed row was swept").toBe(1);
      expect((await readMemory("mc-orph-pre"))?.content).toBe(EDITED); // assertion: the competing edit is kept
    } finally {
      await deletePointer("mc-orph-pre");
    }
  }, 60_000);
});
