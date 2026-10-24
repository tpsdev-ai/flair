/**
 * synthetic-test-migration.ts — the CI-only migration variant (K&S verdict):
 * "Synthetic CI stamp variant MUST NOT ship — registration conditional on
 * test/CI env; a prod user must never see a spurious ci-variant migration
 * on first boot. Flip later = swap synthetic for real, same lanes/gates."
 *
 * This is the payload the test suite uses to exercise the FULL runner path
 * end-to-end (detect → pre-flight → snapshot → batches → markers →
 * completion gate → post-hash → ledger → prune) — riskClass
 * 'schema-additive' (batch 50, full-envelope completion gate), distinct
 * from embedding-stamp's 'derived-only' so the suite also covers the
 * stricter envelope-comparison gate path via a real (ephemeral) Harper.
 *
 * SAFETY, belt-and-suspenders even though gating (shouldRegisterSyntheticMigration
 * below) is what actually keeps this out of production:
 *   - Registration is conditional on FLAIR_ENABLE_TEST_MIGRATIONS === "1"
 *     (an explicit, exact-match opt-in — never a generic NODE_ENV=test
 *     check, which can be true in contexts nobody intended as "safe to run
 *     a schema-touching test migration").
 *   - Even IF it were somehow registered unconditionally, its detect/run
 *     queries are scoped to a single reserved, never-real agentId
 *     (RESERVED_TEST_AGENT_ID) — it can never see or touch a genuine
 *     agent's memories.
 *
 * Marker: stamps `Memory.source` (an existing, currently-unused-by-any-
 * migration nullable String field — no new schema needed) to a value that
 * encodes the migration id, so "is this row done" is answered entirely by
 * re-reading the row itself (invariant IV: state lives IN the data).
 *
 * The write runs under the row's per-id Memory write lock (flair#2478 slice
 * 3b): one non-waiting acquisition per row, around the write-back's read,
 * decision, write and commit. A held row, an unresolved write outcome on it or
 * a table with no lock writes nothing and is logged; the row stays pending for
 * the next scan.
 */
import { databases } from "harper";
import { writeBackCommittedRow as writeBackCommittedRowImpl, type WriteBackFn } from "../write-back.js";
import { txnPausePoint } from "../txn-pause-point.js";
import { withMemoryWriteLockOnce } from "../memory-write-lock.js";
import type { Migration, RunBatchResult } from "./types.js";

export const SYNTHETIC_MIGRATION_ID = "synthetic-ci-schema-stamp";
export const RESERVED_TEST_AGENT_ID = "__flair_migration_synthetic_test_agent__";
export const SYNTHETIC_TARGET_MARKER = `${SYNTHETIC_MIGRATION_ID}-done`;

export const ENABLE_TEST_MIGRATIONS_ENV = "FLAIR_ENABLE_TEST_MIGRATIONS";

/** The plan's reason for a row a retry of this run's own unconfirmed write
 *  finds already holding {@link SYNTHETIC_TARGET_MARKER}. */
const ALREADY_STAMPED = "already-stamped";

/**
 * Exact-match opt-in — see the module doc. Exported so both the registry
 * and a unit test can assert the exact condition, independent of the
 * registry's own wiring.
 */
export function shouldRegisterSyntheticMigration(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENABLE_TEST_MIGRATIONS_ENV] === "1";
}

export interface MemoryTableLike {
  search(query: unknown): AsyncIterable<Record<string, unknown>>;
  get(id: string): Promise<Record<string, unknown> | null>;
  put(content: Record<string, unknown>): Promise<unknown>;
  /** The table's per-id key lock (flair#2478); absent on a unit-test double unless it supplies one. */
  primaryStore?: unknown;
}

function defaultMemoryTable(): MemoryTableLike {
  return (databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory;
}

export function createSyntheticTestMigration(
  getTable: () => MemoryTableLike = defaultMemoryTable,
  writeBackCommittedRow: WriteBackFn = writeBackCommittedRowImpl,
): Migration {
  function pendingCondition() {
    return [
      { attribute: "agentId", comparator: "equals", value: RESERVED_TEST_AGENT_ID },
      { attribute: "source", comparator: "not_equal", value: SYNTHETIC_TARGET_MARKER },
    ];
  }

  return {
    id: SYNTHETIC_MIGRATION_ID,
    riskClass: "schema-additive",
    affectsTables: ["Memory"],

    async detect(): Promise<boolean> {
      const table = getTable();
      for await (const _row of table.search({ conditions: pendingCondition(), limit: 1 })) {
        return true;
      }
      return false;
    },

    async countPending(): Promise<number> {
      const table = getTable();
      let n = 0;
      for await (const _row of table.search({ conditions: pendingCondition() })) n++;
      return n;
    },

    async run(batchSize: number): Promise<RunBatchResult> {
      const table = getTable();
      const candidates: Record<string, unknown>[] = [];
      for await (const row of table.search({ conditions: pendingCondition(), limit: batchSize })) {
        candidates.push(row);
      }

      const touchedIds: string[] = [];
      for (const row of candidates) {
        const id = String((row as { id?: unknown }).id ?? "");
        if (!id) continue;
        // flair#2478 slice 3b: an automatic writer. It takes the id's per-id
        // Memory write lock with one non-waiting acquisition, so its read,
        // decision, write and commit sit on one committed basis while an owner
        // write holds the id. A held id, an id with an unresolved write outcome
        // or a table with no lock writes nothing here and is reported; the row
        // stays pending for the next boot's scan.
        const locked = await withMemoryWriteLockOnce(table.primaryStore, [id], async () => {
          // flair#2840: a plan skip that names the marker counts as done only
          // when it follows this run's own attempt on this row whose committed
          // outcome was unconfirmed. The fact comes from the write-back's own
          // result, never from the row's value: a marker another writer set
          // between the scan and the read leaves the row uncounted.
          let ownUnconfirmed = false;
          const result = await writeBackCommittedRow(
            table as unknown as Parameters<WriteBackFn>[0],
            id,
            (existing: any) => {
              if (!existing || existing.agentId !== RESERVED_TEST_AGENT_ID) return { skip: true } as const;
              if (existing.source === SYNTHETIC_TARGET_MARKER) {
                return ownUnconfirmed ? { skip: true, reason: ALREADY_STAMPED } : { skip: true };
              }

              // Only `source`: an incremental update, never a
              // full-row put of the row read above (flair#2470).
              return { idempotent: true, update: { source: SYNTHETIC_TARGET_MARKER } };
            },
            {
              label: "synthetic-test-migration",
              pausePre: () => txnPausePoint("synthetic-test-pre"),
              pausePoint: () => txnPausePoint("synthetic-test"),
              pauseAfterStage: () => txnPausePoint("synthetic-test-staged"),
              confirmPoint: () => txnPausePoint("synthetic-test-confirm"),
              expectedRow: row,
              onUnconfirmed: () => { ownUnconfirmed = true; },
            },
          );
          // Test-only: the write-back committed and the lock is still held.
          const committed = txnPausePoint("synthetic-test-committed");
          if (committed) await committed;
          return result;
        }, { phase: "synthetic-test-migration" });
        if (locked.kind !== "done") {
          console.warn(
            "[synthetic-test-migration] %s: the per-id write lock answered %s; the row is left for the next scan",
            id, locked.kind,
          );
          continue;
        }
        if ("skip" in locked.value) {
          // Count only the skip this run's own unconfirmed attempt produced, so
          // rowsDone agrees with the rows this run stamped (flair#2840).
          if (locked.value.reason === ALREADY_STAMPED) touchedIds.push(id);
        } else touchedIds.push(id);
      }

      return { processed: touchedIds.length, touchedIds };
    },
  };
}
