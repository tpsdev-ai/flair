/**
 * memory-write-lock.ts — the per-memory-id write serialization protocol
 * (flair#2478 slice 1). Slice 1 lands the protocol inert, with unit and
 * real-Harper tests, before the owner verbs convert to it.
 *
 * A writer that must make its read, decision and write on one committed basis
 * runs under ONE key of `Memory.primaryStore`'s lock: `["memory", fullStoredId]`.
 * Within one Harper process the lock is per key and shared by its threads
 * (resources/key-lock.ts). The lock is held across the owned transaction, so it
 * is released only after that transaction commits or aborts.
 *
 * Two refusals, both `503` because both are retryable without replaying an
 * uncertain write:
 *
 *  - `memory_busy` — the lock could not be acquired within the caller's budget
 *    ({@link MEMORY_LOCK_ATTEMPTS} × {@link MEMORY_LOCK_WAIT_MS}, the same
 *    `200 × 10 ms` bound resources/usage-recording.ts and
 *    resources/instruction-version-record.ts use). The body carries the caller
 *    id and nothing else: it is byte-identical whether the target id exists or
 *    not, so a lock miss never reveals stored-row state (Sherlock S7).
 *  - `write_outcome_unknown` — the id's last owned write settled with an
 *    unresolved outcome (a commit that may or may not have landed).
 *    {@link markMemoryWriteOutcomeUnknown} records the marker; only a process
 *    restart clears it, and that restart is the fencing step. The marker is
 *    process-local (per module instance), the same scope the lock itself has.
 *
 * Acquisition is sorted and deduplicated so two writers that hold two ids in
 * common cannot deadlock. A partial acquisition is released before the wait, so
 * a writer never blocks on the next key while holding one. An automatic writer
 * uses {@link withMemoryWriteLockOnce}: one attempt, no wait.
 */

import type { KeyLockStore } from "./key-lock.js";

/** The `Memory.primaryStore` key namespace (flair#2478). */
export const MEMORY_LOCK_NAMESPACE = "memory";
/** The owner-verb busy budget: {@link MEMORY_LOCK_ATTEMPTS} × {@link MEMORY_LOCK_WAIT_MS}. */
export const MEMORY_LOCK_ATTEMPTS = 200;
export const MEMORY_LOCK_WAIT_MS = 10;
/** The lock-miss error code. */
export const MEMORY_BUSY_ERROR = "memory_busy";
/** The unresolved-outcome error code. */
export const WRITE_OUTCOME_UNKNOWN_ERROR = "write_outcome_unknown";

/** Process-local per-id unknown-outcome markers (Kern pin 2 / Flint decision). */
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

/** One attempt, no wait — the automatic-writer shape. A held lock or a marker
 *  answers `busy`/`unknown` and the writer reports skipped. */
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
        // A marker set by another thread between the check above and this
        // acquisition must still refuse the write.
        const held = normalized.ids.find((id) => memoryWriteOutcomeUnknown(id));
        if (held !== undefined) return { kind: "unknown", id: held };
        return { kind: "done", value: await fn(scope) };
      } finally {
        // Release only after `fn`'s owned transaction settled: the lock spans
        // the commit.
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
    JSON.stringify({ error: WRITE_OUTCOME_UNKNOWN_ERROR, message: "the last write to this id settled with an unknown outcome; retry after the process restarts" }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}
