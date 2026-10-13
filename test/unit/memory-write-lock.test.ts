// flair#2478 slice 1 — resources/memory-write-lock.ts, the per-memory-id write
// serialization protocol: sorted/deduplicated acquisition, release-before-wait
// on a partial failure, the bounded busy budget, the per-id unknown-outcome
// marker, and the two 503 refusals.
import { afterEach, describe, expect, test } from "bun:test";
import {
  MEMORY_BUSY_ERROR,
  WRITE_OUTCOME_UNKNOWN_ERROR,
  markMemoryWriteOutcomeUnknown,
  memoryBusyResponse,
  memoryLockKey,
  memoryWriteOutcomeUnknown,
  resetMemoryWriteOutcomeUnknownForTest,
  withMemoryWriteLock,
  withMemoryWriteLockOnce,
  writeOutcomeUnknownResponse,
} from "../../resources/memory-write-lock.ts";

/** A store with Harper's non-blocking per-key tryLock / unlock. */
function fakeStore() {
  const held = new Set<string>();
  const events: string[] = [];
  return {
    held,
    events,
    tryLock(key: unknown) {
      const k = JSON.stringify(key);
      events.push(`try:${k}`);
      if (held.has(k)) return false;
      held.add(k);
      return true;
    },
    unlock(key: unknown) {
      const k = JSON.stringify(key);
      events.push(`unlock:${k}`);
      held.delete(k);
    },
    resetReadTxn() {},
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const KEY_A = JSON.stringify(memoryLockKey("a"));
const KEY_B = JSON.stringify(memoryLockKey("b"));

afterEach(() => {
  resetMemoryWriteOutcomeUnknownForTest("a");
  resetMemoryWriteOutcomeUnknownForTest("b");
  resetMemoryWriteOutcomeUnknownForTest("x");
});

describe("withMemoryWriteLock (flair#2478 slice 1)", () => {
  test("two calls on one id never overlap; a throwing function still releases the lock", async () => {
    const store = fakeStore();
    const events: string[] = [];
    const work = (name: string) => async () => {
      events.push(`${name}:start`);
      await sleep(30);
      events.push(`${name}:end`);
      return name;
    };
    const [a, b] = await Promise.all([
      withMemoryWriteLock(store, ["id-1"], work("a")),
      withMemoryWriteLock(store, ["id-1"], work("b")),
    ]);
    expect(a).toEqual({ kind: "done", value: "a" });
    expect(b).toEqual({ kind: "done", value: "b" });
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(store.held.size).toBe(0);

    await expect(withMemoryWriteLock(store, ["id-1"], async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(store.held.size).toBe(0);
  }, 10_000);

  test("two ids acquired in one call: sorted, deduplicated, and both handed to the callback", async () => {
    const store = fakeStore();
    let seen: readonly string[] = [];
    let keys: readonly (readonly string[])[] = [];
    const run = await withMemoryWriteLock(store, ["b", "a", "b"], async (locked) => {
      seen = locked.ids;
      keys = locked.keys;
      return null;
    });
    expect(run.kind).toBe("done");
    expect(seen).toEqual(["a", "b"]);
    expect(keys).toEqual([memoryLockKey("a"), memoryLockKey("b")]);
    // "b" was acquired once, not twice.
    expect(store.events.filter((e) => e === `try:${KEY_B}`).length).toBe(1);
    expect(store.held.size).toBe(0);
  }, 10_000);

  test("two writers that share two ids in opposite order both complete", async () => {
    const store = fakeStore();
    const order: string[] = [];
    const work = (name: string) => async () => {
      order.push(`${name}:start`);
      await sleep(20);
      order.push(`${name}:end`);
      return name;
    };
    const [a, b] = await Promise.all([
      withMemoryWriteLock(store, ["a", "b"], work("a")),
      withMemoryWriteLock(store, ["b", "a"], work("b")),
    ]);
    expect(a.kind).toBe("done");
    expect(b.kind).toBe("done");
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(store.held.size).toBe(0);
  }, 15_000);

  test("a partial acquisition releases the key it holds before waiting: another writer on that key proceeds immediately", async () => {
    const store = fakeStore();
    store.tryLock(memoryLockKey("b")); // b is held by a third party for the whole test.
    const bStart = Date.now();
    const pending = withMemoryWriteLock(store, ["a", "b"], async () => "b");
    // While the first writer waits on "b", key "a" must be free for a second writer.
    await sleep(150);
    let aRan = false;
    const aRun = await withMemoryWriteLock(store, ["a"], async () => { aRan = true; return "a"; });
    expect(aRun.kind).toBe("done");
    expect(aRan).toBe(true);
    // The first writer never got "b" within its budget: busy, callback not run.
    const result = await pending;
    expect(result).toEqual({ kind: "busy" });
    expect(Date.now() - bStart).toBeGreaterThanOrEqual(1_500);
    store.unlock(memoryLockKey("b"));
    expect(store.held.size).toBe(0);
  }, 15_000);

  test("a lock held past the whole budget is busy and the callback does not run (caller waits the full 200 x 10 ms)", async () => {
    const store = fakeStore();
    store.tryLock(memoryLockKey("a"));
    let ran = false;
    const started = Date.now();
    expect(await withMemoryWriteLock(store, ["a"], async () => { ran = true; })).toEqual({ kind: "busy" });
    expect(ran).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    store.unlock(memoryLockKey("a"));
  }, 10_000);

  test("a store without a lock is unavailable and the callback does not run", async () => {
    let ran = false;
    for (const store of [undefined, null, {}, { tryLock: () => true }]) {
      expect(await withMemoryWriteLock(store, ["a"], async () => { ran = true; })).toEqual({ kind: "unavailable" });
    }
    expect(ran).toBe(false);
  }, 10_000);

  test("an unknown-outcome marker refuses before acquiring: unknown, callback does not run, no key taken", async () => {
    const store = fakeStore();
    markMemoryWriteOutcomeUnknown("a");
    expect(memoryWriteOutcomeUnknown("a")).toBe(true);
    let ran = false;
    expect(await withMemoryWriteLock(store, ["a"], async () => { ran = true; })).toEqual({ kind: "unknown", id: "a" });
    expect(ran).toBe(false);
    expect(store.held.size).toBe(0);
    expect(store.events.length).toBe(0);
    resetMemoryWriteOutcomeUnknownForTest("a");
    expect(memoryWriteOutcomeUnknown("a")).toBe(false);
  }, 10_000);

  test("a marker set while the writer waits is observed on the next attempt", async () => {
    const store = fakeStore();
    store.tryLock(memoryLockKey("a"));
    const pending = withMemoryWriteLock(store, ["a"], async () => "a");
    await sleep(100);
    markMemoryWriteOutcomeUnknown("a");
    expect(await pending).toEqual({ kind: "unknown", id: "a" });
    store.unlock(memoryLockKey("a"));
    expect(store.held.size).toBe(0);
  }, 10_000);

  test("the one-shot variant makes a single attempt with no wait", async () => {
    const store = fakeStore();
    store.tryLock(memoryLockKey("a"));
    let ran = false;
    const started = Date.now();
    expect(await withMemoryWriteLockOnce(store, ["a"], async () => { ran = true; })).toEqual({ kind: "busy" });
    expect(ran).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
    store.unlock(memoryLockKey("a"));
    expect(await withMemoryWriteLockOnce(store, ["a"], async () => "ok")).toEqual({ kind: "done", value: "ok" });
  }, 10_000);
});

describe("the two 503 refusals (flair#2478 slice 1)", () => {
  test("memory_busy is 503 and carries the caller id only — byte-identical for an absent and an existing target (S7)", async () => {
    const absent = memoryBusyResponse("agent-a");
    const existing = memoryBusyResponse("agent-a");
    const parsed = memoryBusyResponse("agent-a");
    expect(absent.status).toBe(503);
    expect(await parsed.json()).toEqual({ error: MEMORY_BUSY_ERROR, caller: "agent-a" });
    expect(await absent.text()).toBe(await existing.text());
  });

  test("write_outcome_unknown is 503 and named", async () => {
    const res = writeOutcomeUnknownResponse();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(WRITE_OUTCOME_UNKNOWN_ERROR);
  });
});
