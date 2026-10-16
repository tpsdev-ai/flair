/**
 * memory-lock-double.ts — a per-key lock for a unit-test stand-in of the Memory
 * table (flair#2478).
 *
 * Memory PUT/PATCH require a target id and `Memory.primaryStore`'s per-id lock. A store
 * with no lock is refused 503 `memory_lock_unavailable`: there is no production
 * fallback that runs a write unserialized. A unit test whose Harper mock stands
 * in for the Memory table and drives those verbs therefore injects this lock as
 * the mock table's `primaryStore`, the shape Harper's primary store has: a
 * non-blocking `tryLock(key)` / `unlock(key)` per key, shared by every caller in
 * the process.
 */
export interface MemoryLockDouble {
  tryLock(key: unknown): boolean;
  unlock(key: unknown): void;
  resetReadTxn(): void;
  /** The keys currently held, as JSON text. */
  readonly held: ReadonlySet<string>;
}

export function memoryLockDouble(): MemoryLockDouble {
  const held = new Set<string>();
  return {
    held,
    tryLock(key: unknown): boolean {
      const k = JSON.stringify(key);
      if (held.has(k)) return false;
      held.add(k);
      return true;
    },
    unlock(key: unknown): void {
      held.delete(JSON.stringify(key));
    },
    resetReadTxn(): void {},
  };
}

/**
 * A lock that grants every key, even one already held: it does NOT serialize.
 * Only for a unit test that must put two same-id writers past the per-id lock
 * at once to reach a check beneath it (the skill-version write's stale-target
 * refusal, `skill_target_changed`). Production PUT/PATCH require a target id
 * and a lock before entering the verb body; a joined transaction can commit
 * after the key is released.
 */
export function nonSerializingLockDouble(): Omit<MemoryLockDouble, "held"> {
  return { tryLock: () => true, unlock: () => {}, resetReadTxn: () => {} };
}
