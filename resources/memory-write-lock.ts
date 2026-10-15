/**
 * memory-write-lock.ts — the per-memory-id write serialization protocol
 * (flair#2478 slice 1). The ordinary owner PUT and PATCH (resources/Memory.ts)
 * run under it; the other Memory writers convert in part 2.
 *
 * A writer that must make its read, decision and write on one committed basis
 * runs under ONE key of `Memory.primaryStore`'s lock: `["memory", fullStoredId]`.
 * Within one Harper process the lock is per key and shared by its threads
 * (resources/key-lock.ts). A caller opens and settles its owned transaction
 * inside the callback, so the key is held across the commit. Two PUT paths can
 * join a transaction they do not own, which then commits after the put returns
 * and so after the key is released: a put composed into its caller's
 * transaction (manual promotion, via withComposedWriteTransaction in
 * resources/request-transaction.ts), and the admin `_reindex` re-PUT when the
 * request carries an open transaction, which it joins as it did before the lock
 * (with none open, it owns its transaction and commits before the release).
 *
 * A same-id writer that finds the key held waits and retries within its budget
 * ({@link MEMORY_LOCK_ATTEMPTS} attempts with a {@link MEMORY_LOCK_WAIT_MS} ms
 * wait between them — the bound resources/usage-recording.ts and
 * resources/instruction-version-record.ts use). If the holder releases inside
 * the budget, the writer takes the key. A writer that then opens a new owned
 * transaction (the ordinary PUT and PATCH) reads the row as stored at that
 * moment: the holder's committed row when the holder owned its transaction (a
 * composed or `_reindex` holder that joined another transaction may release
 * before that transaction commits). A composed or `_reindex` writer that joins
 * an already-open request transaction reads from that transaction's snapshot
 * instead, which can predate the acquisition. Otherwise it is refused:
 *
 *  - `503 memory_busy` — the key stayed held for the whole budget. Nothing was
 *    written, so the request can be sent again unchanged. The body carries the
 *    caller id and nothing else: it is byte-identical whether the target id
 *    exists or not, so a lock miss never reveals stored-row state (Sherlock S7).
 *
 * Two more refusals, also `503`:
 *
 *  - `memory_lock_unavailable` — `Memory.primaryStore` has no lock. The write
 *    is refused, never run unserialized, and nothing was written. There is no
 *    production fallback; a unit-test double supplies a lock on its mock table.
 *  - `write_outcome_unknown` — the id's last owned write settled with an
 *    unresolved outcome: its commit may have landed while its verification read
 *    failed. Do not replay that write blindly: read the row first, and treat a
 *    row that already holds it as written. {@link markMemoryWriteOutcomeUnknown}
 *    records the marker; until a process restart clears it (the fencing step),
 *    later PUT, PATCH and DELETE requests for that id are refused, including
 *    a DELETE addressed to a stale skill id whose live head is that id. The other
 *    Memory writers (POST, and the background and nested writers part 2
 *    converts) do not check it.
 *
 * The marker is module state, so it is per Harper worker thread. That covers
 * the whole instance only in the supported single-worker mode: flair refuses to
 * serve on more than one worker thread (resources/multi-worker-guard.ts,
 * flair#2059; every route but `/Health` and `/health` answers 503
 * `multi_worker_unsupported`).
 * Under the explicit `FLAIR_MULTI_WORKER_UNSAFE=1` opt-in, a marker set on one
 * worker is not seen by another.
 *
 * Acquisition is sorted and deduplicated, so two writers that share ids take
 * them in the same order. A partial acquisition is released before the wait, so
 * a writer never blocks on the next key while holding one.
 */

import type { KeyLockStore } from "./key-lock.js";

/** The `Memory.primaryStore` key namespace (flair#2478). */
export const MEMORY_LOCK_NAMESPACE = "memory";
/** The owner-verb busy budget: {@link MEMORY_LOCK_ATTEMPTS} attempts, {@link MEMORY_LOCK_WAIT_MS} ms apart. */
export const MEMORY_LOCK_ATTEMPTS = 200;
export const MEMORY_LOCK_WAIT_MS = 10;
/** The lock-miss error code. */
export const MEMORY_BUSY_ERROR = "memory_busy";
/** The unresolved-outcome error code. */
export const WRITE_OUTCOME_UNKNOWN_ERROR = "write_outcome_unknown";
/** The no-lock error code: the store has no per-id lock, so the write is refused. */
export const MEMORY_LOCK_UNAVAILABLE_ERROR = "memory_lock_unavailable";

/** Per-id unknown-outcome markers (Kern pin 2 / Flint decision). Module state:
 *  one set per worker thread, which is the whole instance in the supported
 *  single-worker mode (see the header). */
const outcomeUnknown = new Set<string>();

/** The `["memory", fullStoredId]` lock key for one stored id. */
export function memoryLockKey(id: string | number): string[] {
  return [MEMORY_LOCK_NAMESPACE, String(id)];
}

/** Record that `id`'s last owned write settled with an unknown outcome. Cleared
 *  only by process restart — there is no production clear path. */
export function markMemoryWriteOutcomeUnknown(id: string | number): void {
  outcomeUnknown.add(String(id));
}

/** Is `id` marked outcome-unknown? A later writer checks this before acquiring. */
export function memoryWriteOutcomeUnknown(id: string | number): boolean {
  return outcomeUnknown.has(String(id));
}

/** TEST-ONLY: forget the marker for `id` so one test cannot leak into the next.
 *  Never called by production code (the production clear path is restart). */
export function resetMemoryWriteOutcomeUnknownForTest(id: string | number): void {
  outcomeUnknown.delete(String(id));
}

/** The keys a locked call holds, in acquisition order, and the stored ids they
 *  name. Handed to the callback as the explicit locked capability nested
 *  helpers receive (flair#2478 build spec). */
export interface MemoryLockedScope {
  readonly keys: readonly (readonly string[])[];
  readonly ids: readonly string[];
}

export type MemoryLockOutcome<T> =
  | { kind: "done"; value: T }
  | { kind: "busy" }
  | { kind: "unknown"; id: string }
  | { kind: "unavailable" };

type LockableStore = Partial<KeyLockStore> | null | undefined;

/** The sorted, deduplicated ids and their lock keys. */
function normalizeIds(ids: readonly (string | number)[]): { ids: string[]; keys: string[][] } {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    const text = String(id);
    if (!seen.has(text)) {
      seen.add(text);
      unique.push(text);
    }
  }
  unique.sort();
  return { ids: unique, keys: unique.map(memoryLockKey) };
}

function lockStore(store: unknown): KeyLockStore | undefined {
  const lock = store as LockableStore;
  if (typeof lock?.tryLock !== "function" || typeof lock?.unlock !== "function") return undefined;
  return lock as KeyLockStore;
}

function releaseAll(lock: KeyLockStore, acquired: string[][]): void {
  for (let i = acquired.length - 1; i >= 0; i--) lock.unlock(acquired[i]);
  acquired.length = 0;
}

/**
 * Run `fn` while holding every `["memory", id]` key for `ids` (sorted,
 * deduplicated), up to {@link MEMORY_LOCK_ATTEMPTS} attempts spaced
 * {@link MEMORY_LOCK_WAIT_MS}. Returns `busy` when the budget is exhausted;
 * `unknown` when one of the ids carries an unknown-outcome marker; `unavailable`
 * when the store has no lock. `fn` does not run in those cases.
 */
export async function withMemoryWriteLock<T>(
  store: unknown,
  ids: readonly (string | number)[],
  fn: (locked: MemoryLockedScope) => Promise<T>,
): Promise<MemoryLockOutcome<T>> {
  return acquire(lockStore(store), normalizeIds(ids), MEMORY_LOCK_ATTEMPTS, MEMORY_LOCK_WAIT_MS, fn);
}

/** One attempt, no wait. No writer calls it yet: it is the shape part 2's
 *  automatic writers take (flair#2478). A held lock or a marker answers
 *  `busy`/`unknown`. */
export async function withMemoryWriteLockOnce<T>(
  store: unknown,
  ids: readonly (string | number)[],
  fn: (locked: MemoryLockedScope) => Promise<T>,
): Promise<MemoryLockOutcome<T>> {
  return acquire(lockStore(store), normalizeIds(ids), 1, 0, fn);
}

async function acquire<T>(
  lock: KeyLockStore | undefined,
  normalized: { ids: string[]; keys: string[][] },
  attempts: number,
  waitMs: number,
  fn: (locked: MemoryLockedScope) => Promise<T>,
): Promise<MemoryLockOutcome<T>> {
  if (!lock) return { kind: "unavailable" };
  const scope: MemoryLockedScope = { keys: normalized.keys, ids: normalized.ids };
  const acquired: string[][] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const marked = normalized.ids.find((id) => memoryWriteOutcomeUnknown(id));
    if (marked !== undefined) return { kind: "unknown", id: marked };
    let gotAll = true;
    for (const key of normalized.keys) {
      if (lock.tryLock(key)) acquired.push(key);
      else {
        gotAll = false;
        break;
      }
    }
    if (gotAll) {
      try {
        lock.resetReadTxn?.();
        // The marker was checked at the top of this attempt; nothing between
        // that check and here yields, so it cannot have changed.
        return { kind: "done", value: await fn(scope) };
      } finally {
        // Release only after `fn` returns. A callback that owns its transaction
        // has settled it by then, so the lock spans that commit; a transaction
        // the callback only joined commits later, after this release.
        releaseAll(lock, acquired);
      }
    }
    // Partial acquisition: release what we hold before waiting on the rest.
    releaseAll(lock, acquired);
    if (attempt + 1 < attempts && waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return { kind: "busy" };
}

/** The lock-miss refusal: `503 memory_busy`, caller id only, no row state. */
export function memoryBusyResponse(callerId: string): Response {
  return new Response(JSON.stringify({ error: MEMORY_BUSY_ERROR, caller: callerId }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

/** The unresolved-outcome refusal: `503 write_outcome_unknown`. */
export function writeOutcomeUnknownResponse(): Response {
  return new Response(
    JSON.stringify({
      error: WRITE_OUTCOME_UNKNOWN_ERROR,
      message: "the last write to this id may or may not have landed. Read the row before writing again: if it already holds that write, do not resend it. PUT, PATCH and DELETE requests for this id are refused until the instance restarts.",
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

/** The no-lock refusal: `503 memory_lock_unavailable`. Nothing was written. */
export function memoryLockUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: MEMORY_LOCK_UNAVAILABLE_ERROR,
      message: "this instance's Memory store has no per-id write lock, so the write was refused; nothing was written",
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}
