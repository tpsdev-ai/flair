/**
 * registry.ts — the MigrationRegistry: an ordered list of registered
 * migrations. embedding-stamp and graph-heal always register; the synthetic
 * CI-only variant registers ONLY when shouldRegisterSyntheticMigration() is
 * true (see synthetic-test-migration.ts's doc for the exact gating rule).
 */
import { createEmbeddingStampMigration } from "./embedding-stamp.js";
import { createGraphHealMigration } from "./graph-heal.js";
import { createSyntheticTestMigration, shouldRegisterSyntheticMigration } from "./synthetic-test-migration.js";
import type { Migration } from "./types.js";

export class MigrationRegistry {
  private readonly migrations: Migration[] = [];

  register(migration: Migration): this {
    if (this.migrations.some((m) => m.id === migration.id)) {
      throw new Error(`migration id already registered: ${migration.id}`);
    }
    this.migrations.push(migration);
    return this;
  }

  list(): readonly Migration[] {
    return this.migrations;
  }

  get(id: string): Migration | undefined {
    return this.migrations.find((m) => m.id === id);
  }
}

/**
 * Builds the production registry. Always includes embedding-stamp and
 * graph-heal; conditionally includes the CI-only synthetic migration.
 *
 * Order note: graph-heal registers AFTER embedding-stamp so that if a boot
 * ever runs both, the (verify-only) recall check ledgers the state AFTER any
 * re-embed work that cycle already applied — never a stale pre-embed reading.
 */
export function buildRegistry(env: NodeJS.ProcessEnv = process.env): MigrationRegistry {
  const registry = new MigrationRegistry();
  registry.register(createEmbeddingStampMigration());
  registry.register(createGraphHealMigration());
  if (shouldRegisterSyntheticMigration(env)) {
    registry.register(createSyntheticTestMigration());
  }
  return registry;
}
