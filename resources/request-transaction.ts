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
 */
import * as harper from "harper";

/** Harper's own `isJoinableScope` (DatabaseTransaction.ts): OPEN and not a
 *  self-committing link. A context with no such transaction needs one. */
export function isJoinableTransaction(ctx: any): boolean {
  const t = ctx?.transaction;
  return !!t && t.open === 1 && !t.saveCommits;
}

/** The `transaction` helper assigned onto the harper package at runtime
 *  (`_assignPackageExport('transaction', …)`; not statically exported, so a
 *  namespace read is used). Undefined under the unit mock. */
function harperTransaction(): ((ctx: any, cb: (txn: any) => any) => any) | undefined {
  // Harper assigns the helper onto the GLOBAL at load (`global.transaction`),
  // and the unit mock sets the same global when it installs (see
  // test/helpers/memory-search-harness.ts) — reading it here is robust to the
  // shared-process `mock.module` race, unlike a namespace import which binds
  // whichever mock won.
  const g = (globalThis as any)?.transaction;
  if (typeof g === "function") return g;
  const t = (harper as any)?.transaction;
  return typeof t === "function" ? t : undefined;
}

/**
 * Run `fn` so every write it performs shares ONE transaction, and hand `fn` the
 * context object the writes must be given. If `ctx` already carries a joinable
 * transaction, `fn` joins it (the request owns commit/abort). Otherwise Harper
 * creates and owns a transaction around `fn` — which is what makes an internal,
 * context-less caller atomic. When no Harper runtime is present (the unit
 * mock), `fn` runs unwrapped so the mock keeps working.
 */
export async function withSharedWriteTransaction<T>(ctx: any, fn: (shared: any) => Promise<T>): Promise<T> {
  const shared = ctx ?? {};
  if (isJoinableTransaction(shared)) return fn(shared);
  const txn = harperTransaction();
  if (!txn) return fn(shared);
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
