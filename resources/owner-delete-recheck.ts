/**
 * owner-delete-recheck.ts — the confirmation a non-admin owner-scoped delete
 * runs before it removes a row (flair#2355).
 *
 * A non-admin delete reads the stored row, decides the caller owns it, then
 * deletes it. Harper 5.2.8 has no compare-and-set on a table write: a
 * transaction does not fail when a row it read is changed by another write
 * before it commits; Harper applies both writes, ordered by transaction
 * timestamp. So an owner change committed between that read and the delete's
 * commit — an admin/internal write, or a raw table write, as an operator or a
 * migration would make — would let the delete remove a row that is no longer
 * the caller's.
 *
 * This helper runs the read and the delete in ONE transaction the call OWNS
 * (withOwnedTransaction), re-reads the row there, and, for a non-admin caller,
 * pauses (a test-only point) between that read and the delete and re-reads the
 * COMMITTED row before the delete is staged. A row whose owner is no longer
 * the caller is refused (`owner_changed`) and not deleted; a row that is
 * gone is reported absent.
 *
 * The owner field is immutable to a non-admin's own writes
 * (guardOwnerFieldImmutable, resources/owner-field-guard.ts), so the change this
 * confirmation catches comes from an admin or internal write, or a raw table
 * write — the writers that can re-point a stored row's owner.
 *
 * The confirmation read runs inside the owned transaction in an EXPLICIT
 * fresh context (`{}`), never contextless: a contextless read joins the
 * request's ambient operation transaction and reads that transaction's pinned
 * read snapshot (flair#2147), and a by-id read on the request Resource
 * instance reads that instance's request-time entry.
 */
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint, type TxnPausePoint } from "./txn-pause-point.js";

/** The named error for a delete refused because the row's owner changed (flair#2355). */
export const OWNER_CHANGED_ERROR = "owner_changed";

/** The named 409 for an owner-scoped delete whose row's owner is no longer the caller. */
export function ownerChangedRefusal(tableName: string): Response {
  return new Response(
    JSON.stringify({
      error: OWNER_CHANGED_ERROR,
      message: `${tableName} row is no longer owned by the caller; not deleted`,
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

/** The raw table seam the confirmation reaches, injectable for unit tests. */
export interface OwnerDeleteTable {
  get(id: string, context?: unknown): Promise<Record<string, unknown> | null>;
  delete(id: string, context?: unknown): Promise<unknown>;
}

export type OwnerDeleteOutcome =
  | { kind: "deleted"; result: unknown }
  | { kind: "absent" }
  | { kind: "refused"; response: Response };

export interface OwnerDeleteSpec {
  table: OwnerDeleteTable;
  /** The table's name, for the refusal body. */
  tableName: string;
  /** The resolved id of the row to delete. */
  id: string;
  /** The attribute naming the owning principal. */
  ownerField: string;
  /** The authenticated non-admin caller. */
  callerId: string;
  /** The in-transaction pause point (between the ownership read and the delete). */
  point: TxnPausePoint;
}

/**
 * Delete `spec.id` in a transaction this call owns, refusing unless the row is
 * still owned by `spec.callerId` (flair#2355).
 *
 * Returns `deleted` with the table delete's result, `absent` when no row is
 * there (the caller decides the no-op), or `refused` with the named 409 when
 * the stored or committed row's owner is not the caller. A delete whose row
 * exists but reports no success throws rather than a silent partial.
 */
export async function deleteOwnedRow(ctx: unknown, spec: OwnerDeleteSpec): Promise<OwnerDeleteOutcome> {
  return withOwnedTransaction(ctx, async (c) => {
    const stored = await spec.table.get(spec.id, c);
    if (!stored) return { kind: "absent" } as OwnerDeleteOutcome;
    if (stored[spec.ownerField] !== spec.callerId) {
      return { kind: "refused", response: ownerChangedRefusal(spec.tableName) } as OwnerDeleteOutcome;
    }
    // Test-only: inert unless the fault-injection env opt-in is set and armed.
    const pause = txnPausePoint(spec.point);
    if (pause) await pause;
    // Confirmation read: the committed row in an explicit fresh context (see
    // this module's header — never contextless).
    const confirmed = await spec.table.get(spec.id, {});
    if (confirmed && confirmed[spec.ownerField] !== spec.callerId) {
      return { kind: "refused", response: ownerChangedRefusal(spec.tableName) } as OwnerDeleteOutcome;
    }
    const result = await spec.table.delete(spec.id, c);
    if (result !== true) throw new Error(`${spec.tableName} row delete was not confirmed`);
    return { kind: "deleted", result } as OwnerDeleteOutcome;
  });
}
