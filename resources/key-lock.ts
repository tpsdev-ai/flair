/**
 * key-lock.ts — run a function while holding one key of a Harper table's
 * primary-store lock (`tryLock` / `unlock`: per key, shared by the threads of
 * one Harper process; resources/replay-store.ts uses the same primitive).
 * No Harper imports.
 */

export interface KeyLockStore {
  tryLock(key: unknown): boolean;
  unlock(key: unknown): void;
  resetReadTxn?(): void;
}

export type KeyLockOutcome<T> =
  | { kind: "done"; value: T }
  | { kind: "busy" }
  | { kind: "unavailable" };

/**
 * Try the lock up to `attempts` times, `waitMs` apart. Holding it, drop the
 * thread's cached read snapshot (when the store has one) and run `fn`; the
 * lock is released when `fn` settles. "busy": the lock stayed held; "unavailable":
 * the store has no lock. `fn` does not run in either case.
 */
export async function withKeyLock<T>(
  store: unknown,
  key: unknown[],
  fn: () => Promise<T>,
  attempts: number,
  waitMs: number,
): Promise<KeyLockOutcome<T>> {
  const lock = store as Partial<KeyLockStore> | null | undefined;
  if (typeof lock?.tryLock !== "function" || typeof lock?.unlock !== "function") return { kind: "unavailable" };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (lock.tryLock(key)) {
      try {
        lock.resetReadTxn?.();
        return { kind: "done", value: await fn() };
      } finally {
        lock.unlock(key);
      }
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return { kind: "busy" };
}
