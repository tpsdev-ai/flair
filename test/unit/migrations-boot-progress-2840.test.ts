/**
 * migrations-boot-progress-2840.test.ts — boot seeding against real
 * directories (flair#2840).
 *
 * 1. A boot failure after seeding: a `completed` entry seeded from the state
 *    file is marked `failed` with its unconfirmed count and ids kept, and
 *    `computeQualityReport` reports `migrationsClean: false`.
 * 2. One directory: the earlier candidate's `.migrations` is a symbolic link
 *    to a directory holding a stale state file, so the writable resolver
 *    refuses it; boot seeds from the later candidate that holds the record,
 *    and the read-only resolver then returns that candidate.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { seedBootProgress } from "../../resources/migrations/boot-progress.ts";
import {
  MIGRATION_DATA_DIR_ENV,
  noteSelectedMigrationDataDir,
  resolveMigrationDataDirForRead,
} from "../../resources/migrations/data-dir.ts";
import {
  _resetProgressForTests,
  listMigrationProgress,
  markUnstartedMigrationsFailed,
  setCyclePhase,
  setMigrationProgress,
} from "../../resources/migrations/progress.ts";
import { getMigrationStatusSnapshot } from "../../resources/migrations/status.ts";
import { defaultStatePath, writeMigrationStateEntry } from "../../resources/migrations/state.ts";
import { computeQualityReport } from "../../src/commands/quality.ts";

const REASON = "Memory/Relationship tables never became ready within 30s — this boot's migration cycle was skipped (it retries on the next restart)";

beforeEach(() => {
  _resetProgressForTests();
  noteSelectedMigrationDataDir(null);
});

afterEach(() => {
  _resetProgressForTests();
  noteSelectedMigrationDataDir(null);
});

function writeCompletedWithRecord(dataDir: string, id: string): void {
  writeMigrationStateEntry(defaultStatePath(dataDir), id, {
    completedAtVersion: "0.1.0",
    completedAt: "2026-01-01T00:00:00.000Z",
    lastOutcome: "success",
    rowsProcessed: 3,
    rowsRemaining: 0,
    rowsUnconfirmed: 2,
    unconfirmedIds: ["u1", "u2"],
  });
}

describe("boot failure after seeding from the state file (flair#2840)", () => {
  it("marks a seeded `completed` entry failed, keeps its unconfirmed record, and quality reports not clean", () => {
    const dataDir = tempDir("flair-boot-2840-");
    writeCompletedWithRecord(dataDir, "mig-a");
    const resolved = seedBootProgress(["mig-a"], { [MIGRATION_DATA_DIR_ENV]: dataDir });
    expect(resolved.dataDir).toBe(dataDir);
    expect(listMigrationProgress().find((p) => p.id === "mig-a")?.state).toBe("completed");

    // The two calls reportBootFailure (migration-boot.ts) makes after its log line.
    setCyclePhase("done", REASON);
    expect(markUnstartedMigrationsFailed(["mig-a"], REASON)).toEqual(["mig-a"]);

    const snapshot = getMigrationStatusSnapshot(resolveMigrationDataDirForRead());
    const row = snapshot.migrations.find((m) => m.id === "mig-a");
    expect(row?.state).toBe("failed");
    expect(row?.reason).toBe(REASON);
    expect(row?.rowsUnconfirmed).toBe(2);
    expect(row?.unconfirmedIds).toEqual(["u1", "u2"]);

    const report = computeQualityReport(true, { migrations: snapshot });
    expect(report.instance.migrationsClean).toBe(false);
    expect(report.instance.haltedMigrations.map((m) => m.id)).toEqual(["mig-a"]);
  });

  it("leaves a seeded entry alone once the runner has written it this boot", () => {
    const dataDir = tempDir("flair-boot-2840-");
    writeCompletedWithRecord(dataDir, "mig-a");
    seedBootProgress(["mig-a"], { [MIGRATION_DATA_DIR_ENV]: dataDir });
    setMigrationProgress({ id: "mig-a", rowsDone: 0, rowsRemaining: 0, state: "halted", reason: "pre-flight integrity check failed: x" });

    expect(markUnstartedMigrationsFailed(["mig-a"], REASON)).toEqual([]);
    const row = listMigrationProgress().find((p) => p.id === "mig-a");
    expect(row?.state).toBe("halted");
    expect(row?.reason).toBe("pre-flight integrity check failed: x");
  });
});

describe("boot seeds from the data dir selected for writes (flair#2840)", () => {
  it("skips an earlier refused candidate with a `.migrations` path and seeds from the later writable one", () => {
    const root = tempDir("flair-boot-2840-dirs-");
    const refused = join(root, "refused");
    const staleTarget = join(root, "stale-target");
    const writable = join(root, "writable");
    for (const dir of [refused, staleTarget, writable]) mkdirSync(dir);
    writeMigrationStateEntry(defaultStatePath(staleTarget), "mig-b", {
      completedAtVersion: "0.1.0",
      completedAt: "2026-01-01T00:00:00.000Z",
      lastOutcome: "success",
      rowsProcessed: 9,
      rowsRemaining: 0,
    });
    symlinkSync(join(staleTarget, ".migrations"), join(refused, ".migrations"));
    writeMigrationStateEntry(defaultStatePath(writable), "mig-b", {
      lastOutcome: "halted",
      reason: "completion gate failed: rowsRemaining=0",
      rowsProcessed: 1,
      rowsRemaining: 0,
      rowsUnconfirmed: 1,
      unconfirmedIds: ["u9"],
    });
    const env = { [MIGRATION_DATA_DIR_ENV]: refused, HDB_ROOT: writable } as NodeJS.ProcessEnv;
    // The fixture: before a selection is recorded, the read-only resolver
    // picks the refused candidate.
    expect(resolveMigrationDataDirForRead(env)).toBe(refused);

    const resolved = seedBootProgress(["mig-b"], env);

    expect(resolved.tried[0]).toMatchObject({ dir: refused, ok: false });
    expect(resolved.dataDir).toBe(writable);
    const row = listMigrationProgress().find((p) => p.id === "mig-b");
    expect(row?.state).toBe("halted");
    expect(row?.rowsUnconfirmed).toBe(1);
    expect(row?.unconfirmedIds).toEqual(["u9"]);
    expect(resolveMigrationDataDirForRead(env)).toBe(writable);
  });
});
