/**
 * memory-write-transaction.ts — the locked transaction scope for nested Memory
 * writes (flair#2478 part 3a).
 *
 * A writer that holds the per-id Memory lock (resources/memory-write-lock.ts)
 * and must write a Memory row through the guarded write body opens this scope
 * with its lock token. Each scope owns one transaction (withOwnedTransaction:
 * a request transaction on the caller context is detached for the scope and
 * restored afterwards) and hands `work` a
 * {@link LockedMemoryTransaction} bound to it. The checked writes
 * (`putMemoryWithLock` / `patchMemoryWithLock` in resources/Memory.ts) join that
 * transaction; they return `staged`, never committed success.
 *
 * Order:
 *  1. `work` runs. A checked write is admitted synchronously, before its first
 *     suspension, so the scope knows of it even if `work` does not await it.
 *     A write settles as `staged` once its row is staged; its body then waits.
 *  2. When `work` settles, admission closes and every admitted write is
 *     drained. Before the commit, a rejection of `work`, an admitted write's
 *     rejection before it stages, a refusal returned by `work` (a `Response`),
 *     a refused write, or a checked-write admission capability refusal inside
 *     the scope aborts the transaction; nothing is committed, and a waiting
 *     body ends. A write that has staged stays `staged`: a later rejection of
 *     its body does not abort the scope and is reported after the commit, as
 *     that write's confirmed answer.
 *  3. The transaction commits.
 *  4. Each staged write's body resumes, in admission order, for its
 *     post-commit confirmation, while the lock is still held (the acquisition
 *     waits for this scope to settle before it revokes the token and releases
 *     the keys).
 *  5. Only then is `committed` reported, with each write's confirmed answer.
 *     A confirmation runs after the commit, so its failure aborts nothing: a
 *     confirmation that answers a refusal makes the scope report that
 *     refusal, and one that throws makes the scope throw, with the write
 *     already committed.
 */

import {
  MemoryWriteCapabilityError,
  admitLockedScope,
  assertMemoryWriteLockToken,
  memoryWriteLockAcquisition,
  type MemoryWriteLockToken,
} from "./memory-write-lock.js";
import { isJoinableTransaction, withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";

declare const LOCKED_MEMORY_TRANSACTION: unique symbol;
/** The handle a locked transaction scope gives `work`. Opaque: an empty frozen
 *  object whose state is private to this module. */
export type LockedMemoryTransaction = { readonly [LOCKED_MEMORY_TRANSACTION]: true };

/** What a checked write returns inside the scope: staged (not yet committed),
 *  or refused with the refusal the public verb would answer. */
export type MemoryWriteReceipt =
  | { readonly status: "staged"; readonly id: string }
  | { readonly status: "refused"; readonly response: Response };

/** How a scope ended: committed and confirmed, or refused (aborted before the
 *  commit, or committed with a confirmation that failed). */
export type LockedTransactionOutcome<T> =
  | { readonly kind: "committed"; readonly value: T; readonly confirmed: readonly unknown[] }
  | { readonly kind: "refused"; readonly response: Response };

interface ScopeState {
  /** The acquisition this scope was opened on. */
  readonly acquisition: object;
  readonly context: any;
  readonly transaction: unknown;
  phase: "open" | "draining" | "closed";
  readonly writes: Promise<MemoryWriteReceipt>[];
  /** Each staged write's post-commit confirmation: resume its body, await its answer. */
  readonly confirmations: Array<() => Promise<unknown>>;
  /** Each staged write's resume gate: true after the commit, false otherwise. */
  readonly gates: Array<(committed: boolean) => void>;
  /** A checked-write admission refused its capability inside this open scope: the scope aborts. */
  failure?: { error: unknown };
}

const scopes = new WeakMap<object, ScopeState>();

/** The error a lock call rejects with when its callback returned while a
 *  locked scope it did not await was still open, and that scope then ended
 *  refused (resources/memory-write-lock.ts). Carries the refusal. */
export class LockedScopeRefusedError extends Error {
  constructor(readonly response: Response) {
    super(`a locked memory transaction the lock callback did not await was refused (HTTP ${response.status})`);
    this.name = "LockedScopeRefusedError";
  }
}

/** Thrown inside the owned transaction to abort it with a refusal. */
class LockedTransactionRefusal extends Error {
  constructor(readonly response: Response) {
    super("locked memory transaction refused");
  }
}

/**
 * Open the locked transaction scope for `held`'s acquisition (see the header).
 * `callerContext` is the authenticated caller context; the checked writes act
 * as that caller. Throws {@link MemoryWriteCapabilityError} when `held` is not
 * a live token or a scope is already open on its acquisition.
 */
export async function withLockedMemoryTransaction<T>(
  held: MemoryWriteLockToken,
  callerContext: unknown,
  work: (tx: LockedMemoryTransaction) => Promise<T>,
): Promise<LockedTransactionOutcome<T>> {
  const admission = admitLockedScope(held);
  try {
    const outcome = await runScope(held, callerContext, work);
    // A refusal settles the scope as failed, so an acquisition whose callback
    // did not await this scope rejects with it instead of reporting success.
    admission.settle(outcome.kind === "refused" ? { error: new LockedScopeRefusedError(outcome.response) } : undefined);
    return outcome;
  } catch (error) {
    admission.settle({ error });
    throw error;
  }
}

async function runScope<T>(
  held: MemoryWriteLockToken,
  callerContext: unknown,
  work: (tx: LockedMemoryTransaction) => Promise<T>,
): Promise<LockedTransactionOutcome<T>> {
  const tx = Object.freeze(Object.create(null)) as LockedMemoryTransaction;
  let state: ScopeState | undefined;
  try {
    const value = await withOwnedTransaction(callerContext, async (c) => {
      state = { acquisition: memoryWriteLockAcquisition(held), context: c, transaction: c.transaction, phase: "open", writes: [], confirmations: [], gates: [] };
      scopes.set(tx, state);
      let workValue: T | undefined;
      let workFailure: { error: unknown } | undefined;
      try {
        workValue = await work(tx);
      } catch (error) {
        workFailure = { error };
      }
      // Close admission, then drain every admitted write before deciding.
      state.phase = "draining";
      const settled = await Promise.allSettled(state.writes);
      if (workFailure) throw workFailure.error;
      if (state.failure) throw state.failure.error;
      for (const write of settled) if (write.status === "rejected") throw write.reason;
      if (workValue instanceof Response) throw new LockedTransactionRefusal(workValue);
      for (const write of settled) {
        if (write.status === "fulfilled" && write.value.status === "refused") throw new LockedTransactionRefusal(write.value.response);
      }
      // Test-only: every write is staged and drained, the commit has not run.
      const staged = txnPausePoint("memory-locked-staged");
      if (staged) await staged;
      return workValue as T;
    });
    // Test-only: the transaction has committed, its confirmations have not run.
    const committed = txnPausePoint("memory-locked-committed");
    if (committed) await committed;
    const confirmed: unknown[] = [];
    let refusal: Response | null = null;
    for (const confirm of state!.confirmations) {
      const answer = await confirm();
      if (answer instanceof Response) refusal ??= answer;
      else confirmed.push(answer);
    }
    if (refusal) return { kind: "refused", response: refusal };
    return { kind: "committed", value, confirmed };
  } catch (error) {
    if (error instanceof LockedTransactionRefusal) return { kind: "refused", response: error.response };
    throw error;
  } finally {
    if (state) {
      state.phase = "closed";
      // A write still waiting (its scope did not commit) ends without its tail.
      for (const open of state.gates) open(false);
    }
  }
}

/** The context of `tx`'s scope: the caller context carrying the scope's open
 *  transaction, so reads made with it are in that transaction. */
export function lockedTransactionContext(tx: LockedMemoryTransaction): any {
  const state = scopes.get(tx as object);
  if (!state) throw new MemoryWriteCapabilityError("not_a_transaction", "not a locked memory transaction");
  if (state.phase === "closed" || !scopeTransactionOpen(state)) {
    throw new MemoryWriteCapabilityError("transaction_closed", "the locked transaction is closed");
  }
  return state.context;
}

/** What an admitted checked write may do in its scope. */
export interface LockedWriteAdmission {
  /** The scope's context: the caller context carrying the scope's transaction. */
  readonly context: any;
  /** Run `fn` in the scope's transaction. Refuses if `ctx` is not the scope's
   *  context or the transaction is no longer the scope's open transaction. */
  join<R>(ctx: unknown, fn: (shared: any) => Promise<R>): Promise<R>;
  /**
   * Run the write, tracked by the scope from before it starts. `run` calls
   * `stage()` once its row is staged: the write then settles as `staged` for
   * `id`, and `stage()` resolves true after the scope commits (what `run` then
   * returns is the write's confirmed answer) or false when the scope does not
   * commit. A `run` that returns a `Response` without staging settles the
   * write as refused with that `Response`; one that returns anything else
   * without staging, or throws before staging, settles the write as rejected.
   * Once `run` has staged, the write stays `staged`; a later rejection of
   * `run` does not abort the scope and is what the write's confirmation
   * answers after the commit.
   */
  track(id: string, run: (stage: () => Promise<boolean>) => Promise<unknown>): Promise<MemoryWriteReceipt>;
}

function scopeTransactionOpen(state: ScopeState): boolean {
  return state.context?.transaction === state.transaction && isJoinableTransaction(state.context);
}

/**
 * Admit one checked Memory write into `tx` (resources/Memory.ts). Refuses with
 * {@link MemoryWriteCapabilityError} unless `held` is a live token acquired on
 * `store` that covers every id in `ids`, `tx` is an open scope opened on that
 * same acquisition, and the scope's transaction is still open. A refusal of this
 * admission inside an open scope also aborts that scope.
 */
export function admitLockedMemoryWrite(
  held: unknown,
  tx: unknown,
  store: unknown,
  ids: readonly string[],
): LockedWriteAdmission {
  const state = tx !== null && typeof tx === "object" ? scopes.get(tx) : undefined;
  try {
    assertMemoryWriteLockToken(held, { store, ids });
    if (!state) throw new MemoryWriteCapabilityError("not_a_transaction", "not a locked memory transaction");
    if (memoryWriteLockAcquisition(held) !== state.acquisition) {
      throw new MemoryWriteCapabilityError("transaction_mismatch", "the locked transaction belongs to another acquisition");
    }
    if (state.phase !== "open" || !scopeTransactionOpen(state)) {
      throw new MemoryWriteCapabilityError("transaction_closed", "the locked transaction is no longer admitting writes");
    }
  } catch (error) {
    if (state && state.phase === "open") state.failure ??= { error };
    throw error;
  }
  const scope = state;
  return {
    context: scope.context,
    join(ctx, fn) {
      if (ctx !== scope.context || scope.phase === "closed" || !scopeTransactionOpen(scope)) {
        return Promise.reject(new MemoryWriteCapabilityError("transaction_closed", "the write is not in its locked transaction"));
      }
      return fn(ctx);
    },
    track(id, run) {
      if (scope.phase !== "open") {
        return Promise.reject(new MemoryWriteCapabilityError("transaction_closed", "the locked transaction is no longer admitting writes"));
      }
      let settle!: (receipt: MemoryWriteReceipt) => void;
      let fail!: (error: unknown) => void;
      const receipt = new Promise<MemoryWriteReceipt>((resolve, reject) => { settle = resolve; fail = reject; });
      scope.writes.push(receipt);
      let staged = false;
      let answer: Promise<unknown> | undefined;
      const stage = (): Promise<boolean> => {
        if (staged) return Promise.reject(new Error("flair: a checked Memory write staged twice"));
        staged = true;
        let open!: (committed: boolean) => void;
        const gate = new Promise<boolean>((resolve) => { open = resolve; });
        scope.gates.push(open);
        scope.confirmations.push(async () => {
          open(true);
          return answer;
        });
        settle({ status: "staged", id });
        return gate;
      };
      answer = (async () => run(stage))();
      answer.then(
        (value) => {
          if (staged) return;
          if (value instanceof Response) settle({ status: "refused", response: value });
          else fail(new Error("flair: a checked Memory write returned neither staged nor a refusal"));
        },
        (error) => {
          if (!staged) fail(error);
        },
      );
      return receipt;
    },
  };
}
