// flair#2478 slice 1 — resources/memory-write-lock.ts, the per-memory-id write
// serialization protocol: sorted/deduplicated acquisition, release-before-wait
// on a partial failure, the bounded busy budget, the per-id unknown-outcome
// marker, and three lock refusals plus the provider timeout.
import { afterEach, describe, expect, test } from "bun:test";
import {
  MEMORY_BUSY_ERROR,
  MEMORY_LOCK_UNAVAILABLE_ERROR,
  MEMORY_LOCKED_PROVIDER_TIMEOUT_MS,
  MEMORY_LOCK_HOLD_WATCHDOG_MS,
  MEMORY_PROVIDER_TIMEOUT_ERROR,
  MEMORY_PROVIDER_TIMEOUT_ENV,
  MEMORY_LOCK_HOLD_WATCHDOG_ENV,
  WRITE_OUTCOME_UNKNOWN_ERROR,
  MemoryProviderTimeout,
  boundLockedProviderCall,
  markMemoryWriteOutcomeUnknown,
  memoryBusyResponse,
  memoryLockKey,
  memoryLockUnavailableResponse,
  memoryLockHoldWatchdogMs,
  memoryLockedProviderTimeoutMs,
  memoryProviderTimeoutResponse,
  memoryWriteLockTokenIds,
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
  test("an empty key set is refused without running the callback", async () => {
    for (const acquire of [withMemoryWriteLock, withMemoryWriteLockOnce]) {
      const store = fakeStore();
      let ran = false;
      const result = await acquire(store, [], async () => { ran = true; });
      expect({ result, ran, events: store.events }).toEqual({
        result: { kind: "unavailable" }, ran: false, events: [],
      });
    }
  });

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
    const run = await withMemoryWriteLock(store, ["b", "a", "b"], async (held) => {
      seen = memoryWriteLockTokenIds(held);
      return null;
    });
    expect(run.kind).toBe("done");
    expect(seen).toEqual(["a", "b"]);
    expect(store.events.filter((e) => e.startsWith("try:"))).toEqual([`try:${KEY_A}`, `try:${KEY_B}`]);
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
    // While the first writer waits on "b", key "a" must be free for a second
    // writer. A ONE-SHOT attempt (no wait), so a first writer that held "a"
    // through its wait would make it busy instead of letting it run later.
    await sleep(150);
    expect(store.held.has(JSON.stringify(memoryLockKey("a"))), "the waiting writer holds \"a\"").toBe(false);
    let aRan = false;
    const aRun = await withMemoryWriteLockOnce(store, ["a"], async () => { aRan = true; return "a"; });
    expect(aRun.kind).toBe("done");
    expect(aRan).toBe(true);
    // The first writer never got "b" within its budget: busy, callback not run.
    const result = await pending;
    expect(result).toEqual({ kind: "busy" });
    expect(Date.now() - bStart).toBeGreaterThanOrEqual(1_500);
    store.unlock(memoryLockKey("b"));
    expect(store.held.size).toBe(0);
  }, 15_000);

  test("a lock held past the whole budget is busy and the callback does not run (200 attempts, with a 10 ms wait between attempts)", async () => {
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

describe("the bounded provider call (flair#2478)", () => {
  const GATE = "FLAIR_ENABLE_TEST_FAULT_INJECTION";

  test("the bounds default to the named constants; the override applies only under the fault-injection gate", () => {
    expect(memoryLockedProviderTimeoutMs({})).toBe(MEMORY_LOCKED_PROVIDER_TIMEOUT_MS);
    expect(memoryLockHoldWatchdogMs({})).toBe(MEMORY_LOCK_HOLD_WATCHDOG_MS);
    expect(memoryLockedProviderTimeoutMs({ [MEMORY_PROVIDER_TIMEOUT_ENV]: "5" })).toBe(MEMORY_LOCKED_PROVIDER_TIMEOUT_MS);
    expect(memoryLockHoldWatchdogMs({ [MEMORY_LOCK_HOLD_WATCHDOG_ENV]: "5" })).toBe(MEMORY_LOCK_HOLD_WATCHDOG_MS);
    expect(memoryLockedProviderTimeoutMs({ [GATE]: "1", [MEMORY_PROVIDER_TIMEOUT_ENV]: "5" })).toBe(5);
    expect(memoryLockHoldWatchdogMs({ [GATE]: "1", [MEMORY_LOCK_HOLD_WATCHDOG_ENV]: "7" })).toBe(7);
  });

  test("boundLockedProviderCall passes a timely value through, and rejects a hung call at the bound", async () => {
    const env = { [GATE]: "1", [MEMORY_PROVIDER_TIMEOUT_ENV]: "40" };
    expect(await boundLockedProviderCall(async () => "vector", env)).toBe("vector");

    const started = Date.now();
    const err = await boundLockedProviderCall(() => new Promise<never>(() => {}), env).catch((e) => e);
    expect(err).toBeInstanceOf(MemoryProviderTimeout);
    expect((err as MemoryProviderTimeout).ms).toBe(40);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);

  test.each(["resolve", "reject"])("a blocking provider that settles late (%s) is refused and releases the lock without writing", async (settlement) => {
    const env = { [GATE]: "1", [MEMORY_PROVIDER_TIMEOUT_ENV]: "10" };
    const store = fakeStore();
    let written: number[] | undefined;
    const err = await withMemoryWriteLock(store, ["a"], async () => {
      written = await boundLockedProviderCall(async () => {
        const started = performance.now();
        while (performance.now() - started < 40) {}
        if (settlement === "reject") throw new Error("late provider failure");
        return [1, 0, 0];
      }, env);
    }).catch((error) => error);
    expect(err).toBeInstanceOf(MemoryProviderTimeout);
    expect(err.ms).toBe(10);
    expect(memoryProviderTimeoutResponse().status).toBe(503);
    expect(written).toBeUndefined();
    expect(store.held.size).toBe(0);
    expect(await withMemoryWriteLockOnce(store, ["a"], async () => "next")).toEqual({ kind: "done", value: "next" });
  });

  test("a provider failure within the bound retains its error", async () => {
    const error = new Error("provider failure");
    const result = await boundLockedProviderCall(async () => { throw error; }).catch((err) => err);
    expect(result).toBe(error);
  });

  test("memory_provider_timeout is 503, named, and says nothing was written", async () => {
    const res = memoryProviderTimeoutResponse();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe(MEMORY_PROVIDER_TIMEOUT_ERROR);
    expect(body.message).toContain("nothing was written");
  });
});

describe("the observe-only hold watchdog (flair#2478)", () => {
  const GATE = "FLAIR_ENABLE_TEST_FAULT_INJECTION";

  async function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(env)) {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }
    try {
      return await body();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  async function withWarnings<T>(body: (warnings: string[]) => Promise<T>): Promise<T> {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      return await body(warnings);
    } finally {
      console.warn = realWarn;
    }
  }

  test("a hold past the threshold logs the lock key and the phase, and the timer never releases the lock", async () => {
    await withEnv({ [GATE]: "1", [MEMORY_LOCK_HOLD_WATCHDOG_ENV]: "25" }, async () => {
      const store = fakeStore();
      await withWarnings(async (warnings) => {
        const pending = withMemoryWriteLock(store, ["a"], async () => {
          await sleep(300);
          return "a";
        }, { phase: "unit-hold-phase" });
        await sleep(150);
        // The watchdog logged with the key and the phase...
        expect(warnings.some((w) => w.includes(KEY_A) && w.includes("unit-hold-phase"))).toBe(true);
        // ...and did NOT release the key: a one-shot same-id writer is still busy.
        expect(await withMemoryWriteLockOnce(store, ["a"], async () => "second")).toEqual({ kind: "busy" });
        expect(await pending).toEqual({ kind: "done", value: "a" });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/elapsed=\d+ms/);
        expect(store.held.size).toBe(0);
      });
    });
  }, 10_000);

  test("an event-loop-blocking callback logs once at settlement", async () => {
    await withEnv({ [GATE]: "1", [MEMORY_LOCK_HOLD_WATCHDOG_ENV]: "10" }, async () => {
      const store = fakeStore();
      await withWarnings(async (warnings) => {
        const result = await withMemoryWriteLock(store, ["a"], async () => {
          const started = performance.now();
          while (performance.now() - started < 40) {}
          expect(warnings).toEqual([]);
          expect(store.held.has(KEY_A)).toBe(true);
          return "a";
        }, { phase: "blocking-callback" });
        expect(result).toEqual({ kind: "done", value: "a" });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(`keys=[${KEY_A}] phase=blocking-callback`);
        expect(Number(warnings[0].match(/elapsed=(\d+)ms/)?.[1])).toBeGreaterThan(10);
        expect(store.held.size).toBe(0);
        await sleep(30);
        expect(warnings).toHaveLength(1);
      });
    });
  }, 10_000);

  test("a hold inside the threshold logs nothing", async () => {
    await withEnv({ [GATE]: "1", [MEMORY_LOCK_HOLD_WATCHDOG_ENV]: "5000" }, async () => {
      const store = fakeStore();
      await withWarnings(async (warnings) => {
        expect(await withMemoryWriteLock(store, ["a"], async () => { await sleep(30); return "a"; }, { phase: "quiet" })).toEqual({ kind: "done", value: "a" });
        expect(warnings).toEqual([]);
      });
    });
  }, 10_000);
});

describe("the busy, unknown and no-lock 503 refusals (flair#2478 slice 1)", () => {
  // The helper takes the caller id and nothing about the target row. That the
  // RESOURCE answers the same bytes for an existing and an absent target is
  // asserted through real Harper in test/integration/memory-write-lock-2478.test.ts.
  test("memory_busy is 503 and its body is the error and the caller id only", async () => {
    const res = memoryBusyResponse("agent-a");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: MEMORY_BUSY_ERROR, caller: "agent-a" });
  });

  test("write_outcome_unknown is 503, named, and tells the caller to read the row before writing again", async () => {
    const res = writeOutcomeUnknownResponse();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe(WRITE_OUTCOME_UNKNOWN_ERROR);
    expect(body.message).toContain("Read the affected row before writing again");
  });

  test("memory_lock_unavailable is 503, named, and says nothing was written", async () => {
    const res = memoryLockUnavailableResponse();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe(MEMORY_LOCK_UNAVAILABLE_ERROR);
    expect(body.message).toContain("nothing was written");
  });
});
