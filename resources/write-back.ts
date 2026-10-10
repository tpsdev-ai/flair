import { isDeepStrictEqual } from "node:util";
import { withOwnedTransaction } from "./request-transaction.js";

/** The narrow surface the helper needs of a Harper table: a primary-key read
 *  that accepts a context, and a full-record write that accepts one. */
export interface WriteBackTable {
  get(id: string, ctx?: any): Promise<any>;
  put(row: any, ctx?: any): Promise<any>;
}

/** A call site's test-only pause: its own `txnPausePoint("<name>")` call. */
export type WriteBackPause = () => Promise<void> | undefined;

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
  expectedRow?: any;
  matches?: (row: any) => boolean;
  matchFields?: string[];
  /** Test-only pause BEFORE this call's owned transaction opens — the
   *  interleaving where the other writer's transaction opens first. The call
   *  site names its point: `() => txnPausePoint("<name>")` (flair#2382). */
  pausePre?: WriteBackPause;
  /** Test-only pause between the in-transaction read/build and the write —
   *  the interleaving where this write's transaction opens first. Named at
   *  the call site, like `pausePre`. */
  pausePoint?: WriteBackPause;
}

/** The fields of `expectedRow` (or of the helper's own first read) it compares
 *  with the row read inside its transaction, besides `matchFields`. */
export const WRITE_BACK_IDENTITY_FIELDS = ["id", "agentId", "instanceToken", "contentHash", "createdAt"] as const;

/** Only the identity fields of `row`: an `expectedRow` for a caller that
 *  selects many rows before writing each back, so it need not hold them whole. */
export function writeBackIdentity(row: Record<string, any>): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  for (const field of WRITE_BACK_IDENTITY_FIELDS) identity[field] = row[field];
  return identity;
}

/** Attempts of a write-back before it gives up on a row that keeps changing. */
export const WRITE_BACK_ATTEMPTS = 3;

export class WriteBackConflictError extends Error {
  readonly id: string;
  constructor(label: string, id: string, attempts: number) {
    super(`${label}: row ${id} changed; write not applied (${attempts} attempts)`);
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
  const selected = "expectedRow" in opts ? opts.expectedRow : await table.get(id, {});
  const basis = selected == null ? selected : { ...selected };
  const sameTarget = (row: any) => row == null ? basis == null : basis != null &&
    String(row.id) === String(basis.id) && row.agentId === basis.agentId &&
    row.instanceToken === basis.instanceToken && row.contentHash === basis.contentHash && row.createdAt === basis.createdAt &&
    (opts.matchFields ?? []).every((field) => isDeepStrictEqual(row[field], basis[field]));
  if (opts.pausePre) {
    const pre = opts.pausePre();
    if (pre) await pre;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await withOwnedTransaction(opts.ctx, async (c) => {
        const row = await table.get(id, c);
        if (opts.matches && !opts.matches(row)) return { skip: true };
        const decision = await plan(row);
        if ("skip" in decision) return decision;
        if (!sameTarget(row)) throw new WriteBackConflictError(opts.label, id, attempt);
        // Test-only: inert unless the fault-injection opt-in is armed.
        if (opts.pausePoint) {
          const pause = opts.pausePoint();
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
