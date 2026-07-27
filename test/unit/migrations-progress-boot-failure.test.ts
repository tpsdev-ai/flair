/**
 * migrations-progress-boot-failure.test.ts — `markIdleMigrationsFailed`
 * (flair#812), the lever the boot path uses to turn an instance-wide
 * "the cycle could not run" into the per-migration state `flair doctor` and
 * `flair quality`'s `instance.migrationsClean` actually read.
 *
 * The interesting property is the RESTRICTION, not the marking. A cycle can
 * fail after some migrations have already reached a terminal state (the
 * pre-hash path halts each candidate with its own precise reason and THEN
 * reports cycle failure), so a blanket overwrite would replace a specific
 * `halted` — which the runner retries on the next boot per its documented
 * contract — with a generic `failed`, and would flip a migration that
 * genuinely completed this cycle to failed. That would be a downgrade in
 * fidelity dressed up as extra reporting.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  markIdleMigrationsFailed,
  listMigrationProgress,
  seedIdleProgress,
  setMigrationProgress,
  _resetProgressForTests,
} from "../../resources/migrations/progress.ts";

const REASON = "no writable migration data directory — tried /a (EACCES); /b (EROFS)";

beforeEach(() => {
  _resetProgressForTests();
});

describe("markIdleMigrationsFailed", () => {
  it("marks every migration that never started, carrying the reason", () => {
    seedIdleProgress(["embedding-stamp", "graph-heal", "visibility-backfill"]);

    const marked = markIdleMigrationsFailed(
      ["embedding-stamp", "graph-heal", "visibility-backfill"],
      REASON,
    );

    expect(marked.sort()).toEqual(["embedding-stamp", "graph-heal", "visibility-backfill"]);
    for (const p of listMigrationProgress()) {
      expect(p.state).toBe("failed");
      expect(p.reason).toBe(REASON);
    }
  });

  it("never overwrites a halted migration — that state is more specific AND is what gets retried", () => {
    seedIdleProgress(["a", "b"]);
    setMigrationProgress({ id: "a", rowsDone: 3, rowsRemaining: 7, state: "halted", reason: "blocked on disk: …" });

    const marked = markIdleMigrationsFailed(["a", "b"], REASON);

    expect(marked).toEqual(["b"]);
    const a = listMigrationProgress().find((p) => p.id === "a");
    expect(a?.state).toBe("halted");
    expect(a?.reason).toBe("blocked on disk: …");
    expect(a?.rowsDone).toBe(3);
  });

  it("never overwrites a migration that completed in this same cycle", () => {
    seedIdleProgress(["done", "never-ran"]);
    setMigrationProgress({ id: "done", rowsDone: 12, rowsRemaining: 0, state: "completed" });

    const marked = markIdleMigrationsFailed(["done", "never-ran"], REASON);

    expect(marked).toEqual(["never-ran"]);
    expect(listMigrationProgress().find((p) => p.id === "done")?.state).toBe("completed");
    expect(listMigrationProgress().find((p) => p.id === "never-ran")?.state).toBe("failed");
  });

  it("marks an id with no progress entry at all (nothing has spoken for it either)", () => {
    expect(markIdleMigrationsFailed(["unseeded"], REASON)).toEqual(["unseeded"]);
    expect(listMigrationProgress().find((p) => p.id === "unseeded")?.state).toBe("failed");
  });

  it("returns an empty list when every migration already reached a terminal state", () => {
    seedIdleProgress(["x"]);
    setMigrationProgress({ id: "x", rowsDone: 0, rowsRemaining: 0, state: "running" });
    expect(markIdleMigrationsFailed(["x"], REASON)).toEqual([]);
  });
});
