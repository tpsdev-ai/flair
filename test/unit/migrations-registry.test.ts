/**
 * migrations-registry.test.ts — resources/migrations/registry.ts: proves
 * embedding-stamp always registers, the synthetic CI-only migration
 * registers ONLY under its exact opt-in env var, and duplicate ids are
 * rejected.
 */
import { describe, it, expect, mock } from "bun:test";

mock.module("@harperfast/harper", () => ({ databases: {}, Resource: class {} }));

const { buildRegistry, MigrationRegistry } = await import("../../resources/migrations/registry.ts");
const { EMBEDDING_STAMP_ID } = await import("../../resources/migrations/embedding-stamp.ts");
const { SYNTHETIC_MIGRATION_ID, ENABLE_TEST_MIGRATIONS_ENV } = await import("../../resources/migrations/synthetic-test-migration.ts");

describe("buildRegistry — production default (no env override)", () => {
  it("registers ONLY embedding-stamp when FLAIR_ENABLE_TEST_MIGRATIONS is unset — the synthetic variant never ships active", () => {
    const registry = buildRegistry({});
    const ids = registry.list().map((m) => m.id);
    expect(ids).toEqual([EMBEDDING_STAMP_ID]);
    expect(ids).not.toContain(SYNTHETIC_MIGRATION_ID);
  });

  it("registers only embedding-stamp for a realistic prod env snapshot (PATH, HOME, etc. present, flag absent)", () => {
    const registry = buildRegistry({ PATH: "/usr/bin", HOME: "/home/flair", NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(registry.list().map((m) => m.id)).toEqual([EMBEDDING_STAMP_ID]);
  });
});

describe("buildRegistry — CI/test opt-in", () => {
  it("registers BOTH migrations when the exact opt-in env var is \"1\"", () => {
    const registry = buildRegistry({ [ENABLE_TEST_MIGRATIONS_ENV]: "1" } as NodeJS.ProcessEnv);
    const ids = registry.list().map((m) => m.id);
    expect(ids).toContain(EMBEDDING_STAMP_ID);
    expect(ids).toContain(SYNTHETIC_MIGRATION_ID);
    expect(ids).toHaveLength(2);
  });

  it("does NOT register the synthetic variant for a near-miss value", () => {
    const registry = buildRegistry({ [ENABLE_TEST_MIGRATIONS_ENV]: "true" } as NodeJS.ProcessEnv);
    expect(registry.list().map((m) => m.id)).toEqual([EMBEDDING_STAMP_ID]);
  });
});

describe("MigrationRegistry — core operations", () => {
  it("register()/list()/get() round-trip", () => {
    const registry = new MigrationRegistry();
    const fake = {
      id: "fake-1",
      riskClass: "derived-only" as const,
      affectsTables: ["Memory" as const],
      detect: async () => false,
      countPending: async () => 0,
      run: async () => ({ processed: 0, touchedIds: [] }),
    };
    registry.register(fake);
    expect(registry.list()).toEqual([fake]);
    expect(registry.get("fake-1")).toBe(fake);
    expect(registry.get("does-not-exist")).toBeUndefined();
  });

  it("throws on a duplicate migration id — registration collisions must be caught, not silently shadow", () => {
    const registry = new MigrationRegistry();
    const makeFake = (id: string) => ({
      id,
      riskClass: "derived-only" as const,
      affectsTables: ["Memory" as const],
      detect: async () => false,
      countPending: async () => 0,
      run: async () => ({ processed: 0, touchedIds: [] }),
    });
    registry.register(makeFake("dup"));
    expect(() => registry.register(makeFake("dup"))).toThrow(/already registered/);
  });
});
