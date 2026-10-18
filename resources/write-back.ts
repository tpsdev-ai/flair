import { isDeepStrictEqual } from "node:util";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { withOwnedTransaction } from "./request-transaction.js";

/** The narrow surface the helper needs of a Harper table: a primary-key read
 *  that accepts a context, and a full-record write that accepts one. An `update`
 *  plan needs the table's incremental `update` too. */
export interface WriteBackTable {
  get(id: string, ctx?: any): Promise<any>;
  put(row: any, ctx?: any): Promise<any>;
  update?(id: string, patch: Record<string, unknown>, ctx?: any): Promise<any>;
}

/** A call site's test-only pause: its own `txnPausePoint("<name>")` call. */
export type WriteBackPause = () => Promise<void> | undefined;

/** What the `plan` callback decides for the row it was handed.
 *
 * A `write` plan must supply a complete row for Harper `put`.
 * `update` writes only the named fields through Harper `update`. */
export type WriteBackPlan =
  | { write: Record<string, unknown> }
  | { update: Record<string, unknown> }
  // A plan may name WHY it skipped, so a caller that maps a skip to an operator-
  // visible reason (FederationSync's skip log) can tell two skip causes apart
  // instead of labeling every skip with one hardcoded name (flair#2266). The
  // field is optional so the many plans that return a bare `{ skip: true }` are
  // unchanged; a caller reading it falls back to its own default.
  | { skip: true; reason?: string };

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
  /**
   * Before a planned write, require the in-transaction row to equal the selected
   * basis (`expectedRow` when supplied) as a WHOLE row, not only in the fields
   * {@link sameStoredRow} compares. Soul, Agent and Relationship have no
   * instanceToken or contentHash; Message has contentHash but no instanceToken
   * or agentId. Message's hash excludes mutable lifecycle fields, so an
   * identity check alone misses their changes (flair#2450).
   * The comparison spreads `row` to match the plain `{ ...selected }` basis.
   */
  wholeRow?: boolean;
  /** Test-only pause BEFORE this call's owned transaction opens — the
   *  interleaving where the other writer's transaction opens first. The call
   *  site names its point: `() => txnPausePoint("<name>")` (flair#2382). */
  pausePre?: WriteBackPause;
  /** Test-only pause between the in-transaction read/build and the write —
   *  the interleaving where this write's transaction opens first. Named at
   *  the call site, like `pausePre`. */
  pausePoint?: WriteBackPause;
  /** Test-only pause after the committed-row confirmation and before this
   *  transaction commits — the interleaving where another writer commits
   *  between the confirmation and this write's commit. Named at the call
   *  site, like `pausePoint`. */
  confirmPoint?: WriteBackPause;
}

/** The fields of `expectedRow` (or of the helper's own first read) it compares
 *  with the row read inside its transaction, besides `matchFields`. */
export const WRITE_BACK_IDENTITY_FIELDS = ["id", "agentId", "instanceToken", "contentHash", "createdAt"] as const;

/**
 * Is `row` still the stored row `basis` describes? Compares the fields in
 * {@link WRITE_BACK_IDENTITY_FIELDS} — the row's id and agent, and the
 * server-stamped incarnation token, content hash and creation time. A `basis`
 * of `null` requires `row` to still be absent.
 *
 * This is the identity check the write-back helper applies, exposed so a
 * writer that cannot hand its write to the helper (one that joins a
 * request-owned transaction, e.g. Memory.put) confirms the SAME facts: before
 * it stages its write, and against the committed row after (through
 * {@link confirmCommittedRow}).
 */
export function sameStoredRow(row: any, basis: any): boolean {
  return row == null ? basis == null : basis != null &&
    String(row.id) === String(basis.id) && row.agentId === basis.agentId &&
    row.instanceToken === basis.instanceToken && row.contentHash === basis.contentHash && row.createdAt === basis.createdAt;
}

/**
 * The named 409 for a write refused because the row it read is no longer the
 * stored one: the row is gone (a delete or a purge committed) or its identity
 * changed (a same-id replace committed: a field {@link sameStoredRow} compares,
 * such as the incarnation token, differs). Nothing was written.
 */
export function storedRowChangedRefusal(tableName: string): Response {
  return new Response(
    JSON.stringify({
      error: "stored_row_changed",
      message: `${tableName} row changed since it was read; not written`,
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

/** Only the identity fields of `row`: an `expectedRow` for a caller that
 *  selects many rows before writing each back, so it need not hold them whole. */
export function writeBackIdentity(row: Record<string, any>): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  for (const field of WRITE_BACK_IDENTITY_FIELDS) identity[field] = row[field];
  return identity;
}

/** Attempts of a write-back before it gives up on a row that keeps changing. */
export const WRITE_BACK_ATTEMPTS = 3;

/**
 * Test-only: record attempt starts and settled outcomes when fault injection
 * is armed and a pause directory is configured.
 */
function noteTestAttempt(label: string, id: string, attempt: number, outcome?: "applied" | "skipped" | "refused"): void {
  if (process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION !== "1") return;
  const dir = process.env.FLAIR_TEST_PAUSE_DIR;
  if (!dir) return;
  try {
    appendFileSync(join(dir, "attempts.write-back"), `${label}\t${id}\t${attempt}${outcome ? `\t${outcome}` : ""}\n`);
  } catch {
    // Append errors are ignored.
  }
}

/**
 * The helper's named refusal: the row changed and nothing was written. Both
 * checks that lead to it (the in-transaction comparison, and the committed-row
 * confirmation after the write is staged) run inside the owned transaction
 * before any commit is submitted, and their throw aborts that transaction, so
 * its staged write is discarded. Whichever check fails, the outcome is known:
 * not written.
 */
export class WriteBackConflictError extends Error {
  readonly id: string;
  constructor(label: string, id: string, attempts: number) {
    super(`${label}: row ${id} changed; write not applied (${attempts} attempts)`);
    this.name = "WriteBackConflictError";
    this.id = id;
  }
}

/** Aborts the write's transaction: the COMMITTED row, re-read after the write
 *  was staged, is no longer the one the write is over. Inside the helper it
 *  never escapes (it is retried, then named by {@link WriteBackConflictError});
 *  a writer that runs {@link confirmCommittedRow} itself (Memory.put) catches it
 *  outside its transaction and answers with {@link storedRowChangedRefusal}. */
export class CommittedRowChanged extends Error {
  constructor() {
    super("committed row changed after the write was staged");
    this.name = "CommittedRowChanged";
  }
}

/**
 * The committed-row confirmation the write-back helper runs once its write is
 * staged and before its transaction commits: re-read the COMMITTED row and
 * throw {@link CommittedRowChanged} unless `same(committed)` holds. The
 * transaction must then abort so the staged write is discarded: an owned
 * transaction aborts when the throw leaves its callback; a caller that joined
 * a request-owned transaction aborts it itself (Memory.put does).
 *
 * The read is an EXPLICIT fresh context, never contextless: a contextless read
 * joins the caller's transaction and sees its old snapshot or its staged write.
 * Harper has no compare-and-set on a table write, so a change committed after
 * this read and before the commit is not seen by it.
 *
 * Exported so a writer that cannot hand its write to the helper (Memory.put,
 * which joins a request-owned transaction) runs the same re-read, with its own
 * predicate (the helper compares the whole row; Memory.put, sameStoredRow).
 */
export async function confirmCommittedRow(
  table: Pick<WriteBackTable, "get">,
  id: string,
  same: (committed: any) => boolean,
): Promise<void> {
  const committed = await table.get(id, {});
  if (!same(committed)) throw new CommittedRowChanged();
}

/** The MemoryGrant surface the committed grant re-check reads: a scoped
 *  search that accepts a context. */
export interface GrantReadTable {
  search(query: any, ctx?: any): AsyncIterable<any>;
}

/**
 * The name for a close whose authorizing "write" grant is gone at the
 * committed-state re-check (flair#2333 H10 / flair#2511). The two closes share
 * the re-check ({@link writeGrantHeld}) and this name, but only the
 * skill-version close answers its caller with it. The skill-version close
 * (skill-version-write.ts) returns {@link grantedCloseRevokedRefusal}, a 409
 * carrying this code. The non-skill close (Memory.ts closeSupersededRecord) runs
 * after its successor is written and throws {@link GrantedCloseRevoked}, which
 * its caller logs: the predecessor stays open, the successor stays written, and
 * the caller's response is a success.
 */
export const GRANTED_CLOSE_REVOKED = "granted_close_revoked";

/** The skill-version close's named 409 for a close whose authorizing "write"
 *  grant is gone at the committed-state re-check. Returned from inside the
 *  version transaction, which then rolls back: nothing is written. */
export function grantedCloseRevokedRefusal(): Response {
  return new Response(
    JSON.stringify({
      error: GRANTED_CLOSE_REVOKED,
      message: "the write grant authorizing this close was revoked; not written",
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

/** Aborts the non-skill close's owned transaction (Memory.ts
 *  closeSupersededRecord): the "write" grant that authorized a cross-agent close
 *  is gone on committed state (flair#2333 H10). The predecessor is not closed;
 *  the caller logs this after its successor is already written. */
export class GrantedCloseRevoked extends Error {
  constructor() {
    super(`${GRANTED_CLOSE_REVOKED}: the write grant authorizing the close was revoked`);
    this.name = "GrantedCloseRevoked";
  }
}

/**
 * Does `table` hold a "write" grant from `ownerId` to `granteeId`? A caller that
 * re-checks on committed state passes an explicit fresh context (`{}`) rather
 * than its own transaction — the same discipline {@link confirmCommittedRow}
 * applies to a row. Fail-closed: a search that rejects reads as no grant, so an
 * unreadable grant does not close the owner's row.
 *
 * The committed-state grant re-check both closes run after staging a
 * grant-authorized cross-agent close: the non-skill close (Memory.ts
 * closeSupersededRecord, flair#2333 H10) and the shared skill-version writer
 * (skill-version-write.ts, flair#2511), whose every caller passes the grant a
 * cross-agent close stands on.
 */
export async function writeGrantHeld(
  table: GrantReadTable,
  granteeId: string,
  ownerId: string,
  ctx?: any,
): Promise<boolean> {
  try {
    for await (const grant of table.search({
      conditions: [
        { attribute: "granteeId", comparator: "equals", value: granteeId },
        { attribute: "ownerId", comparator: "equals", value: ownerId },
      ],
    }, ctx)) {
      if (grant?.scope === "write") return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** The shared helper's own signature — so a migration can inject a plain fake
 *  in unit tests (embedding-stamp's DI style) while production uses the real,
 *  transaction-owning one. */
export type WriteBackFn = typeof writeBackCommittedRow;

/**
 * Write an incremental update of exactly `patch`'s fields, in the caller's
 * transaction. Refuses by name when the table cannot write incrementally
 * (a fake or a stub without `update`): falling back to a full-row `put` here
 * would reintroduce the very full-row write this helper's `update` plan exists
 * to avoid.
 */
async function applyFieldUpdate(
  table: WriteBackTable,
  id: string,
  patch: Record<string, unknown>,
  ctx: any,
): Promise<void> {
  if (typeof table.update !== "function") {
    throw new Error("write-back: the table has no incremental update; refusing to fall back to a full-row put");
  }
  await table.update(id, patch, ctx);
}

export async function writeBackCommittedRow(
  table: WriteBackTable,
  id: string,
  plan: (row: any) => WriteBackPlan | Promise<WriteBackPlan>,
  opts: WriteBackOptions,
): Promise<WriteBackPlan> {
  const attempts = opts.attempts ?? WRITE_BACK_ATTEMPTS;
  const selected = "expectedRow" in opts ? opts.expectedRow : await table.get(id, {});
  const basis = selected == null ? selected : { ...selected };
  const sameTarget = (row: any) => {
    if (row == null) return basis == null;
    if (basis == null) return false;
    return sameStoredRow(row, basis) &&
      (!opts.wholeRow || isDeepStrictEqual({ ...row }, basis)) &&
      (opts.matchFields ?? []).every((field) => isDeepStrictEqual(row[field], basis[field]));
  };
  if (opts.pausePre) {
    const pre = opts.pausePre();
    if (pre) await pre;
  }
  for (let attempt = 1; ; attempt++) {
    noteTestAttempt(opts.label, id, attempt);
    try {
      const decision = await withOwnedTransaction<WriteBackPlan>(opts.ctx, async (c) => {
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
        if ("update" in decision) await applyFieldUpdate(table, id, decision.update, c);
        else await table.put(decision.write, c);
        await confirmCommittedRow(table, id, (committed) => isDeepStrictEqual(committed, row));
        if (opts.confirmPoint) {
          const confirmed = opts.confirmPoint();
          if (confirmed) await confirmed;
        }
        return decision;
      });
      noteTestAttempt(opts.label, id, attempt, "skip" in decision ? "skipped" : "applied");
      return decision;
    } catch (err) {
      noteTestAttempt(opts.label, id, attempt, "refused");
      if (!(err instanceof CommittedRowChanged)) throw err;
      if (attempt >= attempts) throw new WriteBackConflictError(opts.label, id, attempts);
    }
  }
}
