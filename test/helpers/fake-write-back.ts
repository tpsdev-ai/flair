import { isDeepStrictEqual } from "node:util";
import type { WriteBackFn, WriteBackPlan, WriteBackOptions } from "../../resources/write-back.js";

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

/**
 * A simulation of writeBackCommittedRow for migration unit tests: no
 * transaction and no staging. Each attempt reads the row, plans, re-reads it,
 * and puts the planned write only when that re-read is unchanged; otherwise it
 * writes nothing and tries again, up to `attempts`.
 */
export function makeFakeWriteBack(opts: FakeWriteBackOptions = {}): WriteBackFn {
  const attempts = opts.attempts ?? 3;
  const fn = async (table: { get(id: string): Promise<any>; put(row: any): Promise<any> }, id: string, plan: (row: any) => WriteBackPlan | Promise<WriteBackPlan>, options: WriteBackOptions): Promise<WriteBackPlan> => {
    const selected = "expectedRow" in options ? options.expectedRow : await table.get(id);
    const basis = selected == null ? selected : { ...selected };
    const sameTarget = (row: any) => row == null ? basis == null : basis != null &&
      String(row.id) === String(basis.id) && row.agentId === basis.agentId &&
      row.instanceToken === basis.instanceToken && row.contentHash === basis.contentHash && row.createdAt === basis.createdAt &&
      (options.matchFields ?? []).every((field) => isDeepStrictEqual(row[field], basis[field]));
    for (let attempt = 1; ; attempt++) {
      const row = await table.get(id);
      if (options.matches && !options.matches(row)) return { skip: true };
      const decision = await plan(row);
      if ("skip" in decision) return decision;
      if (!sameTarget(row)) throw new Error(`write-back: target ${id} changed`);
      if (opts.conflict) await opts.conflict(attempt);
      const committed = await table.get(id);
      if (!isDeepStrictEqual(committed, row)) {
        if (attempt >= attempts) throw new Error(`write-back: row ${id} changed during each of ${attempts} attempts; write not applied`);
        continue;
      }
      await table.put(decision.write);
      return decision;
    }
  };
  return fn as unknown as WriteBackFn;
}
