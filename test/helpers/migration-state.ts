/**
 * migration-state.ts — seeds a migration-state entry the way production does:
 * under a held migration lock. `writeMigrationStateEntry` refuses a write with
 * no live lock handle (flair#2866), so a test that needs an entry in a real
 * state file takes the same lock and presents it.
 */
import { dirname, join } from "node:path";
import { acquireMigrationLock } from "../../resources/migrations/lock.ts";
import { writeMigrationStateEntry, type MigrationStateEntry } from "../../resources/migrations/state.ts";

export async function seedMigrationStateEntry(
  statePath: string,
  id: string,
  entry: MigrationStateEntry,
): Promise<void> {
  const lock = acquireMigrationLock({ lockPath: join(dirname(statePath), "lock") });
  if (!lock.acquired) throw new Error(`seedMigrationStateEntry: migration lock unavailable: ${lock.reason}`);
  try {
    await writeMigrationStateEntry(statePath, id, entry, lock);
  } finally {
    lock.release();
  }
}
