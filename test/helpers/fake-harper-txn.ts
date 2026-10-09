/**
 * fake-harper-txn.ts — for isolated unit tests that mock `harper` and drive a
 * write-back path (flair#2354).
 *
 * Harper assigns `transaction` onto the global at load, and the write-back
 * helper (resources/write-back.ts, via request-transaction.ts) reaches it there.
 * A unit test that mocks `harper` with an in-memory table must therefore model
 * it, or the helper refuses (A7: no unwrapped write).
 *
 * This installs a simulation of Harper's transaction: while a transaction
 * callback is running, every `stage()` call is staged, whatever context the
 * write carries (the simulation does not check it); get() still returns the
 * committed store, so a staged write is invisible to the committed re-read;
 * the staged writes land when the callback resolves and are discarded if it
 * throws. A test's fake table's put() calls `stage()` and, when it returns
 * true, leaves the commit to this simulation.
 */
export function installFakeHarperTransaction(commit: (id: string, row: any) => void) {
  const saved = (globalThis as { transaction?: unknown }).transaction;
  let staged: Map<string, any> | null = null;
  (globalThis as { transaction?: unknown }).transaction = async (_ctx: unknown, cb: (ctx: any) => any) => {
    const map = new Map<string, any>();
    staged = map;
    try {
      const out = await cb({});
      for (const [id, row] of map) commit(id, row);
      return out;
    } finally {
      staged = null;
    }
  };
  return {
    /** Stage a write while a transaction callback is running; outside one it
     *  returns false and the caller commits the write itself. */
    stage(id: string, row: any): boolean {
      if (!staged) return false;
      staged.set(id, row);
      return true;
    },
    restore(): void {
      (globalThis as { transaction?: unknown }).transaction = saved;
    },
  };
}
