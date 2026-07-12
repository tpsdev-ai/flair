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
 */
import { databases } from "@harperfast/harper";
import type { Migration, RunBatchResult } from "./types.js";

export const SYNTHETIC_MIGRATION_ID = "synthetic-ci-schema-stamp";
export const RESERVED_TEST_AGENT_ID = "__flair_migration_synthetic_test_agent__";
export const SYNTHETIC_TARGET_MARKER = `${SYNTHETIC_MIGRATION_ID}-done`;

export const ENABLE_TEST_MIGRATIONS_ENV = "FLAIR_ENABLE_TEST_MIGRATIONS";

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
}

function defaultMemoryTable(): MemoryTableLike {
  return (databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory;
}

export function createSyntheticTestMigration(getTable: () => MemoryTableLike = defaultMemoryTable): Migration {
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
        const existing = await table.get(id);
        if (!existing) continue;
        if (existing.source === SYNTHETIC_TARGET_MARKER) continue; // already stamped — idempotent skip

        await table.put({ ...existing, source: SYNTHETIC_TARGET_MARKER });
        touchedIds.push(id);
      }

      return { processed: touchedIds.length, touchedIds };
    },
  };
}
