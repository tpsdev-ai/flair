/**
 * memory-purge-unconfirmed-2290.test.ts — POST /MemoryPurge when Harper skips
 * a queued delete at commit.
 *
 * Runs against a composed copy of the built component that adds a test-only
 * module (test/helpers/host-pointer-failing-component.ts,
 * CONCURRENT_WRITE_MODULE_SRC). For a row whose Memory id carries a marker, the
 * module commits a newer write of a row in a separate transaction right after
 * the purge stages its own write, so the purge's staged delete loses to that
 * write at commit:
 *   skip-memory-delete   the Memory row (after the purge stages its delete);
 *   skip-history-delete  the deletion-history record (after the purge stages
 *                        its cleanup delete);
 *   skip-pointer-delete  the pointer row (after the purge stages its delete).
 * The call must fail by name and leave each row as the committed store has it:
 * a row still stored keeps its pointer row, and a record the purge cannot
 * confirm removed is named in the reply.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import {
  componentWithConcurrentWrites,
  CONCURRENT_WRITE_MODULE_REL,
  CONCURRENT_WRITE_MODULE_SRC,
  type FailingComponent,
} from "../helpers/host-pointer-failing-component";

let harper: HarperInstance;
let component: FailingComponent;

const adminBasic = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;
const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-bbbbbbbb" };

async function adminOp(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminBasic() },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

const rows = (table: string, attribute: string, value: string) =>
  adminOp({ operation: "search_by_value", database: "flair", table, search_attribute: attribute, search_value: value, get_attributes: ["*"] });

/** Seed a permanent Memory row and, when asked, its pointer row. */
async function seed(id: string, withPointer: boolean): Promise<void> {
  const instanceToken = randomUUID();
  await adminOp({
    operation: "insert", database: "flair", table: "Memory",
    records: [{ id, agentId: "agent-a", content: "original", durability: "permanent", createdAt: new Date().toISOString(), archived: false, instanceToken }],
  });
  if (!withPointer) return;
  await adminOp({
    operation: "insert", database: "flair", table: "MemoryHostSource",
    records: [{ memoryId: id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: instanceToken, receivedAt: new Date().toISOString() }],
  });
  expect((await rows("MemoryHostSource", "memoryId", id)).length).toBe(1); // the pointer row is seeded
}

async function purge(ids: string[]): Promise<{ status: number; body: any }> {
  const res = await fetch(`${harper.httpURL}/MemoryPurge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminBasic() },
    body: JSON.stringify({ ids }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep the text for the assertion message */ }
  return { status: res.status, body };
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  component = componentWithConcurrentWrites();
  harper = await startHarper({ cwd: component.dir });
  for (const url of [harper.httpURL, harper.opsURL]) {
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(new URL(url).port);
  }
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (component) component.cleanup();
});

describe("POST /MemoryPurge", () => {
  it("healthy purge confirms pointer cleanup after a contextless read pins the request snapshot", async () => {
    const id = `purge-pinned-pointer-snapshot-${Date.now()}`;
    await seed(id, true);
    const { status, body } = await purge([id]);
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    expect(body).toEqual({ removed: 1, removedIds: [id] });
    expect(await rows("Memory", "id", id)).toEqual([]);
    expect(await rows("MemoryHostSource", "memoryId", id)).toEqual([]);
    expect((await rows("MemoryDeletionHistory", "memoryId", id)).length).toBe(1);
  }, 60_000);

  it("ctrl: with no concurrent write, the row and its pointer row are removed and its history record is written", async () => {
    expect(readFileSync(join(component.dir, CONCURRENT_WRITE_MODULE_REL), "utf8")).toBe(CONCURRENT_WRITE_MODULE_SRC); // the composed copy carries the test module
    const id = `purge-plain-${Date.now()}`;
    await seed(id, true);
    const { status, body } = await purge([id]);
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    expect(body).toEqual({ removed: 1, removedIds: [id] });
    expect(await rows("Memory", "id", id)).toEqual([]);
    expect(await rows("MemoryHostSource", "memoryId", id)).toEqual([]);
    expect((await rows("MemoryDeletionHistory", "memoryId", id)).length).toBe(1);
  }, 60_000);

  it("a row delete that loses to a newer write fails the call by name; the row keeps its pointer row and no history record", async () => {
    const id = `purge-skip-memory-delete-${Date.now()}`;
    await seed(id, true);
    const pointerBefore = JSON.stringify(await rows("MemoryHostSource", "memoryId", id));

    const { status, body } = await purge([id]);
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(409);
    expect(body).toMatchObject({ error: "memory_purge_unconfirmed", ids: [id], removedIds: [] });

    const stored = await rows("Memory", "id", id);
    expect(stored.map((r: any) => r.content)).toEqual(["rewritten by a separate transaction"]); // the newer write won
    expect(JSON.stringify(await rows("MemoryHostSource", "memoryId", id))).toBe(pointerBefore); // the stored row's pointer row is unchanged
    expect(await rows("MemoryDeletionHistory", "memoryId", id)).toEqual([]);
  }, 60_000);

  it("a history-record delete that loses to a newer write fails the call by name and names the record", async () => {
    const id = `purge-skip-memory-delete-skip-history-delete-${Date.now()}`;
    await seed(id, false);

    const { status, body } = await purge([id]);
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(500);
    expect(body).toMatchObject({ error: "memory_purge_history_cleanup_unconfirmed", ids: [id], stillStoredIds: [id], removedIds: [] });

    expect((await rows("Memory", "id", id)).map((r: any) => r.content)).toEqual(["rewritten by a separate transaction"]); // the row is still stored
    const history = await rows("MemoryDeletionHistory", "memoryId", id);
    expect(history.length).toBe(1); // the record the cleanup could not remove
    expect(body.historyIds).toEqual([history[0].id]); // the reply names it
    expect(body.message).toBe("these rows are still stored after the commit; their deletion-history records were not deleted and are still stored");
  }, 60_000);

  it("a pointer-row delete that loses to a newer write fails the call by name after the row is removed", async () => {
    const id = `purge-skip-pointer-delete-${Date.now()}`;
    await seed(id, true);

    const { status, body } = await purge([id]);
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(500);
    expect(body).toMatchObject({ error: "memory_purge_pointer_cleanup_failed", ids: [id], removedIds: [id] });
    expect(body.message).toBe("rows in removedIds still have a pointer row after its delete");

    expect(await rows("Memory", "id", id)).toEqual([]); // the row is removed
    expect((await rows("MemoryHostSource", "memoryId", id)).length).toBe(1); // its pointer row is left, and reported
    expect((await rows("MemoryDeletionHistory", "memoryId", id)).length).toBe(1); // the removal is recorded
  }, 60_000);

  it("a mixed batch with a skipped pointer delete reports removedIds and stillStoredIds", async () => {
    const storedId = `purge-skip-memory-delete-${Date.now()}`;
    const removedId = `purge-skip-pointer-delete-${Date.now()}`;
    await seed(storedId, true);
    await seed(removedId, true);

    const { status, body } = await purge([storedId, removedId]);
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(500);
    expect(body).toMatchObject({
      error: "memory_purge_pointer_cleanup_failed", ids: [removedId],
      stillStoredIds: [storedId], removedIds: [removedId],
      message: "rows in removedIds still have a pointer row after its delete",
    });
    expect((await rows("Memory", "id", storedId)).length).toBe(1);
    expect(await rows("Memory", "id", removedId)).toEqual([]);
    expect((await rows("MemoryHostSource", "memoryId", storedId)).length).toBe(1);
    expect((await rows("MemoryHostSource", "memoryId", removedId)).length).toBe(1);
    expect(await rows("MemoryDeletionHistory", "memoryId", storedId)).toEqual([]);
    expect((await rows("MemoryDeletionHistory", "memoryId", removedId)).length).toBe(1);
  }, 60_000);

  it("pointer confirmation failure returns the named 500 after the row deletion commits", async () => {
    const id = `purge-fail-pointer-confirmation-${Date.now()}`;
    await seed(id, true);
    const { status, body } = await purge([id]);
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(500);
    expect(body).toMatchObject({
      error: "memory_purge_pointer_cleanup_failed", removedIds: [id], stillStoredIds: [],
      message: "could not confirm pointer-row deletion for rows in removedIds (test component: forced pointer confirmation failure)",
    });
    expect(await rows("Memory", "id", id)).toEqual([]);
    expect(await rows("MemoryHostSource", "memoryId", id)).toEqual([]);
    expect((await rows("MemoryDeletionHistory", "memoryId", id)).length).toBe(1);
  }, 60_000);
});
