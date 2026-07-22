/**
 * dedup-cluster.test.ts — Unit tests for countDedupClusters, the pure
 * connected-components reduction behind flair-quality Slice 1c's
 * instance-wide dedup-cluster stat (resources/dedup-cluster.ts).
 *
 * Harper-free by construction (see that module's doc) — these tests feed
 * hand-built edge lists (as if produced by MemoryDedupStats.ts's ANN sweep)
 * and assert on the SHIPPED clustering math directly, no live Harper needed.
 */

import { describe, test, expect } from "bun:test";
import { countDedupClusters, type DedupEdge } from "../../resources/dedup-cluster.ts";

describe("countDedupClusters", () => {
  test("no edges → zero clusters", () => {
    const r = countDedupClusters([]);
    expect(r).toEqual({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0 });
  });

  test("a single pair forms exactly one cluster of size 2", () => {
    const r = countDedupClusters([{ a: "m1", b: "m2" }]);
    expect(r).toEqual({ clusterCount: 1, largestClusterSize: 2, totalMemoriesInClusters: 2 });
  });

  test("overlapping pairs merge into one cluster, not two — a chain (A-B, B-C) is 1 cluster of 3", () => {
    const edges: DedupEdge[] = [
      { a: "m1", b: "m2" },
      { a: "m2", b: "m3" },
    ];
    const r = countDedupClusters(edges);
    expect(r).toEqual({ clusterCount: 1, largestClusterSize: 3, totalMemoriesInClusters: 3 });
  });

  test("a 5-memory cluster (4 chained edges) counts as 1 cluster, not 4 pairs", () => {
    const edges: DedupEdge[] = [
      { a: "m1", b: "m2" },
      { a: "m2", b: "m3" },
      { a: "m3", b: "m4" },
      { a: "m4", b: "m5" },
    ];
    const r = countDedupClusters(edges);
    expect(r.clusterCount).toBe(1);
    expect(r.largestClusterSize).toBe(5);
    expect(r.totalMemoriesInClusters).toBe(5);
  });

  test("a densely-connected 5-memory cluster (10 pairwise edges, a 'cluster of 5 = 1 cluster, not 10 pairs') still reduces to 1 cluster of 5", () => {
    const ids = ["m1", "m2", "m3", "m4", "m5"];
    const edges: DedupEdge[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        edges.push({ a: ids[i], b: ids[j] });
      }
    }
    expect(edges.length).toBe(10);
    const r = countDedupClusters(edges);
    expect(r).toEqual({ clusterCount: 1, largestClusterSize: 5, totalMemoriesInClusters: 5 });
  });

  test("two disjoint clusters are counted separately, sized independently", () => {
    const edges: DedupEdge[] = [
      { a: "m1", b: "m2" },
      { a: "m2", b: "m3" }, // cluster A: m1,m2,m3 (size 3)
      { a: "m9", b: "m10" }, // cluster B: m9,m10 (size 2)
    ];
    const r = countDedupClusters(edges);
    expect(r.clusterCount).toBe(2);
    expect(r.largestClusterSize).toBe(3);
    expect(r.totalMemoriesInClusters).toBe(5); // 3 + 2
  });

  test("singletons (memories with no qualifying edge) never appear — they simply aren't in the edge list, so no cluster forms for them", () => {
    // A memory with zero near-duplicate edges never produces an edge at
    // all — this test documents that the reducer's INPUT contract already
    // excludes singletons; there is no node-list param to accidentally
    // over-count them as size-1 "clusters".
    const r = countDedupClusters([{ a: "m1", b: "m2" }]);
    expect(r.clusterCount).toBe(1); // only the real pair, nothing else
  });

  test("self-loop edges (a === b) are ignored defensively — never form or grow a cluster", () => {
    const r = countDedupClusters([{ a: "m1", b: "m1" }]);
    expect(r).toEqual({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0 });
  });

  test("duplicate/symmetric edges (both directions discovered independently) are harmless — union is idempotent", () => {
    const edges: DedupEdge[] = [
      { a: "m1", b: "m2" },
      { a: "m2", b: "m1" }, // same pair, reverse direction
      { a: "m1", b: "m2" }, // exact duplicate
    ];
    const r = countDedupClusters(edges);
    expect(r).toEqual({ clusterCount: 1, largestClusterSize: 2, totalMemoriesInClusters: 2 });
  });

  test("a bridge edge merges two previously-separate clusters into one", () => {
    const edges: DedupEdge[] = [
      { a: "m1", b: "m2" }, // cluster A
      { a: "m3", b: "m4" }, // cluster B
      { a: "m2", b: "m3" }, // bridge — merges A and B into one cluster of 4
    ];
    const r = countDedupClusters(edges);
    expect(r).toEqual({ clusterCount: 1, largestClusterSize: 4, totalMemoriesInClusters: 4 });
  });

  test("largestClusterSize reflects the biggest component when sizes vary", () => {
    const edges: DedupEdge[] = [
      { a: "a1", b: "a2" }, // size 2
      { a: "b1", b: "b2" },
      { a: "b2", b: "b3" },
      { a: "b3", b: "b4" }, // size 4 — the largest
      { a: "c1", b: "c2" },
      { a: "c2", b: "c3" }, // size 3
    ];
    const r = countDedupClusters(edges);
    expect(r.clusterCount).toBe(3);
    expect(r.largestClusterSize).toBe(4);
    expect(r.totalMemoriesInClusters).toBe(2 + 4 + 3);
  });
});
