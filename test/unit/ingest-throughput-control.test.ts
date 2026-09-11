/**
 * ingest-throughput-control.test.ts — flair#1436 refuse-rather-than-lie gates.
 *
 * Pure inputs, no Harper, no model. Every gate must be able to FAIL.
 */
import { describe, expect, test } from "bun:test";
import {
  NEGATIVE_CONTROL_MIN_SLOWDOWN,
  POSITIVE_CONTROL_TOK_PER_SEC_PER_CORE,
  cellKey,
  decideMetalGate,
  decideNegativeControl,
  decideObservedThreads,
  decidePositiveControl,
  decideQuietBox,
  intervalOf,
  intervalsOverlap,
  isMetalCapablePlatform,
  parseCompetingFromPs,
  parseMetalEngaged,
  rankCells,
  resolveGpuLayerSweep,
} from "./ingest-throughput-control";
import {
  parseDarwinPsM, parseDarwinThcount, parseLinuxProcStatus, parsePsRssKb,
  observedThreadDelta,
} from "../bench/ingest-throughput/observe";
import { inspectQuietBox } from "../bench/ingest-throughput/quiet-box";

describe("decideNegativeControl (flair#1436 — ≥1.3× slower)", () => {
  test("1 is 8× slower than 8 → not blocked", () => {
    const d = decideNegativeControl(100, 800);
    expect(d.blocked).toBe(false);
    expect(d.slowdown).toBeCloseTo(8);
    expect(d.minSlowdown).toBe(NEGATIVE_CONTROL_MIN_SLOWDOWN);
  });

  test("exactly 1.3× slower → passed (the published floor)", () => {
    const d = decideNegativeControl(100, 130);
    expect(d.passed).toBe(true);
    expect(d.blocked).toBe(false);
    expect(d.slowdown).toBeCloseTo(1.3);
  });

  test("1.29× slower → blocked (just under the floor)", () => {
    const d = decideNegativeControl(100, 129);
    expect(d.blocked).toBe(true);
  });

  test("low not materially slower than high → blocked (known-answer)", () => {
    expect(decideNegativeControl(790, 800).blocked).toBe(true);
  });

  test("NaN tokPerSec (failed warm-up) → blocked, never proceed on missing data", () => {
    expect(decideNegativeControl(NaN, 800).blocked).toBe(true);
  });

  test("zero high throughput → blocked", () => {
    expect(decideNegativeControl(100, 0).blocked).toBe(true);
  });
});

describe("decideObservedThreads", () => {
  test("positive finite count → passed", () => {
    expect(decideObservedThreads(7).blocked).toBe(false);
  });

  test("0 / null / undefined / NaN / negative → blocked", () => {
    for (const v of [0, null, undefined, NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(decideObservedThreads(v as number).blocked).toBe(true);
    }
  });
});

describe("observedThreadDelta", () => {
  test("warmup created threads → delta", () => {
    expect(observedThreadDelta(12, 19)).toBe(7);
  });

  test("unreadable or non-positive delta → throws (refuse)", () => {
    expect(() => observedThreadDelta(12, 12)).toThrow(/refusing/);
    expect(() => observedThreadDelta(NaN, 19)).toThrow(/unreadable/);
    expect(() => observedThreadDelta(19, 12)).toThrow(/refusing/);
  });
});

describe("rankCells — overlapping intervals are inconclusive", () => {
  test("separated intervals → winner is the strictly higher cell", () => {
    const r = rankCells([
      { id: "threads=6 gpu=0", values: [10, 10.2, 10.1] },
      { id: "threads=8 gpu=0", values: [14, 14.5, 14.2] },
    ]);
    expect(r.verdict).toBe("winner");
    expect(r.winner).toBe("threads=8 gpu=0");
    expect(r.overlappingPairs).toEqual([]);
  });

  test("overlapping intervals → inconclusive, no winner", () => {
    const r = rankCells([
      { id: "threads=6 gpu=0", values: [10, 12, 11] },
      { id: "threads=7 gpu=0", values: [11.5, 13, 12] },
      { id: "threads=8 gpu=0", values: [11, 12.5, 12] },
    ]);
    expect(r.verdict).toBe("inconclusive");
    expect(r.winner).toBeNull();
    expect(r.overlappingPairs.length).toBeGreaterThan(0);
  });

  test("identical point values overlap → inconclusive, not a coin-flip winner", () => {
    const r = rankCells([
      { id: "a", values: [10, 10, 10] },
      { id: "b", values: [10, 10, 10] },
    ]);
    expect(r.verdict).toBe("inconclusive");
    expect(r.winner).toBeNull();
  });

  test("empty / NaN cells → refused", () => {
    expect(rankCells([]).verdict).toBe("refused");
    expect(rankCells([{ id: "x", values: [NaN] }]).verdict).toBe("refused");
  });

  test("interval helpers", () => {
    const i = intervalOf([2, 4, 6]);
    expect(i).toEqual({ min: 2, max: 6, mean: 4 });
    expect(intervalsOverlap({ min: 1, max: 3, mean: 2 }, { min: 3, max: 5, mean: 4 })).toBe(true);
    expect(intervalsOverlap({ min: 1, max: 2, mean: 1.5 }, { min: 3, max: 4, mean: 3.5 })).toBe(false);
  });
});

describe("decidePositiveControl (~159 tok/s/core on 8-core)", () => {
  test("non-8-core host → not applicable, not blocked", () => {
    const d = decidePositiveControl({ hostCores: 4, tokPerSecPerCoreRuns: [80, 82, 79] });
    expect(d.applicable).toBe(false);
    expect(d.blocked).toBe(false);
  });

  test("8-core interval containing 159 → passed", () => {
    const d = decidePositiveControl({
      hostCores: 8,
      tokPerSecPerCoreRuns: [150, 165, 158],
    });
    expect(d.applicable).toBe(true);
    expect(d.passed).toBe(true);
    expect(d.blocked).toBe(false);
    expect(d.expected).toBe(POSITIVE_CONTROL_TOK_PER_SEC_PER_CORE);
  });

  test("8-core interval that misses 159 → blocked", () => {
    const d = decidePositiveControl({
      hostCores: 8,
      tokPerSecPerCoreRuns: [200, 201, 202],
    });
    expect(d.blocked).toBe(true);
  });

  test("8-core unreadable runs → blocked", () => {
    expect(decidePositiveControl({ hostCores: 8, tokPerSecPerCoreRuns: [] }).blocked).toBe(true);
  });
});

describe("parseMetalEngaged / decideMetalGate", () => {
  const metalLog = [
    "ggml_metal_init: use fusion = true",
    "sched_reserve: MTL0 compute buffer size = 120.02 MiB",
  ].join("\n");

  test("both markers → engaged", () => {
    const r = parseMetalEngaged(metalLog);
    expect(r.engaged).toBe(true);
    expect(r.hasInit).toBe(true);
    expect(r.hasComputeBuffer).toBe(true);
    expect(r.evidence.length).toBe(2);
  });

  test("hyphenated compute-buffer also matches", () => {
    expect(parseMetalEngaged("ggml_metal_init: ok\ncompute-buffer 64 MiB").engaged).toBe(true);
  });

  test("init without buffer → not engaged", () => {
    expect(parseMetalEngaged("ggml_metal_init: allocating").engaged).toBe(false);
  });

  test("empty log → not engaged", () => {
    expect(parseMetalEngaged("").engaged).toBe(false);
  });

  test("gpu=0 does not require Metal", () => {
    const d = decideMetalGate(0, "");
    expect(d.required).toBe(false);
    expect(d.blocked).toBe(false);
  });

  test("gpu=99 without log → blocked (do not invent GPU numbers)", () => {
    const d = decideMetalGate(99, "harper started\nlistening on");
    expect(d.required).toBe(true);
    expect(d.blocked).toBe(true);
    expect(d.passed).toBe(false);
  });

  test("gpu=99 with both markers → passed", () => {
    expect(decideMetalGate(99, metalLog).blocked).toBe(false);
  });
});

describe("quiet-box", () => {
  test("idle, no competitors → quiet", () => {
    const d = decideQuietBox({ load1: 0.1, cores: 8, competing: [] });
    expect(d.quiet).toBe(true);
    expect(d.blocked).toBe(false);
    expect(d.caveat).toBe(false);
  });

  test("competing harper → refuse", () => {
    const d = decideQuietBox({
      load1: 0.1,
      cores: 8,
      competing: [{ pid: 99, cmd: "harper run ." }],
    });
    expect(d.blocked).toBe(true);
    expect(d.quiet).toBe(false);
  });

  test("saturated load → refuse", () => {
    const d = decideQuietBox({ load1: 8, cores: 8, competing: [] });
    expect(d.blocked).toBe(true);
  });

  test("elevated load → caveat, ranking refused, run not blocked", () => {
    const d = decideQuietBox({ load1: 3, cores: 8, competing: [] });
    expect(d.caveat).toBe(true);
    expect(d.blocked).toBe(false);
    expect(d.quiet).toBe(false);
  });

  test("parseCompetingFromPs excludes self and ignores unrelated procs", () => {
    const table = [
      "  1 /sbin/init",
      " 42 bun run test/bench/ingest-throughput/run.ts",
      " 77 /usr/bin/harper run .",
      " 88 python3 train.py",
    ].join("\n");
    const found = parseCompetingFromPs(table, 42);
    expect(found).toEqual([{ pid: 77, cmd: "/usr/bin/harper run ." }]);
  });

  test("inspectQuietBox is callable on this host (does not throw)", () => {
    const snap = inspectQuietBox({
      selfPid: process.pid,
      cores: 8,
      load1: 0.05,
      psOutput: `${process.pid} bun test\n1 /sbin/init\n`,
    });
    expect(snap.quiet).toBe(true);
    expect(snap.competing).toEqual([]);
  });
});

describe("gpu sweep resolution", () => {
  test("auto on linux/x64 → {0} only, skipped", () => {
    const r = resolveGpuLayerSweep({ platform: "linux", arch: "x64", requested: "auto" });
    expect(r.sweep).toEqual([0]);
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/not Metal/);
  });

  test("auto on darwin/arm64 → {0, 99}", () => {
    const r = resolveGpuLayerSweep({ platform: "darwin", arch: "arm64", requested: "auto" });
    expect(r.sweep).toEqual([0, 99]);
    expect(r.skipped).toBe(false);
  });

  test("explicit 0,99 is honoured (Metal readback still required at measure time)", () => {
    const r = resolveGpuLayerSweep({ platform: "linux", arch: "x64", requested: [0, 99] });
    expect(r.sweep).toEqual([0, 99]);
  });

  test("isMetalCapablePlatform", () => {
    expect(isMetalCapablePlatform("darwin", "arm64")).toBe(true);
    expect(isMetalCapablePlatform("darwin", "x64")).toBe(false);
    expect(isMetalCapablePlatform("linux", "arm64")).toBe(false);
  });

  test("cellKey is stable", () => {
    expect(cellKey(7, 0)).toBe("threads=7 gpu=0");
    expect(cellKey("default", 99)).toBe("threads=default gpu=99");
  });
});

describe("observe parsers", () => {
  test("Linux /proc status", () => {
    const raw = [
      "Name:\tnode",
      "Threads:\t19",
      "VmHWM:\t   123456 kB",
    ].join("\n");
    expect(parseLinuxProcStatus(raw)).toEqual({ threads: 19, rssBytes: 123456 * 1024 });
  });

  test("Linux /proc missing Threads → NaN (caller refuses)", () => {
    expect(Number.isFinite(parseLinuxProcStatus("Name:\tnode\n").threads)).toBe(false);
  });

  test("Darwin thcount", () => {
    expect(parseDarwinThcount("      12\n")).toBe(12);
    expect(Number.isFinite(parseDarwinThcount(""))).toBe(false);
  });

  test("Darwin ps -M counts thread rows, skips header", () => {
    const raw = [
      "USER   PID   TT  STAT  TIME COMMAND",
      "me    1234   ??    S    0:00.01 node",
      "             ??    S    0:00.00",
      "             ??    S    0:00.00",
    ].join("\n");
    expect(parseDarwinPsM(raw)).toBe(3);
  });

  test("ps rss kilobytes → bytes", () => {
    expect(parsePsRssKb("  4096\n")).toBe(4096 * 1024);
  });
});
