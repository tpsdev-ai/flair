/**
 * request-transaction.ts — one shared write scope for the host-pointer path
 * (flair#1940 slice 1). A Memory row and its `MemoryHostSource` pointer row
 * must commit together or not at all. When a request carries an open,
 * joinable transaction, both writes join it (the request owns commit). When it
 * does NOT — an internal caller with no request context, e.g. a direct
 * `new Memory().post(...)` — the Memory write would otherwise commit
 * immediately on its own and a failed pointer write would leave a row without
 * its pointer. {@link withSharedWriteTransaction} creates that missing
 * transaction with Harper's `transaction(ctx, cb)` (dist/resources/
 * transaction.js), which creates one when absent and owns its commit/abort.
 * If Harper's transaction function is NOT available, this THROWS — an unwrapped
 * write could commit the Memory row before its pointer write fails, which A7
 * forbids. There is no silent fallback.
 *
 * Pinned by test/unit/memory-host-source.test.ts (r20-atomic) for the owned
 * transaction the context-less path needs, and by
 * test/unit/host-pointer-round7.test.ts (tx1) for the throw — each fails if the
 * branch it names is removed.
 */

/** Harper's own `isJoinableScope` (DatabaseTransaction.ts): OPEN and not a
 *  self-committing link. A context with no such transaction needs one. */
export function isJoinableTransaction(ctx: any): boolean {
  const t = ctx?.transaction;
  return !!t && t.open === 1 && !t.saveCommits;
}

/** The `transaction` helper Harper assigns onto the GLOBAL at load
 *  (`global.transaction`). Read from the global so it is robust to the
 *  shared-process `mock.module` race; the unit mock sets the same global. */
function harperTransaction(): ((ctx: any, cb: (txn: any) => any) => any) | undefined {
  const g = (globalThis as any)?.transaction;
  return typeof g === "function" ? g : undefined;
}

/**
 * Run `fn` so every write it performs shares ONE transaction, and hand `fn` the
 * context object the writes must be given. If `ctx` already carries a JOINABLE
 * (OPEN, not self-committing) transaction, `fn` joins it — the request owns
 * commit/abort. A CLOSED transaction left on the chain by a drained generator
 * is NOT joined (that is the detached-transaction discipline in
 * table-helpers.ts); a fresh, owned transaction is created instead. Otherwise
 * Harper creates and owns a transaction around `fn` — which is what makes an
 * internal, context-less caller atomic. When Harper's transaction function is
 * unavailable this THROWS (no unwrapped fallback).
 *
 * Pinned by test/unit/memory-host-source.test.ts (r20-atomic) — the owned
 * branch for a context-less internal create — and by
 * test/unit/host-pointer-round7.test.ts (tx1) — the missing-function throw.
 */
export async function withSharedWriteTransaction<T>(ctx: any, fn: (shared: any) => Promise<T>): Promise<T> {
  const shared = ctx ?? {};
  if (isJoinableTransaction(shared)) return fn(shared);
  const txn = harperTransaction();
  if (!txn) {
    throw new Error(
      "flair: Harper's transaction() is unavailable — refusing to run a Memory/pointer write unwrapped (A7: no silent loss)",
    );
  }
  return (await txn(shared, () => fn(shared))) as T;
}

/**
 * Run `fn` in a transaction this call OWNS even when `ctx` already carries an
 * open request transaction. Used for a batch operation (the MemoryMaintenance
 * expiry/archive arms and the orphan sweep) where one item's failure must abort
 * only THAT item, not the whole request. The request transaction is detached
 * for `fn` (a fresh, owned one is created) and restored afterwards; the owned
 * transaction commits or aborts when `fn` settles.
 */
export async function withOwnedTransaction<T>(ctx: any, fn: (shared: any) => Promise<T>): Promise<T> {
  if (!ctx) return withSharedWriteTransaction(ctx, fn);
  const saved = ctx.transaction;
  ctx.transaction = undefined;
  try {
    return await withSharedWriteTransaction(ctx, fn);
  } finally {
    ctx.transaction = saved;
  }
}
