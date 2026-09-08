/**
 * quality-recall-archived-857.test.ts — the powered check for flair#857.
 *
 * #857 is a diagnosed defect, so these tests were written to FAIL on
 * unmodified main first: `planRecallSpotCheck` sampled via recency alone
 * and never looked at `archived`, while `POST /SemanticSearch` excludes
 * `archived not_equal true`. After any archival sweep the most-recent-10
 * window filled with basemented rows that search can never return — a
 * false recall collapse (observed: recall@5 = 0.1 = the one live row).
 *
 * Properties:
 *  1. An archived row can never enter the sample.
 *  2. Unset / false `archived` still sample (same predicate search uses).
 *  3. The sample URL projects `archived` so the planner can filter it.
 *
 * Positive control: a window of live rows still samples all of them.
 */

import { describe, test, expect } from "bun:test";
import {
  QUALITY_MEMORY_LIST_SELECT,
  QUALITY_RECALL_SAMPLE_SIZE,
  fetchRecallSpotCheckData,
  planRecallSpotCheck,
  qualityRecallSamplePath,
  type QualityApi,
} from "../../src/cli.ts";

const NOW = Date.parse("2026-07-26T00:00:00.000Z");

function row(
  id: string,
  opts: { archived?: boolean | null; offsetSec?: number; subject?: string } = {},
) {
  return {
    id,
    subject: opts.subject ?? `Harper upgrade note ${id}`,
    content: `Harper 5.2 upgrade note ${id} with enough words to be a real cue`,
    createdAt: new Date(NOW + (opts.offsetSec ?? 0) * 1000).toISOString(),
    ...(opts.archived !== undefined ? { archived: opts.archived } : {}),
  };
}

describe("flair#857 — archived memories never enter the recall spot-check sample", () => {
  test("QUALITY_MEMORY_LIST_SELECT projects archived so the planner can drop basemented rows", () => {
    expect(QUALITY_MEMORY_LIST_SELECT).toContain("archived");
    expect(qualityRecallSamplePath("flint")).toContain("select(");
    expect(qualityRecallSamplePath("flint")).toMatch(/select\([^)]*archived/);
  });

  test("an archived row can never enter the sample — even when it is the newest", () => {
    const memories = [
      row("archived-newest", { archived: true, offsetSec: 99 }),
      ...Array.from({ length: QUALITY_RECALL_SAMPLE_SIZE }, (_, i) =>
        row(`live-${i}`, { archived: false, offsetSec: i }),
      ),
    ];
    const plan = planRecallSpotCheck(memories);
    expect(plan.sampled.map((s) => s.id)).not.toContain("archived-newest");
    expect(plan.sampled).toHaveLength(QUALITY_RECALL_SAMPLE_SIZE);
    expect(plan.sampled.every((s) => s.id.startsWith("live-"))).toBe(true);
  });

  test("unset and false archived stay in the live pool (same not_equal true predicate as SemanticSearch)", () => {
    const memories = [
      row("unset", { offsetSec: 2 }),
      row("false", { archived: false, offsetSec: 1 }),
      row("basement", { archived: true, offsetSec: 0 }),
      ...Array.from({ length: QUALITY_RECALL_SAMPLE_SIZE - 2 }, (_, i) =>
        row(`live-${i}`, { archived: false, offsetSec: -(i + 1) }),
      ),
    ];
    const plan = planRecallSpotCheck(memories);
    const ids = plan.sampled.map((s) => s.id);
    expect(ids).toContain("unset");
    expect(ids).toContain("false");
    expect(ids).not.toContain("basement");
  });

  test("a recency window that is mostly archived fills from older live rows, not the basement", () => {
    // The production shape: 9 newest rows archived after a sweep, 1 live
    // in the top-10, plus enough older live rows to fill a 10-row sample.
    const memories = [
      ...Array.from({ length: 9 }, (_, i) => row(`archived-${i}`, { archived: true, offsetSec: 100 + i })),
      row("live-newest", { archived: false, offsetSec: 50 }),
      ...Array.from({ length: 9 }, (_, i) => row(`live-older-${i}`, { archived: false, offsetSec: i })),
    ];
    const plan = planRecallSpotCheck(memories);
    expect(plan.sampled).toHaveLength(QUALITY_RECALL_SAMPLE_SIZE);
    expect(plan.sampled.some((s) => s.id.startsWith("archived-"))).toBe(false);
    expect(plan.sampled[0]!.id).toBe("live-newest");
  });

  test("positive control: a healthy live window still samples all ten", () => {
    const memories = Array.from({ length: QUALITY_RECALL_SAMPLE_SIZE }, (_, i) =>
      row(`live-${i}`, { archived: false, offsetSec: i }),
    );
    const plan = planRecallSpotCheck(memories);
    expect(plan.health.healthy).toBe(true);
    expect(plan.sampled).toHaveLength(QUALITY_RECALL_SAMPLE_SIZE);
    expect(plan.excludedArchivedRows).toBe(0);
  });

  test("excludedArchivedRows counts basemented rows dropped before the recency window", () => {
    const memories = [
      ...Array.from({ length: 9 }, (_, i) => row(`archived-${i}`, { archived: true, offsetSec: 100 + i })),
      row("live-only", { archived: false, offsetSec: 0 }),
    ];
    const plan = planRecallSpotCheck(memories);
    expect(plan.excludedArchivedRows).toBe(9);
    expect(plan.excludedSnapshotRows).toBe(0);
    expect(plan.sampled).toHaveLength(1);
  });
});

describe("flair#857 — fetchRecallSpotCheckData does not search archived sample rows", () => {
  test("GET rows marked archived never become sampledIds or SemanticSearch targets", async () => {
    const live = Array.from({ length: QUALITY_RECALL_SAMPLE_SIZE }, (_, i) =>
      row(`live-${i}`, { archived: false, offsetSec: i }),
    );
    const mixed = [row("archived-top", { archived: true, offsetSec: 99 }), ...live];
    const searchedIds: string[] = [];
    const request: QualityApi = async (method, path, body?: any) => {
      if (method === "GET") return mixed;
      if (method === "POST" && path === "/SemanticSearch") {
        const target = live[searchedIds.length];
        searchedIds.push(target!.id);
        expect(body?.q).not.toContain("archived-top");
        return [{ id: target!.id }];
      }
      throw new Error(`unexpected ${method} ${path}`);
    };

    const result = await fetchRecallSpotCheckData("flint", "http://127.0.0.1:9926", { request });
    expect(result.ok).toBe(true);
    expect(result.sampledIds).not.toContain("archived-top");
    expect(result.sampledIds).toHaveLength(QUALITY_RECALL_SAMPLE_SIZE);
    expect(searchedIds).not.toContain("archived-top");
    expect(searchedIds).toHaveLength(QUALITY_RECALL_SAMPLE_SIZE);
  });

  test("a short window after a basement sweep names the archived count and restore remedy", async () => {
    const request: QualityApi = async (method) => {
      if (method === "GET") {
        return [
          ...Array.from({ length: 9 }, (_, i) => row(`archived-${i}`, { archived: true, offsetSec: 100 + i })),
          row("live-only", { archived: false, offsetSec: 0 }),
        ];
      }
      throw new Error("search should not run — short window");
    };
    const result = await fetchRecallSpotCheckData("flint", "http://127.0.0.1:9926", { request });
    expect(result.ok).toBe(false);
    expect(result.skipReason).toMatch(/has 1 scorable memories, fewer than the 10 needed/);
    expect(result.skipReason).toMatch(/9 archived row\(s\) excluded/);
    expect(result.skipReason).toMatch(/basemented/);
    expect(result.skipReason).toMatch(/flair memory restore/);
    expect(result.skipReason).not.toMatch(/quality-snapshot/);
  });

  test("short-window skip names both archived and quality-snapshot exclusions when both applied", async () => {
    const request: QualityApi = async (method) => {
      if (method === "GET") {
        return [
          row("archived-1", { archived: true, offsetSec: 3 }),
          row("snap-1", { archived: false, offsetSec: 2, subject: "quality-snapshot/127.0.0.1:9926" }),
          row("live-1", { archived: false, offsetSec: 1 }),
          row("live-2", { archived: false, offsetSec: 0 }),
        ];
      }
      throw new Error("search should not run — short window");
    };
    const result = await fetchRecallSpotCheckData("flint", "http://127.0.0.1:9926", { request });
    expect(result.ok).toBe(false);
    expect(result.skipReason).toMatch(/1 archived row\(s\) excluded/);
    expect(result.skipReason).toMatch(/1 quality-snapshot row\(s\) excluded/);
    expect(result.skipReason).toMatch(/flair memory restore/);
  });
});
