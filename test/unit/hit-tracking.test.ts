/**
 * hit-tracking.test.ts — flair#1528 remaining slice (write amp + counters).
 *
 * Pure unit coverage of HitTracker via injected maps. No Harper. Concurrent
 * increments must add, not race, and must coalesce to far fewer puts than
 * hits. Overlay prefers the stat row; the first flush seeds from Memory.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("harper", () => ({
  databases: {
    flair: {
      Memory: { get: async () => null },
      MemoryHitStat: { get: async () => null, put: async () => {}, delete: async () => {} },
    },
  },
}));

const { HitTracker } = await import("../../resources/hit-tracking.ts");
type HitStatRow = { id: string; retrievalCount: number; lastRetrieved?: string };

function maps(seed?: Record<string, { retrievalCount?: number }>) {
  const stats = new Map<string, HitStatRow>();
  const memories = new Map<string, { retrievalCount?: number }>(Object.entries(seed ?? {}));
  let puts = 0;
  let putDelayMs = 0;
  const tables = {
    stats: {
      get: async (id: string) => stats.get(id) ?? null,
      put: async (row: HitStatRow) => {
        if (putDelayMs) await new Promise((r) => setTimeout(r, putDelayMs));
        puts += 1;
        stats.set(row.id, { ...row });
      },
      delete: async (id: string) => { stats.delete(id); },
    },
    memory: {
      get: async (id: string) => memories.get(id) ?? null,
    },
  };
  return {
    tables,
    stats,
    get puts() { return puts; },
    setDelay(ms: number) { putDelayMs = ms; },
  };
}

describe("HitTracker — coalesced counters", () => {
  test("sequential hits increment exactly and write once per flush", async () => {
    const store = maps();
    const tracker = new HitTracker(store.tables);
    for (let i = 0; i < 10; i++) {
      tracker.noteHits(["m1"], `2026-09-08T00:00:0${i % 10}Z`);
      await tracker.whenIdle();
    }
    expect(store.stats.get("m1")?.retrievalCount).toBe(10);
    expect(store.puts).toBe(10);
  });

  test("concurrent hits on one id add instead of racing", async () => {
    const store = maps();
    store.setDelay(15);
    const tracker = new HitTracker(store.tables);
    const now = "2026-09-08T00:00:00.000Z";
    for (let i = 0; i < 64; i++) tracker.noteHits(["m1"], now);
    await tracker.whenIdle();
    expect(store.stats.get("m1")?.retrievalCount).toBe(64);
    expect(store.puts).toBeGreaterThan(0);
    expect(store.puts).toBeLessThan(64);
  });

  test("320 hits across 5 ids account exactly and coalesce writes", async () => {
    const store = maps();
    store.setDelay(8);
    const tracker = new HitTracker(store.tables);
    const ids = ["a", "b", "c", "d", "e"];
    const now = "2026-09-08T12:00:00.000Z";
    for (let n = 0; n < 64; n++) tracker.noteHits(ids, now);
    await tracker.whenIdle();
    for (const id of ids) expect(store.stats.get(id)?.retrievalCount).toBe(64);
    expect(store.puts).toBeGreaterThan(0);
    expect(store.puts).toBeLessThan(320);
    expect(tracker.metrics.successfulPuts).toBe(store.puts);
    expect(tracker.metrics.failedPuts).toBe(0);
  });

  test("first flush seeds from an existing Memory.retrievalCount", async () => {
    const store = maps({ legacy: { retrievalCount: 10 } });
    const tracker = new HitTracker(store.tables);
    tracker.noteHits(["legacy"], "2026-09-08T00:00:00.000Z");
    await tracker.whenIdle();
    expect(store.stats.get("legacy")?.retrievalCount).toBe(11);
    expect(store.stats.get("legacy")?.lastRetrieved).toBe("2026-09-08T00:00:00.000Z");
  });

  test("apply overlays the stat row and leaves other fields intact", async () => {
    const store = maps();
    const tracker = new HitTracker(store.tables);
    tracker.noteHits(["m1"], "2026-09-08T01:00:00.000Z");
    await tracker.whenIdle();
    const overlay = await tracker.apply({ id: "m1", content: "keep", retrievalCount: 0 });
    expect(overlay).toEqual({
      id: "m1",
      content: "keep",
      retrievalCount: 1,
      lastRetrieved: "2026-09-08T01:00:00.000Z",
    });
    expect(await tracker.apply({ id: "unknown", retrievalCount: 3 })).toEqual({
      id: "unknown",
      retrievalCount: 3,
    });
  });

  test("failed put re-queues the delta so counts are not dropped", async () => {
    let failOnce = true;
    const stats = new Map<string, HitStatRow>();
    const tracker = new HitTracker({
      stats: {
        get: async (id) => stats.get(id) ?? null,
        put: async (row) => {
          if (failOnce) { failOnce = false; throw new Error("busy"); }
          stats.set(row.id, { ...row });
        },
      },
      memory: { get: async () => null },
    });
    tracker.noteHits(["m1"], "2026-09-08T00:00:00.000Z");
    await tracker.whenIdle();
    expect(stats.get("m1")?.retrievalCount).toBe(1);
    expect(tracker.metrics.failedPuts).toBe(1);
    expect(tracker.metrics.successfulPuts).toBe(1);
  });

  test("clear removes the stat row and the overlay cache", async () => {
    const store = maps();
    const tracker = new HitTracker(store.tables);
    tracker.noteHits(["m1"], "2026-09-08T00:00:00.000Z");
    await tracker.whenIdle();
    await tracker.clear("m1");
    expect(store.stats.has("m1")).toBe(false);
    expect(await tracker.apply({ id: "m1", retrievalCount: 0 })).toEqual({ id: "m1", retrievalCount: 0 });
  });

  test("empty ids are ignored", async () => {
    const store = maps();
    const tracker = new HitTracker(store.tables);
    tracker.noteHits(["", "m1"], "2026-09-08T00:00:00.000Z");
    await tracker.whenIdle();
    expect(store.stats.has("")).toBe(false);
    expect(store.stats.get("m1")?.retrievalCount).toBe(1);
  });
});
