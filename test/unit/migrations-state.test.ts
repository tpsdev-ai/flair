/**
 * migrations-state.test.ts — resources/migrations/state.ts: the on-disk
 * "last migration completed at version X" marker that lets the runner skip
 * calling detect() ENTIRELY once a migration has already succeeded at the
 * currently running version (Kern's detect() short-circuit fallback).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readMigrationState,
  writeMigrationStateEntry,
  isShortCircuited,
  defaultStatePath,
} from "../../resources/migrations/state.ts";
import { acquireMigrationLock } from "../../resources/migrations/lock.ts";
import { seedMigrationStateEntry } from "../helpers/migration-state.ts";

let root: string;
let statePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-migration-state-test-"));
  statePath = join(root, ".migrations", "state.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readMigrationState", () => {
  it("returns {} when the file doesn't exist yet (never throws)", () => {
    expect(readMigrationState(statePath)).toEqual({});
  });

  it("returns {} for a corrupt/unparseable file (never throws)", () => {
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(root, ".migrations"), { recursive: true });
    writeFileSync(statePath, "{not valid json");
    expect(readMigrationState(statePath)).toEqual({});
  });
});

describe("writeMigrationStateEntry / readMigrationState round-trip", () => {
  it("writes and reads back an entry, at 0700 dir / 0600 file", async () => {
    await seedMigrationStateEntry(statePath, "embedding-stamp", {
      completedAtVersion: "0.22.0",
      completedAt: "2026-01-01T00:00:00.000Z",
      lastOutcome: "success",
      rowsProcessed: 10,
      rowsRemaining: 0,
    });
    const state = readMigrationState(statePath);
    expect(state["embedding-stamp"]).toEqual({
      completedAtVersion: "0.22.0",
      completedAt: "2026-01-01T00:00:00.000Z",
      lastOutcome: "success",
      rowsProcessed: 10,
      rowsRemaining: 0,
    });
    expect(statSync(join(root, ".migrations")).mode & 0o777).toBe(0o700);
  });

  it("preserves OTHER migrations' entries when writing a new one (read-merge-write, not overwrite)", async () => {
    await seedMigrationStateEntry(statePath, "migration-a", { lastOutcome: "success", completedAtVersion: "0.1.0" });
    await seedMigrationStateEntry(statePath, "migration-b", { lastOutcome: "halted", reason: "blocked on disk" });

    const state = readMigrationState(statePath);
    expect(state["migration-a"].lastOutcome).toBe("success");
    expect(state["migration-b"].lastOutcome).toBe("halted");
    expect(state["migration-b"].reason).toBe("blocked on disk");
  });

  it("overwrites a migration's OWN prior entry (latest write wins for that id)", async () => {
    await seedMigrationStateEntry(statePath, "m", { lastOutcome: "halted", reason: "first halt" });
    await seedMigrationStateEntry(statePath, "m", { lastOutcome: "success", completedAtVersion: "0.2.0" });
    const state = readMigrationState(statePath);
    expect(state["m"].lastOutcome).toBe("success");
    expect(state["m"].reason).toBeUndefined();
  });
});

describe("writeMigrationStateEntry — lock handle (flair#2866)", () => {
  it("refuses with a named error and writes nothing when no handle is supplied", async () => {
    let error: unknown;
    try {
      await (writeMigrationStateEntry as unknown as (...args: unknown[]) => Promise<void>)(statePath, "m", { lastOutcome: "success" });
    } catch (err) {
      error = err;
    }
    expect((error as Error)?.name).toBe("MigrationStateWriteRefusedError");
    expect(existsSync(statePath)).toBe(false);
  });

  it("refuses a forged object with matching fields", async () => {
    const forged = {
      acquired: true as const,
      lockPath: join(root, ".migrations", "lock"),
      holder: { pid: process.pid, hostname: "host-a", startedAt: "2026-01-01T00:00:00.000Z" },
      release: () => {},
      touch: () => {},
    };
    let error: unknown;
    try {
      await (writeMigrationStateEntry as unknown as (...args: unknown[]) => Promise<void>)(statePath, "m", { lastOutcome: "success" }, forged);
    } catch (err) {
      error = err;
    }
    expect((error as Error)?.name).toBe("MigrationStateWriteRefusedError");
    expect((error as Error)?.message).toContain("no held migration lock handle");
    expect(existsSync(statePath)).toBe(false);
  });

  it("refuses a released handle", async () => {
    const lock = acquireMigrationLock({ lockPath: join(root, ".migrations", "lock") });
    if (!lock.acquired) throw new Error(`migration lock unavailable: ${lock.reason}`);
    lock.release();

    let error: unknown;
    try {
      await writeMigrationStateEntry(statePath, "m", { lastOutcome: "success" }, lock);
    } catch (err) {
      error = err;
    }
    expect((error as Error)?.name).toBe("MigrationStateWriteRefusedError");
    expect((error as Error)?.message).toContain("already released");
    expect(existsSync(statePath)).toBe(false);
  });

  it("refuses a live handle for a different lock path", async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "flair-migration-state-other-"));
    const other = acquireMigrationLock({ lockPath: join(otherRoot, "lock") });
    if (!other.acquired) throw new Error(`migration lock unavailable: ${other.reason}`);
    try {
      let error: unknown;
      try {
        await writeMigrationStateEntry(statePath, "m", { lastOutcome: "success" }, other);
      } catch (err) {
        error = err;
      }
      expect((error as Error)?.name).toBe("MigrationStateWriteRefusedError");
      expect((error as Error)?.message).toContain("not the state file's lock");
      expect(existsSync(statePath)).toBe(false);
    } finally {
      other.release();
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("accepts a live handle for the state file's designated lock", async () => {
    const lock = acquireMigrationLock({ lockPath: join(root, ".migrations", "lock") });
    if (!lock.acquired) throw new Error(`migration lock unavailable: ${lock.reason}`);
    try {
      await writeMigrationStateEntry(statePath, "m", { lastOutcome: "success" }, lock);
      expect(readMigrationState(statePath)["m"].lastOutcome).toBe("success");
    } finally {
      lock.release();
    }
  });

  it("refuses with a named error when the lock file was removed after acquisition, before the write", async () => {
    await seedMigrationStateEntry(statePath, "m", { lastOutcome: "halted", reason: "old" });
    const lock = acquireMigrationLock({ lockPath: join(root, ".migrations", "lock") });
    if (!lock.acquired) throw new Error(`migration lock unavailable: ${lock.reason}`);
    try {
      unlinkSync(lock.lockPath);
      let error: unknown;
      try {
        await writeMigrationStateEntry(statePath, "m", { lastOutcome: "success" }, lock);
      } catch (err) {
        error = err;
      }
      expect((error as Error)?.name).toBe("MigrationStateWriteRefusedError");
      expect(readMigrationState(statePath)["m"].lastOutcome).toBe("halted");
    } finally {
      lock.release();
    }
  });
});

describe("isShortCircuited", () => {
  it("true only when lastOutcome is success AND completedAtVersion matches the running version", () => {
    const state = { m: { lastOutcome: "success" as const, completedAtVersion: "0.2.0" } };
    expect(isShortCircuited(state, "m", "0.2.0")).toBe(true);
  });

  it("false when the running version has moved past the completed version (a new release may have new pending rows)", () => {
    const state = { m: { lastOutcome: "success" as const, completedAtVersion: "0.2.0" } };
    expect(isShortCircuited(state, "m", "0.3.0")).toBe(false);
  });

  it("false for a HALTED outcome — a halt must always retry, never be permanently short-circuited", () => {
    const state = { m: { lastOutcome: "halted" as const, completedAtVersion: "0.2.0" } };
    expect(isShortCircuited(state, "m", "0.2.0")).toBe(false);
  });

  it("false for a FAILED outcome", () => {
    const state = { m: { lastOutcome: "failed" as const } };
    expect(isShortCircuited(state, "m", "0.2.0")).toBe(false);
  });

  it("false when there's no entry for this migration id at all", () => {
    expect(isShortCircuited({}, "unknown-migration", "0.2.0")).toBe(false);
  });
});

describe("defaultStatePath", () => {
  it("lives under <dataDir>/.migrations/state.json", () => {
    expect(defaultStatePath("/some/data/dir")).toBe(join("/some/data/dir", ".migrations", "state.json"));
  });
});
