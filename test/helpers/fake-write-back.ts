/**
 * fake-write-back.ts — an in-memory stand-in for writeBackCommittedRow for the
 * migration unit tests (flair#2354).
 *
 * The real helper (resources/write-back.ts) reads the row inside a transaction
 * it owns, builds the write from THAT read, re-reads the COMMITTED row (an
 * empty context, never the transaction's snapshot or its staged write), and on
 * a change aborts the transaction — discarding the staged write — and retries
 * from the committed row, up to a bounded number of attempts, then refuses.
 *
 * This fake models that contract over a fake table's get/put, so a unit test
 * can exercise the abort-and-retry path without a real Harper transaction. It
 * reads the committed row, hands it to `plan`; when the plan returns a write it
 * re-reads the committed row and, if a competing write landed in between
 * (the `conflict` hook commits one), it aborts (performs no put) and retries
 * from the committed row. A row that keeps changing each attempt is a named
 * refusal, like the real helper's WriteBackConflictError.
 */
import { isDeepStrictEqual } from "node:util";
import type { WriteBackFn, WriteBackPlan } from "../../resources/write-back.js";

export interface FakeWriteBackOptions {
  /** Bounded attempts before the named refusal. Default 3. */
  attempts?: number;
  /**
   * Called after `plan` returns a write and before the committed re-read, on
   * the given 1-based attempt; the test mutates the committed store here to
   * model a competing writer committing after this write-back's read.
   */
  conflict?: (attempt: number) => void | Promise<void>;
}

export function makeFakeWriteBack(opts: FakeWriteBackOptions = {}): WriteBackFn {
  const attempts = opts.attempts ?? 3;
  const fn = async (table: { get(id: string): Promise<any>; put(row: any): Promise<any> }, id: string, plan: (row: any) => WriteBackPlan | Promise<WriteBackPlan>): Promise<WriteBackPlan> => {
    for (let attempt = 1; ; attempt++) {
      const row = await table.get(id);
      const decision = await plan(row);
      if ("skip" in decision) return decision;
      if (opts.conflict) await opts.conflict(attempt);
      const committed = await table.get(id);
      if (committed !== null && !isDeepStrictEqual(committed, row)) {
        if (attempt >= attempts) throw new Error(`write-back: row ${id} changed during each of ${attempts} attempts; write not applied`);
        continue;
      }
      await table.put(decision.write);
      return decision;
    }
  };
  return fn as unknown as WriteBackFn;
}
