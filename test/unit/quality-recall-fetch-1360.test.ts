/**
 * quality-recall-fetch-1360.test.ts — the powered check for flair#1360.
 *
 * #1360 is a diagnosed defect, so these tests were written to FAIL on
 * unmodified main first: `fetchRecallSpotCheckData` issued an unfiltered
 * `GET /Memory?agentId=flint` (embeddings inline, whole table) to sample
 * 10 memories, and `flair quality --emit` did it twice.
 *
 * Properties:
 *  1. The sample URL projects only the fields the check reads and never
 *     names `embedding` / `embeddingModel`.
 *  2. The sample URL is bounded (`limit(0, sampleSize+overfetch)`), so a
 *     10-row sample cannot pull the whole table.
 *  3. `fetchRecallSpotCheckData` actually GETs that URL — one Memory
 *     listing, not an unfiltered `?agentId=` collection — and the
 *     snapshot lookup uses the same projection (no embeddings) rather
 *     than a second full-table-with-vectors read.
 *
 * Positive control: a healthy 10-row window still runs the SemanticSearch
 * probes and returns ok:true. A green run here is not vacuous.
 */

import { describe, test, expect } from "bun:test";
import {
  QUALITY_MEMORY_LIST_SELECT,
  QUALITY_RECALL_SAMPLE_SIZE,
  QUALITY_RECALL_SNAPSHOT_OVERFETCH,
  QUALITY_RECALL_K,
  fetchPreviousQualitySnapshot,
  fetchRecallSpotCheckData,
  qualityRecallSamplePath,
  qualitySnapshotLookupPath,
  qualitySnapshotSubject,
  type QualityApi,
} from "../../src/cli.ts";

const SELECT_RE = /[?&]select\(([^)]*)\)/;
const LIMIT_RE = /[?&]limit\((\d+),(\d+)\)/;

function selectFields(path: string): string[] {
  const m = path.match(SELECT_RE);
  expect(m, `expected Harper select(...) in ${path}`).toBeTruthy();
  return (m![1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function assertNoEmbeddings(path: string): void {
  const fields = selectFields(path);
  expect(fields).not.toContain("embedding");
  expect(fields).not.toContain("embeddingModel");
  expect(path).not.toMatch(/embedding/i);
}

describe("flair#1360 — quality Memory listing is projected and bounded", () => {
  test("QUALITY_MEMORY_LIST_SELECT is exactly the fields the planner/snapshot read — never embeddings", () => {
    expect([...QUALITY_MEMORY_LIST_SELECT].sort()).toEqual(
      ["content", "createdAt", "id", "subject"].sort(),
    );
    expect(QUALITY_MEMORY_LIST_SELECT).not.toContain("embedding");
    expect(QUALITY_MEMORY_LIST_SELECT).not.toContain("embeddingModel");
  });

  test("qualityRecallSamplePath projects those fields, sorts by recency, and bounds the window", () => {
    const path = qualityRecallSamplePath("flint");
    expect(path.startsWith("/Memory?")).toBe(true);
    expect(path).toContain("agentId=flint");
    expect(selectFields(path)).toEqual([...QUALITY_MEMORY_LIST_SELECT]);
    assertNoEmbeddings(path);
    expect(path).toContain("sort(-createdAt)");
    const limit = path.match(LIMIT_RE);
    expect(limit, `expected Harper limit(start,end) in ${path}`).toBeTruthy();
    expect(Number(limit![1])).toBe(0);
    expect(Number(limit![2])).toBe(QUALITY_RECALL_SAMPLE_SIZE + QUALITY_RECALL_SNAPSHOT_OVERFETCH);
    expect(Number(limit![2])).toBeLessThan(100);
    expect(path).not.toBe("/Memory?agentId=flint");
  });

  test("a 10-row sample does not encode an unbounded / whole-table listing", () => {
    const path = qualityRecallSamplePath("flint", 10);
    const limit = path.match(LIMIT_RE);
    const end = Number(limit![2]);
    expect(end).toBe(10 + QUALITY_RECALL_SNAPSHOT_OVERFETCH);
    expect(end).toBeGreaterThanOrEqual(10);
    expect(end).toBeLessThan(10 * 10);
  });

  test("agent ids are percent-encoded in the sample path", () => {
    const path = qualityRecallSamplePath("flint/prod");
    expect(path).toContain("agentId=flint%2Fprod");
    expect(path).not.toContain("agentId=flint/prod");
  });

  test("qualitySnapshotLookupPath uses the same projection (never embeddings) and does not add a sample-shaped limit", () => {
    const subject = qualitySnapshotSubject("http://127.0.0.1:9926");
    const path = qualitySnapshotLookupPath("flint", subject);
    expect(path.startsWith("/Memory?")).toBe(true);
    expect(path).toContain("agentId=flint");
    expect(path).toContain(`subject=${encodeURIComponent(subject)}`);
    expect(selectFields(path)).toEqual([...QUALITY_MEMORY_LIST_SELECT]);
    assertNoEmbeddings(path);
    expect(path).not.toMatch(LIMIT_RE);
    expect(path).not.toBe("/Memory?agentId=flint");
  });
});

function scorableRows(n: number): Array<{ id: string; subject: string; content: string; createdAt: string }> {
  const t0 = Date.parse("2026-08-24T00:00:00.000Z");
  return Array.from({ length: n }, (_, i) => ({
    id: `mem-${i}`,
    subject: `Harper upgrade note ${i}`,
    content: `Harper 5.2 upgrade note ${i} with enough words to be a real cue`,
    createdAt: new Date(t0 + i * 1000).toISOString(),
  }));
}

describe("flair#1360 — fetchRecallSpotCheckData does not GET the whole table with embeddings", () => {
  test("GETs the projected+bounded sample path once, never an unfiltered ?agentId= listing", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const rows = scorableRows(QUALITY_RECALL_SAMPLE_SIZE);
    const request: QualityApi = async (method, path) => {
      calls.push({ method, path });
      if (method === "GET") {
        expect(path).toBe(qualityRecallSamplePath("flint", QUALITY_RECALL_SAMPLE_SIZE));
        assertNoEmbeddings(path);
        expect(path).toMatch(LIMIT_RE);
        return rows;
      }
      if (method === "POST" && path === "/SemanticSearch") {
        const target = calls.filter((c) => c.method === "POST").length - 1;
        return [{ id: rows[target]!.id }];
      }
      throw new Error(`unexpected ${method} ${path}`);
    };

    const result = await fetchRecallSpotCheckData("flint", "http://127.0.0.1:9926", { request });
    expect(result.ok).toBe(true);
    expect(result.sampledIds).toHaveLength(QUALITY_RECALL_SAMPLE_SIZE);

    const memoryGets = calls.filter((c) => c.method === "GET" && c.path.startsWith("/Memory"));
    expect(memoryGets).toHaveLength(1);
    expect(memoryGets[0]!.path).not.toBe("/Memory?agentId=flint");
    expect(memoryGets[0]!.path).not.toMatch(/^\/Memory\?agentId=[^&]+$/);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/SemanticSearch")).toHaveLength(QUALITY_RECALL_SAMPLE_SIZE);
  });

  test("a mocked 3k-row store with embeddings is never requested — the URL itself forbids it", async () => {
    const request: QualityApi = async (method, path) => {
      if (method === "GET") {
        assertNoEmbeddings(path);
        const limit = path.match(LIMIT_RE);
        expect(Number(limit![2])).toBeLessThan(3000);
        return scorableRows(5);
      }
      throw new Error("search should not run — too few rows");
    };
    const result = await fetchRecallSpotCheckData("flint", "http://127.0.0.1:9926", { request });
    expect(result.ok).toBe(false);
    expect(result.skipReason).toMatch(/fewer than the 10 needed/);
  });
});

describe("flair#1360 — fetchPreviousQualitySnapshot does not pull embeddings", () => {
  test("GETs the projected snapshot path, never an unfiltered collection", async () => {
    const subject = qualitySnapshotSubject("http://127.0.0.1:9926");
    const snapshot = {
      schemaVersion: 1,
      computedAt: "2026-08-23T00:00:00.000Z",
      agentFilter: "flint",
      embeddingCoverage: { coveragePct: 95 },
      staleness: { stalePct: 5 },
      recallSpotCheck: { recallAtK: 0.9, mrr: 0.8 },
      quietAgents: { perAgent: [] },
      dedupClusters: { clusterCount: 0 },
    };
    const calls: string[] = [];
    const request: QualityApi = async (method, path) => {
      expect(method).toBe("GET");
      calls.push(path);
      expect(path).toBe(qualitySnapshotLookupPath("flint", subject));
      assertNoEmbeddings(path);
      return [
        { id: "other", subject: "unrelated", content: "{}", createdAt: "2026-08-22T00:00:00.000Z" },
        { id: "snap", subject, content: JSON.stringify(snapshot), createdAt: "2026-08-23T00:00:00.000Z" },
      ];
    };

    const got = await fetchPreviousQualitySnapshot("flint", "http://127.0.0.1:9926", subject, { request });
    expect(got).toEqual(snapshot);
    expect(calls).toEqual([qualitySnapshotLookupPath("flint", subject)]);
    expect(calls[0]).not.toBe("/Memory?agentId=flint");
  });
});
