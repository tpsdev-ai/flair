// flair#2141 S1 — resources/key-lock.ts, the per-key lock OrgSkillAssignment's
// put/patch/delete hold while they read the stored row and commit.
import { describe, expect, test } from "bun:test";
import { withKeyLock } from "../../resources/key-lock.ts";

/** A store with Harper's non-blocking per-key tryLock / unlock. */
function fakeStore() {
  const held = new Set<string>();
  return {
    held,
    tryLock(key: unknown) {
      const k = JSON.stringify(key);
      if (held.has(k)) return false;
      held.add(k);
      return true;
    },
    unlock(key: unknown) { held.delete(JSON.stringify(key)); },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withKeyLock (flair#2141 S1)", () => {
  test("two calls on the same key never overlap: the second runs after the first settles", async () => {
    const store = fakeStore();
    const events: string[] = [];
    const work = (name: string) => async () => {
      events.push(`${name}:start`);
      await sleep(30);
      events.push(`${name}:end`);
      return name;
    };
    const [a, b] = await Promise.all([
      withKeyLock(store, ["ns", "id-1"], work("a"), 50, 5),
      withKeyLock(store, ["ns", "id-1"], work("b"), 50, 5),
    ]);
    expect(a).toEqual({ kind: "done", value: "a" });
    expect(b).toEqual({ kind: "done", value: "b" });
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(store.held.size).toBe(0);
  }, 10_000);

  test("calls on different keys do not wait for each other", async () => {
    const store = fakeStore();
    const events: string[] = [];
    const work = (name: string) => async () => {
      events.push(`${name}:start`);
      await sleep(30);
      events.push(`${name}:end`);
    };
    await Promise.all([
      withKeyLock(store, ["ns", "id-1"], work("a"), 50, 5),
      withKeyLock(store, ["ns", "id-2"], work("b"), 50, 5),
    ]);
    expect(events.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
  }, 10_000);

  test("a lock held past the attempts is busy and the function does not run; a throwing function still releases the lock", async () => {
    const store = fakeStore();
    store.tryLock(["ns", "id-1"]);
    let ran = false;
    expect(await withKeyLock(store, ["ns", "id-1"], async () => { ran = true; }, 3, 1)).toEqual({ kind: "busy" });
    expect(ran).toBe(false);
    store.unlock(["ns", "id-1"]);

    await expect(withKeyLock(store, ["ns", "id-1"], async () => { throw new Error("boom"); }, 3, 1)).rejects.toThrow("boom");
    expect(store.held.size).toBe(0);
  }, 10_000);

  test("a store without a lock is unavailable and the function does not run", async () => {
    let ran = false;
    for (const store of [undefined, null, {}, { tryLock: () => true }]) {
      expect(await withKeyLock(store, ["ns", "id-1"], async () => { ran = true; }, 3, 1)).toEqual({ kind: "unavailable" });
    }
    expect(ran).toBe(false);
  }, 10_000);
});
