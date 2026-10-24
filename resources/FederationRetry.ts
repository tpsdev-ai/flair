/**
 * FederationRetry — the table for the sender's federation retry bookkeeping
 * (flair#2455 slice 1: storage, the atomic transition, the operator query).
 *
 * The table is shaped for one row per (peerId, table, recordId) the receiver
 * refused for a reason a later re-offer could clear, plus locally observed
 * unconfirmed sends. The sync sender writes these rows; an admin can also
 * write them directly. See
 * resources/federation-retry-lib.ts for the key/state/outcome vocabulary and
 * schemas/federation.graphql for the table.
 *
 * WHAT IS ENFORCED. The table is `@sealed`, so Harper refuses a write that
 * names a field the schema does not declare, and the transition below writes
 * only the declared fields (RETRY_ROW_FIELDS). That the id encodes the tuple
 * and that state, reason and outcome hold their documented values are sender
 * conventions the schema does not enforce; the reader and the transition check
 * them (retryRowProblem) and treat a row that breaks one as malformed.
 *
 * ISOLATION (design rev 2 K2). `FederationRetry` is deliberately absent from
 * FEDERATION_TABLE_POLICY (resources/federation-classify.ts) and therefore from
 * FederationSync's receive `tableMap` (resources/Federation.ts), so no inbound
 * sync record can write the table, even though receive `allowCreate` is public
 * (a record that passes the receiver's earlier payload-id check skips as
 * `unknown_table`). It is also not a sending table: the sync sender reads and
 * writes retry rows through its local operations endpoint.
 *
 * ACCESS (design rev 2.1). Admin-only on read, create,
 * update AND delete — the FederationPeers/Peer pattern (resources/Peer.ts,
 * resources/Federation.ts). The table is meant for local retry bookkeeping
 * (keys, counters, reasons and outcomes); the schema does not constrain what
 * an admin writes into its string fields.
 */
import { databases } from "harper";
import { isDeepStrictEqual } from "node:util";
import { allowAdmin } from "./agent-auth.js";
import { withKeyLock } from "./key-lock.js";
import { withOwnedTransaction } from "./request-transaction.js";
import {
  retryEntryKey,
  isRetryBound,
  isRetryResolution,
  pickRetryRowFields,
  retryRowProblem,
  type RetryBound,
  type RetryResolution,
} from "./federation-retry-lib.js";

/** Admin-only on every operation. The Peer/FederationPeers pattern. */
export class FederationRetry extends (databases as any).flair.FederationRetry {
  allowRead()   { return allowAdmin((this as any).getContext?.()); }
  allowCreate() { return allowAdmin((this as any).getContext?.()); }
  allowUpdate() { return allowAdmin((this as any).getContext?.()); }
  allowDelete() { return allowAdmin((this as any).getContext?.()); }
}

/** Per-peer sender-ownership lock namespace (design rev 2 K2: "serialize sender ownership per peer"). */
export const RETRY_LOCK_NAMESPACE = "federation-retry";
export const RETRY_LOCK_ATTEMPTS = 40;
export const RETRY_LOCK_WAIT_MS = 25;

interface RetryTerminalBase {
  peerId: string;
  table: string;
  recordId: string;
  completedAt?: string;
  /** The request context, if any. Its transaction is detached for the owned one. */
  ctx?: any;
  /**
   * Optional in-process hook, awaited between the in-transaction read and the
   * write. It is a function argument, so no request can supply it; no shipped
   * resource passes one (the tests do, to hold the lock at a known point).
   */
  pausePoint?: () => Promise<void> | undefined;
}

/**
 * A terminal outcome. `bound` names which bound fired, so it is REQUIRED for
 * `retry_exhausted` and absent (or null) for every other resolution. The
 * transition re-checks this at run time and refuses a mismatch without writing.
 */
export type RetryTerminalInput = RetryTerminalBase & (
  | { resolution: "retry_exhausted"; bound: RetryBound }
  | { resolution: Exclude<RetryResolution, "retry_exhausted">; bound?: null }
);

export type RetryTerminalErrorCode =
  | "invalid"
  | "table_unavailable"
  | "not_found"
  | "malformed"
  | "already_terminal"
  | "lock_busy"
  | "lock_unavailable"
  | "write_failed";

export type RetryTerminalOutcome =
  | { ok: true; id: string }
  | { ok: false; code: RetryTerminalErrorCode; message: string };

/**
 * Move one retry entry `pending` → `terminal`, atomically and fail-closed.
 *
 * Runs under the peer's per-key lock on the table store, in a transaction this
 * call owns: the read that checks `pending` and the write that sets the
 * terminal outcome commit together or not at all. A caller bug (missing
 * component, unknown resolution or bound, a `retry_exhausted` without its
 * bound, a bound on any other resolution), a missing row, a malformed row
 * (retryRowProblem) and an already-terminal row are refused by name WITHOUT
 * writing. If the write or the confirming re-read fails, the transaction
 * aborts, so the call commits no change of its own (the stored row keeps
 * whatever was last committed, including by an independent admin write), and
 * the outcome is never reported as success.
 *
 * The write carries only the schema's declared fields (RETRY_ROW_FIELDS), never
 * a spread of the stored row.
 */
export async function terminalizeRetryEntry(input: RetryTerminalInput): Promise<RetryTerminalOutcome> {
  let id: string;
  try {
    id = retryEntryKey(input.peerId, input.table, input.recordId);
  } catch (err: any) {
    return { ok: false, code: "invalid", message: err?.message ?? String(err) };
  }
  // Checked at run time as well as by the type: a caller outside TypeScript (or
  // one that casts) can still pass any pair.
  const { resolution, bound } = input as { resolution: unknown; bound?: unknown };
  if (!isRetryResolution(resolution)) {
    return { ok: false, code: "invalid", message: `unknown retry resolution: ${String(resolution)}` };
  }
  if (bound != null && !isRetryBound(bound)) {
    return { ok: false, code: "invalid", message: `unknown retry bound: ${String(bound)}` };
  }
  if (resolution === "retry_exhausted" && bound == null) {
    return { ok: false, code: "invalid", message: "a retry_exhausted outcome must name the bound that fired (attempts, age or both)" };
  }
  if (resolution !== "retry_exhausted" && bound != null) {
    return { ok: false, code: "invalid", message: `a ${resolution} outcome takes no bound; only retry_exhausted records one` };
  }

  const table = (databases as any).flair?.FederationRetry;
  if (!table || typeof table.get !== "function" || typeof table.put !== "function") {
    return { ok: false, code: "table_unavailable", message: "the FederationRetry table is unavailable" };
  }

  const outcome = await withKeyLock(
    table.primaryStore,
    [RETRY_LOCK_NAMESPACE, input.peerId],
    () => withOwnedTransaction(input.ctx, async (shared) => {
      const row = await table.get(id, shared);
      if (!row) return { ok: false, code: "not_found", message: `${id} is not a retry entry` } as RetryTerminalOutcome;
      const problem = retryRowProblem(row);
      if (problem) {
        return { ok: false, code: "malformed", message: `${id} is malformed (${problem}) and is never transitioned` } as RetryTerminalOutcome;
      }
      if (row.state !== "pending") {
        return { ok: false, code: "already_terminal", message: `${id} is already ${String(row.state)}` } as RetryTerminalOutcome;
      }
      const now = input.completedAt ?? new Date().toISOString();
      const next = {
        ...pickRetryRowFields(row),
        state: "terminal",
        resolution,
        bound: bound ?? null,
        completedAt: now,
        updatedAt: now,
      };
      if (input.pausePoint) {
        const pause = input.pausePoint();
        if (pause) await pause;
      }
      await table.put(next, shared);
      // Confirm no concurrent commit changed the row between the read above and
      // this write: Harper has no compare-and-set, so a change committed after
      // this re-read and before the commit is not seen (write-back.ts).
      const committed = await table.get(id, {});
      if (!isDeepStrictEqual(committed, row)) {
        throw new Error(`retry transition: ${id} changed concurrently; the transition was not applied`);
      }
      return { ok: true, id } as RetryTerminalOutcome;
    }),
    RETRY_LOCK_ATTEMPTS,
    RETRY_LOCK_WAIT_MS,
  ).catch((err: any) => ({ kind: "threw", error: err }) as const);

  if (outcome.kind === "threw") {
    // The owned transaction aborted and committed no change of its own. Fail closed.
    return { ok: false, code: "write_failed", message: outcome.error?.message ?? String(outcome.error) };
  }
  if (outcome.kind === "busy") {
    return { ok: false, code: "lock_busy", message: `another transition of peer ${input.peerId}'s retries is in progress` };
  }
  if (outcome.kind === "unavailable") {
    return { ok: false, code: "lock_unavailable", message: "the FederationRetry store has no per-key lock" };
  }
  return outcome.value as RetryTerminalOutcome;
}
