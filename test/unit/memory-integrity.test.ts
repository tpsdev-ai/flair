/**
 * memory-integrity.test.ts — the out-of-store watcher's checkpoint and
 * comparison logic (flair#2213), pure and Harper-free.
 *
 * The live behaviour (a real ephemeral Harper, an ops-API delete beneath Flair,
 * a restart) is in test/integration/memory-integrity-watcher.test.ts.
 */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
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

const rowsOf = (rows: Array<[string, string]>) => rows.map(([id, durability]) => ({ id, durability, instanceToken: "2026-10-01T00:00:00.000Z" }));
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
    expect(readdirSync(d).filter(name => name.startsWith("integrity-checkpoint.json.tmp-"))).toEqual([]);
    const read = readCheckpoint(path);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.checkpoint).toEqual(cp);
  });

  test("failure after temp creation cleans up and preserves the prior checkpoint", () => {
    const d = tmp();
    const path = join(d, "integrity-checkpoint.json");
    const prior = baseCheckpoint([["m1", "permanent"]]);
    writeCheckpoint(path, prior);
    const original = readFileSync(path, "utf8");
    let createdTemp = "";
    const failure = spyOn(fs, "chmodSync").mockImplementation((tempPath) => {
      createdTemp = String(tempPath);
      expect(createdTemp.startsWith(`${path}.tmp-${process.pid}-`)).toBe(true);
      expect(existsSync(createdTemp)).toBe(true);
      throw new Error("injected chmod failure");
    });
    try {
      expect(() => writeCheckpoint(path, baseCheckpoint([["m2", "persistent"]]))).toThrow("injected chmod failure");
      expect(createdTemp).not.toBe("");
      expect(readdirSync(d).filter(name => name.startsWith("integrity-checkpoint.json.tmp-"))).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readCheckpoint(path)).toEqual({ kind: "ok", checkpoint: prior });
    } finally {
      failure.mockRestore();
    }
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
    expect(v.unexplainedDecrease).toEqual({});
  });

  test("a durable id gone with new history matching its nonempty checkpointed token is attributed", () => {
    const v = compareScan({
      checkpoint: cp,
      rows: rowsOf([["s1", "persistent"], ["std1", "standard"], ["e1", "ephemeral"]]),
      deletions: [{ id: "delete-p1", memoryId: "p1", memoryInstanceToken: "2026-10-01T00:00:00.000Z", durability: "permanent", at: "2026-10-02T00:30:00.000Z" }],
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

  test("an equal-size replacement with a different ID is caught by the id set", () => {
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
      version: 2,
      instanceTokens: Object.fromEntries(rowsOf([["p1", "permanent"], ["s1", "persistent"], ["std1", "standard"], ["e1", "ephemeral"]]).map(row => [row.id, row.instanceToken])),
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

  test("a failed read is UNKNOWN with no checkpoint write", () => {
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
  test("a reappearing row makes the next scan healthy", () => {
    const rows = rowsOf([["m", "permanent"]]);
    const cp = emptyCheckpoint("before", rows);
    expect(compareScan({ checkpoint: cp, rows: [], deletions: [], scannedAt: "missing" }).status).toBe("alert");
    expect(compareScan({ checkpoint: cp, rows, deletions: [], scannedAt: "returned" }).status).toBe("healthy");
  });

  test("raw delete and same-ID recreate between scans is a named replaced loss", () => {
    const cp = emptyCheckpoint("before", [{ id: "m", durability: "permanent", instanceToken: "old" }]);
    const rows = [{ id: "m", durability: "permanent", instanceToken: "new" }];
    const verdict = compareScan({ checkpoint: cp, rows, deletions: [], scannedAt: "after" });
    expect(verdict.status).toBe("alert");
    expect(verdict.losses).toEqual([{ id: "m", tier: "permanent", reason: "replaced" }]);
    expect(verdict.unexplainedDecrease).toEqual({});
  });

  test("recorded delete and same-ID recreate explains the checkpointed incarnation", () => {
    const cp = emptyCheckpoint("before", [{ id: "m", durability: "permanent", instanceToken: "old" }]);
    const rows = [{ id: "m", durability: "permanent", instanceToken: "new" }];
    for (const token of ["old", "new"]) {
      const deletions = [{ id: "d", memoryId: "m", memoryInstanceToken: token, at: "deleted" }];
      const verdict = compareScan({ checkpoint: cp, rows, deletions, scannedAt: "after" });
      expect(verdict.status).toBe(token === "old" ? "healthy" : "alert");
      expect(verdict.attributedDeletes).toEqual(token === "old" ? [{ id: "m", tier: "permanent", at: "deleted" }] : []);
      expect(verdict.losses).toEqual(token === "old" ? [] : [{ id: "m", tier: "permanent", reason: "replaced" }]);
    }
  });

  test("a delete of another incarnation cannot explain a missing checkpointed row", () => {
    const oldRows = [{ id: "m", durability: "permanent", instanceToken: "2026-10-01" }];
    const cp = emptyCheckpoint("before", oldRows);
    const deletion = { id: "d", memoryId: "m", memoryInstanceToken: "2026-10-01", at: "deleted" };
    expect(compareScan({ checkpoint: cp, rows: [], deletions: [deletion], scannedAt: "after-delete" }).status).toBe("healthy");
    const recreated = [{ ...oldRows[0], instanceToken: "2026-10-02" }];
    expect(compareScan({ checkpoint: cp, rows: recreated, deletions: [deletion], scannedAt: "recreated" }).status).toBe("healthy");
    // Model delayed history visibility at the recreated row's checkpoint.
    const next = emptyCheckpoint("recreated", recreated);
    const verdict = compareScan({ checkpoint: next, rows: [], deletions: [deletion], scannedAt: "raw-deleted" });
    expect(verdict.status).toBe("alert");
    expect(verdict.losses).toEqual([{ id: "m", tier: "permanent" }]);
    expect(verdict.attributedDeletes).toEqual([]);
    expect(verdict.unexplainedDecrease).toEqual({});
    const fresh = { ...deletion, id: "new-delete", memoryInstanceToken: "2026-10-02" };
    expect(compareScan({ checkpoint: next, rows: [], deletions: [deletion, fresh], scannedAt: "recorded-delete" }).status).toBe("healthy");
  });

  test("missing incarnation metadata never attributes a loss", () => {
    for (const instanceToken of [undefined, null, "", "current-token"]) {
      const cp = emptyCheckpoint("before", [{ id: "m", durability: "permanent", instanceToken }]);
      for (const memoryInstanceToken of [undefined, null, "", "2026-10-01"]) {
        const verdict = compareScan({ checkpoint: cp, rows: [], deletions: [{ id: "d", memoryId: "m", memoryInstanceToken, at: "after" }], scannedAt: "now" });
        expect(verdict.status).toBe("alert");
        expect(verdict.losses).toEqual([{ id: "m", tier: "permanent" }]);
      }
    }
  });

  test("delete, recreate, checkpoint, raw delete remains an unexplained loss", () => {
    const old = { id: "old-delete", memoryId: "recreated", memoryInstanceToken: "2026-10-01T00:00:00.000Z", at: "2099-01-01" };
    const cp = emptyCheckpoint("2026-10-02", rowsOf([["recreated", "permanent"]]), [old]);
    const verdict = compareScan({ checkpoint: cp, rows: [], deletions: [old], scannedAt: "2026-10-03" });
    expect(verdict.status).toBe("alert");
    expect(verdict.losses).toEqual([{ id: "recreated", tier: "permanent" }]);
    const fresh = { ...old, id: "fresh-delete", at: "1900-01-01" };
    expect(compareScan({ checkpoint: cp, rows: [], deletions: [old, fresh], scannedAt: "2026-10-03" }).status).toBe("healthy");
  });

  test("__proto__ survives checkpoint I/O and a replacement with a different ID alerts", () => {
    const cp = emptyCheckpoint("now", rowsOf([["__proto__", "permanent"]]));
    const path = join(tmp(), "checkpoint.json");
    writeCheckpoint(path, cp);
    const read = readCheckpoint(path);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") throw new Error("checkpoint unreadable");
    expect(Object.getPrototypeOf(read.checkpoint.ids)).toBeNull();
    expect(Object.getPrototypeOf(read.checkpoint.instanceTokens)).toBeNull();
    expect(read.checkpoint.instanceTokens["__proto__"]).toBe("2026-10-01T00:00:00.000Z");
    const verdict = compareScan({ checkpoint: read.checkpoint, rows: rowsOf([["replacement", "permanent"]]), deletions: [], scannedAt: "later" });
    expect(verdict.status).toBe("alert");
    expect(verdict.losses).toEqual([{ id: "__proto__", tier: "permanent" }]);
  });

  test("malformed checkpoint ID maps and history watermarks are unreadable", () => {
    const cp = baseCheckpoint([["m1", "permanent"]]);
    const path = join(tmp(), "checkpoint.json");
    for (const patch of [{ ids: [] }, { ids: { m1: {} } }, { ids: { "": "permanent" } }, { historyIds: [42] }, { historyIds: undefined }, { version: 1 }, { instanceTokens: undefined }, { instanceTokens: [] }, { instanceTokens: {} }, { instanceTokens: { m1: 42 } }, { instanceTokens: { m1: "" } }, { instanceTokens: { m1: null, extra: null } }]) {
      writeFileSync(path, JSON.stringify({ ...cp, ...patch }));
      expect(readCheckpoint(path).kind).toBe("unreadable");
    }
  });
});
