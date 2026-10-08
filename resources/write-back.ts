/**
 * write-back.ts — one shared read-modify-write for FULL-ROW Memory write-backs
 * (flair#2354, slice 1 of the #2333 audit).
 *
 * A "full-row write-back" reads a row and writes the whole row back (Harper's
 * `put()` replaces the record). Harper 5.2.8 has no compare-and-set on a table
 * write: a transaction does not fail when a row it read is changed by another
 * write before it commits — Harper applies both writes, ordered by transaction
 * timestamp. So a write-back built from a read can silently revert a concurrent
 * change while reporting success.
 *
 * {@link writeBackCommittedRow} removes that window the way #2310's close and
 * embedding-stamp paths do, generalized to one helper:
 *
 *   1. read the row INSIDE a transaction this call OWNS (withOwnedTransaction);
 *   2. build the write from THAT read (the `plan` callback — never from a copy
 *      read before the transaction opened);
 *   3. write through the caller's static table handle with that context;
 *   4. re-read the COMMITTED row in an explicit empty context (`{}`: Harper's
 *      latest committed state, never this transaction's snapshot or its staged
 *      write) before the transaction commits;
 *   5. on a change, abort the transaction (the staged write is discarded) and
 *      retry from the committed row, up to a bounded number of attempts; a row
 *      that keeps changing each attempt is a named refusal, never a success.
 *
 * A `plan` may also return `{ skip: true }` — the row no longer needs the write
 * (an idempotent guard, or a decision that does not apply to the committed
 * row). A skip performs no write and no retry.
 *
 * A change committed after the final re-read and before the commit is not seen
 * by it; Harper orders the two writes by timestamp (the #2310 residual gap).
 */
import { isDeepStrictEqual } from "node:util";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint, type TxnPausePoint } from "./txn-pause-point.js";

/** The narrow surface the helper needs of a Harper table: a primary-key read
 *  that accepts a context, and a full-record write that accepts one. */
export interface WriteBackTable {
  get(id: string, ctx?: any): Promise<any>;
  put(row: any, ctx?: any): Promise<any>;
}

/** What the `plan` callback decides for the row it was handed. */
export type WriteBackPlan =
  | { write: Record<string, unknown> }
  | { skip: true };

export interface WriteBackOptions {
  /** The request context, if any. Its transaction is detached for the owned
   *  one (withOwnedTransaction): one item's write-back commits on its own. */
  ctx?: any;
  /** Name for the refusal thrown when the row keeps changing. */
  label: string;
  /** Bounded attempts before the named refusal. Default {@link WRITE_BACK_ATTEMPTS}. */
  attempts?: number;
  /** Test-only pause BEFORE this call's owned transaction opens — the
   *  interleaving where the other writer's transaction opens first. */
  pausePre?: TxnPausePoint;
  /** Test-only pause between the in-transaction read/build and the write —
   *  the interleaving where this write's transaction opens first. */
  pausePoint?: TxnPausePoint;
}

/** Attempts of a write-back before it gives up on a row that keeps changing. */
export const WRITE_BACK_ATTEMPTS = 3;

/** Thrown when a row changed during every attempt: the write-back refused. */
export class WriteBackConflictError extends Error {
  readonly id: string;
  constructor(label: string, id: string, attempts: number) {
    super(`${label}: row ${id} changed during each of ${attempts} attempts; write not applied`);
    this.name = "WriteBackConflictError";
    this.id = id;
  }
}

/** Aborts the write-back's owned transaction: the row changed after the
 *  transaction read it. Never escapes the helper. */
class CommittedRowChanged extends Error {}

/** The shared helper's own signature — so a migration can inject a plain fake
 *  in unit tests (embedding-stamp's DI style) while production uses the real,
 *  transaction-owning one. */
export type WriteBackFn = typeof writeBackCommittedRow;

export async function writeBackCommittedRow(
  table: WriteBackTable,
  id: string,
  plan: (row: any) => WriteBackPlan | Promise<WriteBackPlan>,
  opts: WriteBackOptions,
): Promise<WriteBackPlan> {
  const attempts = opts.attempts ?? WRITE_BACK_ATTEMPTS;
  if (opts.pausePre) {
    const pre = txnPausePoint(opts.pausePre);
    if (pre) await pre;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await withOwnedTransaction(opts.ctx, async (c) => {
        const row = await table.get(id, c);
        const decision = await plan(row);
        if ("skip" in decision) return decision;
        // Test-only: inert unless the fault-injection opt-in is armed.
        if (opts.pausePoint) {
          const pause = txnPausePoint(opts.pausePoint);
          if (pause) await pause;
        }
        await table.put(decision.write, c);
        // Confirmation read: the committed row in an EXPLICIT fresh context
        // (never contextless — a contextless read joins this request's
        // transaction and sees its old snapshot or its staged write).
        const committed = await table.get(id, {});
        if (!isDeepStrictEqual(committed, row)) throw new CommittedRowChanged();
        return decision;
      });
    } catch (err) {
      if (!(err instanceof CommittedRowChanged)) throw err;
      if (attempt >= attempts) throw new WriteBackConflictError(opts.label, id, attempts);
    }
  }
}
