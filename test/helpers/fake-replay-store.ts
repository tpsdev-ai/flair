/**
 * fake-replay-store.ts — an in-memory stand-in for the `flair.ReplayNonce`
 * table, for unit tests that mock `harper` (flair#2061).
 *
 * resources/replay-store.ts records every signed request's nonce through the
 * table's primary store (tryLock / getEntry / unlock) and an awaited `put`
 * inside Harper's `transaction()`. A harper mock without the table makes every
 * signed request refuse (fail closed), so a unit test that verifies a real
 * signature must supply one. This fake keeps the same contract: a per-key lock
 * that is not re-entrant, a read that sees committed rows only, and a `put`
 * that yields before the row lands (so an unlocked read-then-write can race).
 *
 * Test-only. Nothing under resources/ imports it.
 */

export interface FakeReplayNonceTable {
  rows: Map<string, { id: string; seenAt: number }>;
  locks: Set<string>;
  calls: { tryLock: number; unlock: number; getEntry: number; put: number };
  /** Every lock key tryLock was called with, as given. */
  lockKeys: unknown[];
  expirationMS: number;
  primaryStore: {
    tryLock(key: unknown): boolean;
    unlock(key: unknown): boolean;
    getEntry(id: string): { value: unknown } | undefined;
  };
  put(record: { id: string; seenAt: number }): Promise<void>;
  /** Make the next writes / reads / locks throw (a store error). */
  fail: { put?: boolean; getEntry?: boolean; tryLock?: boolean };
}

export function createFakeReplayNonceTable(): FakeReplayNonceTable {
  const rows = new Map<string, { id: string; seenAt: number }>();
  const locks = new Set<string>();
  const calls = { tryLock: 0, unlock: 0, getEntry: 0, put: 0 };
  const lockKeys: unknown[] = [];
  const fail: FakeReplayNonceTable["fail"] = {};
  const lk = (k: unknown) => JSON.stringify(k);
  return {
    rows,
    locks,
    calls,
    lockKeys,
    fail,
    expirationMS: 120_000,
    primaryStore: {
      tryLock(key: unknown): boolean {
        calls.tryLock++;
        lockKeys.push(key);
        if (fail.tryLock) throw new Error("fake store: lock failure");
        const s = lk(key);
        if (locks.has(s)) return false;
        locks.add(s);
        return true;
      },
      unlock(key: unknown): boolean {
        calls.unlock++;
        return locks.delete(lk(key));
      },
      getEntry(id: string) {
        calls.getEntry++;
        if (fail.getEntry) throw new Error("fake store: read failure");
        const row = rows.get(id);
        return row ? { value: row } : undefined;
      },
    },
    async put(record: { id: string; seenAt: number }): Promise<void> {
      calls.put++;
      await new Promise((r) => setTimeout(r, 1));
      if (fail.put) throw new Error("fake store: write failure");
      rows.set(record.id, { ...record });
    },
  };
}

/** Harper's `transaction(ctx, cb)` shape: run `cb`, resolve with its result. */
export const fakeHarperTransaction = async (_ctx: unknown, cb: () => unknown): Promise<unknown> => cb();

/**
 * Harper assigns `transaction` onto the global at load, and replay-store.ts
 * reads it from there. Installs the fake when no function is present and
 * returns a restore callback.
 */
export function ensureGlobalHarperTransaction(): () => void {
  const g = globalThis as any;
  const saved = g.transaction;
  if (typeof saved !== "function") g.transaction = fakeHarperTransaction;
  return () => {
    g.transaction = saved;
  };
}
