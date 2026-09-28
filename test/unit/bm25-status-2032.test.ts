/**
 * flair#2032 — operator-facing BM25 status lines.
 *
 * The strings `flair status` and /HealthDetail show are formatted here, with
 * no Harper. A multi-worker process must say which worker the line describes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatBm25IndexSummary, bm25SearchLagReason, bm25DisabledWarning } from "../../resources/bm25-status.ts";
import { formatBm25StatusLine } from "../../src/commands/status.ts";

const NOW = Date.parse("2026-09-28T15:00:00.000Z");

const base = {
  size: 0,
  built: 0,
  total: 0,
  startedAt: null as number | null,
  finishedAt: null as number | null,
  buildDurationMs: null as number | null,
  workerThreadId: 0,
  threadsCount: 1 as number | null,
  reason: "",
};

describe("formatBm25IndexSummary (flair#2032)", () => {
  test("building names built/total, percent, and when it started", () => {
    const line = formatBm25IndexSummary({
      ...base,
      state: "building",
      size: 312,
      built: 312,
      total: 817,
      startedAt: NOW - 4_000,
    }, NOW);
    expect(line).toBe("building 312/817 docs (38%) · started 4s ago");
    expect(line).not.toMatch(/cold boot/i);
  });

  test("ready names the doc count, build duration, and age", () => {
    const line = formatBm25IndexSummary({
      ...base,
      state: "ready",
      size: 817,
      built: 817,
      total: 817,
      startedAt: NOW - 180_000 - 1_200,
      finishedAt: NOW - 180_000,
      buildDurationMs: 1_200,
    }, NOW);
    expect(line).toBe("ready · 817 docs · built in 1.2s · 3m ago");
  });

  test("disabled shows its reason", () => {
    const line = formatBm25IndexSummary({
      ...base,
      state: "disabled",
      reason: "change feed ended",
    }, NOW);
    expect(line).toBe("disabled — change feed ended");
  });

  test("a failed build is its own line, not a permanent building", () => {
    const line = formatBm25IndexSummary({
      ...base,
      state: "failed",
      reason: "build failed: disk gone",
      startedAt: NOW - 2_000,
      finishedAt: NOW - 1_000,
      buildDurationMs: 1_000,
    }, NOW);
    expect(line).toBe("failed — build failed: disk gone");
    expect(line.startsWith("building")).toBe(false);
  });

  test("empty says what clears it and does not call the gap a cold boot", () => {
    const line = formatBm25IndexSummary({ ...base, state: "empty" }, NOW);
    expect(line).toMatch(/not built yet/);
    expect(line).toMatch(/text search/);
    expect(line).not.toMatch(/cold boot/i);
  });

  test("THREADS_COUNT>1 names this worker; a single worker does not", () => {
    const many = formatBm25IndexSummary({
      ...base,
      state: "ready",
      size: 10,
      built: 10,
      total: 10,
      finishedAt: NOW - 180_000,
      buildDurationMs: 1_200,
      startedAt: NOW - 181_200,
      workerThreadId: 3,
      threadsCount: 4,
    }, NOW);
    expect(many).toContain("worker 3 of 4");
    const one = formatBm25IndexSummary({
      ...base,
      state: "empty",
      workerThreadId: 1,
      threadsCount: 1,
    }, NOW);
    expect(one).not.toContain("worker");
  });
});

describe("bm25SearchLagReason (flair#2032)", () => {
  test("a progress summary is the lag text, prefixed once", () => {
    expect(bm25SearchLagReason({
      state: "building",
      summary: "building 312/817 docs (38%) · started 4s ago",
    })).toBe("bm25 index: building 312/817 docs (38%) · started 4s ago");
  });

  test("empty without a summary says what clears it", () => {
    const reason = bm25SearchLagReason({ state: "empty" });
    expect(reason).toMatch(/not built yet/);
    expect(reason).toMatch(/text search/);
    expect(reason).not.toMatch(/cold boot/i);
    expect(reason).not.toMatch(/scans the corpus/i);
  });

  test("public lag (reason, no summary) names a skipped warm instead of the startup sentence", () => {
    const skipped = "background build skipped: Memory table was not ready within 30s; a text search builds it";
    const lag = bm25SearchLagReason({ state: "empty", reason: skipped });
    expect(lag).toBe(`bm25 index: not built yet — ${skipped}; a text search rebuilds it`);
    expect(lag).not.toMatch(/builds in the background after startup/);
  });

  test("public lag (reason, no summary) names a stale marker instead of the startup sentence", () => {
    const stale = "unhandled feed event type reload";
    const lag = bm25SearchLagReason({ state: "empty", reason: stale });
    expect(lag).toBe(`bm25 index: not built yet — ${stale}; a text search rebuilds it`);
    expect(lag).not.toMatch(/builds in the background after startup/);
  });

  test("a building line still wins when a leftover reason is present and summary is absent", () => {
    const lag = bm25SearchLagReason({
      state: "building",
      reason: "unhandled feed event type reload",
    });
    expect(lag).toBe("bm25 index: building — a text search waits for this build");
  });
});

describe("flair status prints the server summary (flair#2032)", () => {
  test("formatBm25StatusLine returns the summary the server already formatted", () => {
    expect(formatBm25StatusLine({ summary: "ready · 817 docs · built in 1.2s · 3m ago" }))
      .toBe("ready · 817 docs · built in 1.2s · 3m ago");
    expect(formatBm25StatusLine(null)).toBeNull();
    expect(formatBm25StatusLine({})).toBeNull();
    expect(formatBm25StatusLine({ summary: "  " })).toBeNull();
  });

  test("both status renderers print that line", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "commands", "status.ts"), "utf8");
    const uses = src.match(/formatBm25StatusLine\(healthData\?\.bm25\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });
});

describe("product strings this chip owns (flair#2032)", () => {
  const files = [
    "resources/bm25-status.ts",
    "resources/bm25-index-service.ts",
    "resources/search-readiness.ts",
    "resources/health.ts",
    "resources/embeddings-boot.ts",
    "docs/troubleshooting.md",
    "docs/upgrade.md",
  ];

  test("no cold-boot fault phrasing remains", () => {
    const root = join(import.meta.dir, "..", "..");
    for (const rel of files) {
      const text = readFileSync(join(root, rel), "utf8");
      expect(text, rel).not.toMatch(/cold boot/i);
    }
  });

  test("embeddings boot starts the background warm after registration settles", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "resources", "embeddings-boot.ts"), "utf8");
    expect(src).toContain("scheduleBm25BootWarm");
    expect(src).toMatch(/registerEmbeddingsBackend\(\)\.finally/);
  });
});

describe("HealthDetail warning for a disabled index (flair#2032)", () => {
  const on = { indexEnabled: true, inRetrievalPath: true };

  test("a failure-disabled index is a warning", () => {
    expect(bm25DisabledWarning({ state: "disabled", summary: "disabled — build failed: disk gone" }, on))
      .toBe("bm25 index: disabled — build failed: disk gone");
  });

  test("the kill switch is a setting, not a warning", () => {
    expect(bm25DisabledWarning(
      { state: "disabled", summary: "disabled — FLAIR_BM25_INDEX is off" },
      { indexEnabled: false, inRetrievalPath: true },
    )).toBeNull();
  });

  test("vector-only retrieval is a setting, not a warning", () => {
    expect(bm25DisabledWarning(
      { state: "disabled", summary: "disabled — retrieval mode is vector-only; the index is not used" },
      { indexEnabled: true, inRetrievalPath: false },
    )).toBeNull();
  });

  test("ready, building and empty are not this warning", () => {
    for (const state of ["ready", "building", "empty"]) {
      expect(bm25DisabledWarning({ state, summary: "x" }, on)).toBeNull();
    }
  });

  test("HealthDetail routes its disabled warning through bm25DisabledWarning with both settings", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "resources", "health.ts"), "utf8");
    expect(src).toMatch(/bm25DisabledWarning\(bm25, \{\s*indexEnabled: bm25IndexEnabled\(\),\s*inRetrievalPath: bm25IndexInRetrievalPath\(\),\s*\}\)/);
    expect(src).not.toContain("message: `bm25 index: ${bm25.summary}`");
  });
});
