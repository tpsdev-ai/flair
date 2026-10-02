/**
 * memory-integrity.test.ts — the out-of-store watcher's checkpoint and
 * comparison logic (flair#2213), pure and Harper-free.
 *
 * The live behaviour (a real ephemeral Harper, an ops-API delete beneath Flair,
 * a restart) is in test/integration/memory-integrity-watcher.test.ts.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compareScan,
  emptyCheckpoint,
  readCheckpoint,
  writeCheckpoint,
  tallyByDurability,
  unknownVerdict,
  integrityCheckpointPath,
  type IntegrityCheckpoint,
} from "../../src/lib/memory-integrity.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = join(tmpdir(), `flair-2213-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

const rowsOf = (rows: Array<[string, string]>) => rows.map(([id, durability]) => ({ id, durability }));
const baseCheckpoint = (rows: Array<[string, string]>, at = "2026-10-02T00:00:00.000Z"): IntegrityCheckpoint =>
  emptyCheckpoint(at, rowsOf(rows));

describe("checkpoint file I/O", () => {
  test("write is atomic, 0600, and round-trips", () => {
    const d = tmp();
    const path = join(d, "integrity-checkpoint.json");
    const cp = baseCheckpoint([["m1", "permanent"], ["m2", "standard"]]);
    writeCheckpoint(path, cp);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // No temp file left behind.
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const read = readCheckpoint(path);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.checkpoint).toEqual(cp);
  });

  test("a missing file is `absent`; a corrupt file is `unreadable` (never absent)", () => {
    const d = tmp();
    expect(readCheckpoint(join(d, "nope.json"))).toEqual({ kind: "absent" });
    const bad = join(d, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(readCheckpoint(bad).kind).toBe("unreadable");
    const wrongShape = join(d, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ version: 2, ids: {} }));
    expect(readCheckpoint(wrongShape).kind).toBe("unreadable");
  });

  test("integrityCheckpointPath is under the flair config dir", () => {
    expect(integrityCheckpointPath("/home/op")).toBe("/home/op/.flair/integrity-checkpoint.json");
  });
});

describe("compareScan", () => {
  const cp = baseCheckpoint([["p1", "permanent"], ["s1", "persistent"], ["std1", "standard"], ["e1", "ephemeral"]]);

  test("no change is healthy", () => {
    const v = compareScan({
      checkpoint: cp,
      rows: rowsOf([["p1", "permanent"], ["s1", "persistent"], ["std1", "standard"], ["e1", "ephemeral"]]),
      deletions: [],
      scannedAt: "2026-10-02T01:00:00.000Z",
    });
    expect(v.status).toBe("healthy");
    expect(v.losses).toEqual([]);
  });

  test("a durable id gone with NO deletion record is an alert naming the id", () => {
    const v = compareScan({
      checkpoint: cp,
      rows: rowsOf([["s1", "persistent"], ["std1", "standard"], ["e1", "ephemeral"]]),
      deletions: [],
      scannedAt: "2026-10-02T01:00:00.000Z",
    });
    expect(v.status).toBe("alert");
    expect(v.losses).toEqual([{ id: "p1", tier: "permanent" }]);
    expect(v.unexplainedDecrease).toEqual({ permanent: 1 });
  });

  test("a durable id gone WITH a deletion record is attributed, not alerted", () => {
    const v = compareScan({
      checkpoint: cp,
      rows: rowsOf([["s1", "persistent"], ["std1", "standard"], ["e1", "ephemeral"]]),
      deletions: [{ id: "delete-p1", memoryId: "p1", durability: "permanent", at: "2026-10-02T00:30:00.000Z" }],
      scannedAt: "2026-10-02T01:00:00.000Z",
    });
    expect(v.status).toBe("healthy");
    expect(v.attributedDeletes).toEqual([{ id: "p1", tier: "permanent", at: "2026-10-02T00:30:00.000Z" }]);
    expect(v.losses).toEqual([]);
  });

  test("a tier change is observed, not alerted", () => {
    const v = compareScan({
      checkpoint: cp,
      rows: rowsOf([["p1", "standard"], ["s1", "persistent"], ["std1", "standard"], ["e1", "ephemeral"]]),
      deletions: [],
      scannedAt: "2026-10-02T01:00:00.000Z",
    });
    // permanent drop (1) is explained by the change out of permanent.
    expect(v.status).toBe("healthy");
    expect(v.tierChanges).toEqual([{ id: "p1", from: "permanent", to: "standard" }]);
  });

  test("an equal-size replacement (one durable removed, one added) is caught by the id set", () => {
    const v = compareScan({
      checkpoint: cp,
      rows: rowsOf([["p1-new", "permanent"], ["s1", "persistent"], ["std1", "standard"], ["e1", "ephemeral"]]),
      deletions: [],
      scannedAt: "2026-10-02T01:00:00.000Z",
    });
    // Same permanent COUNT (1 -> 1) — the count alone would miss it.
    expect(v.counts.permanent).toBe(1);
    expect(v.status).toBe("alert");
    expect(v.losses).toEqual([{ id: "p1", tier: "permanent" }]);
  });

  test("a missing non-durable id with no record is not alerted", () => {
    const v = compareScan({
      checkpoint: cp,
      rows: rowsOf([["p1", "permanent"], ["s1", "persistent"], ["e1", "ephemeral"]]),
      deletions: [],
      scannedAt: "2026-10-02T01:00:00.000Z",
    });
    expect(v.status).toBe("healthy");
  });

  test("a durable count drop the id set does NOT explain is still an alert", () => {
    // Checkpoint counts say 3 permanent, but its id set has only one: the count
    // drop (3 -> 1) exceeds what the id diff explains.
    const inconsistent: IntegrityCheckpoint = {
      version: 1,
      historyIds: [],
      scannedAt: "2026-10-02T00:00:00.000Z",
      byDurability: { permanent: 3, persistent: 1, standard: 1, ephemeral: 1 },
      ids: { p1: "permanent", s1: "persistent", std1: "standard", e1: "ephemeral" },
    };
    const v = compareScan({
      checkpoint: inconsistent,
      rows: rowsOf([["p1", "permanent"], ["s1", "persistent"], ["std1", "standard"], ["e1", "ephemeral"]]),
      deletions: [],
      scannedAt: "2026-10-02T01:00:00.000Z",
    });
    expect(v.status).toBe("alert");
    expect(v.unexplainedDecrease).toEqual({ permanent: 2 });
  });

  test("a failed read is UNKNOWN, with no counts and no checkpoint write", () => {
    const v = unknownVerdict("connection refused", "2026-10-02T01:00:00.000Z");
    expect(v.status).toBe("unknown");
    expect(v.checkpointWritten).toBe(false);
    expect(v.reason).toBe("connection refused");
  });

  test("tallyByDurability buckets missing durability as standard", () => {
    expect(tallyByDurability([{ id: "a", durability: "permanent" }, { id: "b", durability: "" }])).toEqual({
      permanent: 1, persistent: 0, standard: 1, ephemeral: 0,
    });
  });
});


describe("checkpoint regressions", () => {
  test("delete, recreate, checkpoint, raw delete remains an unexplained loss", () => {
    const old = { id: "old-delete", memoryId: "recreated", at: "2099-01-01" };
    const cp = emptyCheckpoint("2026-10-02", rowsOf([["recreated", "permanent"]]), [old]);
    const verdict = compareScan({ checkpoint: cp, rows: [], deletions: [old], scannedAt: "2026-10-03" });
    expect(verdict.status).toBe("alert");
    expect(verdict.losses).toEqual([{ id: "recreated", tier: "permanent" }]);
    const fresh = { ...old, id: "fresh-delete", at: "1900-01-01" };
    expect(compareScan({ checkpoint: cp, rows: [], deletions: [old, fresh], scannedAt: "2026-10-03" }).status).toBe("healthy");
  });

  test("__proto__ survives checkpoint I/O and an equal-size replacement alerts", () => {
    const cp = emptyCheckpoint("now", rowsOf([["__proto__", "permanent"]]));
    const path = join(tmp(), "checkpoint.json");
    writeCheckpoint(path, cp);
    const read = readCheckpoint(path);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") throw new Error("checkpoint unreadable");
    expect(Object.getPrototypeOf(read.checkpoint.ids)).toBeNull();
    const verdict = compareScan({ checkpoint: read.checkpoint, rows: rowsOf([["replacement", "permanent"]]), deletions: [], scannedAt: "later" });
    expect(verdict.status).toBe("alert");
    expect(verdict.losses).toEqual([{ id: "__proto__", tier: "permanent" }]);
  });

  test("malformed checkpoint ID maps and history watermarks are unreadable", () => {
    const cp = baseCheckpoint([["m1", "permanent"]]);
    const path = join(tmp(), "checkpoint.json");
    for (const patch of [{ ids: [] }, { ids: { m1: {} } }, { ids: { "": "permanent" } }, { historyIds: [42] }, { historyIds: undefined }]) {
      writeFileSync(path, JSON.stringify({ ...cp, ...patch }));
      expect(readCheckpoint(path).kind).toBe("unreadable");
    }
  });
});
