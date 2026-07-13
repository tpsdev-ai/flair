/**
 * migrations-snapshot.test.ts — resources/migrations/snapshot.ts's
 * risk-scoped snapshot creation and retention pruning.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createMigrationSnapshot,
  pruneMigrationSnapshots,
  DEFAULT_SNAPSHOT_KEEP_LAST,
  DEFAULT_SNAPSHOT_MAX_AGE_MS,
} from "../../resources/migrations/snapshot.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-migration-snapshot-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createMigrationSnapshot — scope content", () => {
  it("metadata-only writes just the manifest (0700 dir, no schema/pointers files)", () => {
    const result = createMigrationSnapshot(
      {
        migrationId: "embedding-stamp",
        scope: "metadata-only",
        rowCounts: { Memory: 42 },
        fromVersion: "0.1.0",
        toVersion: "0.2.0",
      },
      { snapshotRoot: root, now: () => new Date("2026-01-01T00:00:00.000Z") },
    );
    expect(existsSync(result.dir)).toBe(true);
    expect(statSync(result.dir).mode & 0o777).toBe(0o700);
    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
    expect(manifest.migrationId).toBe("embedding-stamp");
    expect(manifest.scope).toBe("metadata-only");
    expect(manifest.rowCounts).toEqual({ Memory: 42 });
    expect(existsSync(join(result.dir, "schema.json"))).toBe(false);
    expect(existsSync(join(result.dir, "pointers.jsonl"))).toBe(false);
  });

  it("schema+metadata additionally writes schema.json (field NAMES only, never row data)", () => {
    const result = createMigrationSnapshot(
      {
        migrationId: "synthetic-ci-schema-stamp",
        scope: "schema+metadata",
        rowCounts: { Memory: 3 },
        fromVersion: "0.1.0",
        toVersion: "0.2.0",
        schema: { Memory: ["id", "content", "agentId"] },
      },
      { snapshotRoot: root, now: () => new Date() },
    );
    const schemaPath = join(result.dir, "schema.json");
    expect(existsSync(schemaPath)).toBe(true);
    expect(JSON.parse(readFileSync(schemaPath, "utf-8"))).toEqual({ Memory: ["id", "content", "agentId"] });
  });

  it("pointers+metadata writes pointer-only rows (id/supersedes/validFrom/validTo — never content)", () => {
    const result = createMigrationSnapshot(
      {
        migrationId: "content-transform-example",
        scope: "pointers+metadata",
        rowCounts: { Memory: 2 },
        fromVersion: "0.1.0",
        toVersion: "0.2.0",
        pointers: [
          { id: "m1", supersedes: null, validFrom: "2026-01-01", validTo: null },
          { id: "m2", supersedes: "m1", validFrom: "2026-01-02", validTo: null },
        ],
      },
      { snapshotRoot: root, now: () => new Date() },
    );
    const pointersPath = join(result.dir, "pointers.jsonl");
    expect(existsSync(pointersPath)).toBe(true);
    const body = readFileSync(pointersPath, "utf-8");
    expect(body).not.toContain("content"); // never leaks a "content" key/value
    const lines = body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { id: "m1", supersedes: null, validFrom: "2026-01-01", validTo: null },
      { id: "m2", supersedes: "m1", validFrom: "2026-01-02", validTo: null },
    ]);
  });

  it("two snapshots for the same migration id at different instants land in distinct directories", async () => {
    const a = createMigrationSnapshot(
      { migrationId: "m", scope: "metadata-only", rowCounts: {}, fromVersion: "0.1.0", toVersion: "0.2.0" },
      { snapshotRoot: root, now: () => new Date("2026-01-01T00:00:00.000Z") },
    );
    const b = createMigrationSnapshot(
      { migrationId: "m", scope: "metadata-only", rowCounts: {}, fromVersion: "0.1.0", toVersion: "0.2.0" },
      { snapshotRoot: root, now: () => new Date("2026-01-01T00:00:01.000Z") },
    );
    expect(a.dir).not.toBe(b.dir);
  });
});

describe("pruneMigrationSnapshots — keep-last-3 AND 30-day, union (more permissive wins)", () => {
  function makeSnapshotDirAt(name: string, ageMs: number): void {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const t = new Date(Date.now() - ageMs);
    utimesSync(dir, t, t);
  }

  it("keeps the 3 most recent even if older than 30 days would otherwise prune them on age alone (last-3 floor)", () => {
    // All 3 are ancient (well past 30 days) but are the ONLY 3 that exist —
    // last-3 floor keeps them regardless of age.
    const day = 24 * 3600 * 1000;
    makeSnapshotDirAt("s1", 100 * day);
    makeSnapshotDirAt("s2", 90 * day);
    makeSnapshotDirAt("s3", 80 * day);

    const removed = pruneMigrationSnapshots(root, { keepLast: 3, maxAgeMs: 30 * day });
    expect(removed).toEqual([]);
  });

  it("keeps a 4th snapshot that's within 30 days even though it's outside the last-3 floor (more-permissive union)", () => {
    const day = 24 * 3600 * 1000;
    makeSnapshotDirAt("newest1", 1 * day);
    makeSnapshotDirAt("newest2", 2 * day);
    makeSnapshotDirAt("newest3", 3 * day);
    makeSnapshotDirAt("fourth-but-recent", 5 * day); // outside last-3, but only 5 days old

    const removed = pruneMigrationSnapshots(root, { keepLast: 3, maxAgeMs: 30 * day });
    expect(removed).toEqual([]);
  });

  it("prunes a snapshot that is BOTH outside the last-3 floor AND older than 30 days", () => {
    const day = 24 * 3600 * 1000;
    makeSnapshotDirAt("newest1", 1 * day);
    makeSnapshotDirAt("newest2", 2 * day);
    makeSnapshotDirAt("newest3", 3 * day);
    makeSnapshotDirAt("ancient", 60 * day); // outside last-3 AND past 30 days

    const removed = pruneMigrationSnapshots(root, { keepLast: 3, maxAgeMs: 30 * day });
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("ancient");
    expect(existsSync(join(root, "ancient"))).toBe(false);
    expect(existsSync(join(root, "newest1"))).toBe(true);
  });

  it("defaults to keepLast=3 / maxAgeMs=30 days when not specified", () => {
    expect(DEFAULT_SNAPSHOT_KEEP_LAST).toBe(3);
    expect(DEFAULT_SNAPSHOT_MAX_AGE_MS).toBe(30 * 24 * 3600 * 1000);
  });

  it("no-ops (empty removed list) when the snapshot root doesn't exist yet", () => {
    const removed = pruneMigrationSnapshots(join(root, "does-not-exist"));
    expect(removed).toEqual([]);
  });

  it("no-ops when there's nothing to prune (fewer than keepLast and all fresh)", () => {
    makeSnapshotDirAt("only-one", 0);
    const removed = pruneMigrationSnapshots(root);
    expect(removed).toEqual([]);
  });
});
