// ─── Instance-wide dedup-cluster counting primitives (Harper-free) ──────────
// flair-quality Slice 1c (ops/proposals/flair-quality-slice1c-dedup-spec.md,
// K&S-resolved to "Option C, server-side"). Same rationale as ./dedup.ts and
// ./bm25.ts: the graph algorithm here is pure math over an edge list — no
// Harper import, no embeddings, no DB — so it's unit-testable directly
// against the SHIPPED clustering logic without a live Harper.
//
// ── THE INVARIANT ────────────────────────────────────────────────────────────
// This module never sees embeddings and never sees memory content. It
// consumes a list of {a, b} edges (memory-id pairs already determined to be
// near-duplicates by the DB-touching sweep in resources/MemoryDedupStats.ts)
// and reduces them to a small aggregate: how many CONNECTED COMPONENTS
// (clusters) exist, how big the largest one is, and how many memories fall
// into any cluster. Per Kern's design note (K&S round), a cluster of 5
// memories is 1 cluster, not 10 pairwise edges — this module is what makes
// that true (union-find over the edge list, not a raw edge count).
//
// No per-memory membership is retained past the union-find pass — the
// public output is the aggregate ONLY (Sherlock's disclosure-surface
// constraint: no per-memory cluster-membership data leaves this module).
import { resolve } from "node:path";
import { homedir } from "node:os";

/** Re-exported home for the single-source-of-truth cosine threshold this
 *  module's caller (MemoryDedupStats.ts) gates edges on — see ./dedup.ts's
 *  DEDUP_COSINE_THRESHOLD_DEFAULT (0.95). Not redefined here; this module
 *  only counts edges, it never decides what counts as "near-duplicate". */
export { DEDUP_COSINE_THRESHOLD_DEFAULT } from "./dedup.js";

/** Bounded-k ANN fan-out per memory (Kern's efficiency framing: "bounded-k
 *  ANN query per memory... O(n·k·log n)"). 10 is generous headroom for a
 *  cosine>=0.95 near-duplicate gate — a true near-duplicate is overwhelmingly
 *  likely to be its counterpart's #1 or #2 nearest neighbor, so even a large
 *  (>10-member) cluster stays fully connected as long as each member finds
 *  AT LEAST ONE clustermate within its own top-k (transitivity does the
 *  rest via union-find). Exported so the sweep and its tests share one
 *  tunable instead of a duplicated literal. */
export const DEDUP_CLUSTER_ANN_K_DEFAULT = 10;

/** Defensive cap on how many (non-archived) memories the nightly sweep will
 *  walk in one cycle — protects wall-clock time on a very large instance.
 *  This is a SAFETY bound, not a routine sampling strategy: real-world
 *  self-hosted instances are expected to sit well under this for the
 *  foreseeable future, and the brief explicitly asked to prefer the full ANN
 *  sweep over sampling. When the instance exceeds this, the sweep covers the
 *  most-recently-created N memories (deterministic, documented) rather than
 *  a random sample. */
export const DEDUP_CLUSTER_MAX_MEMORIES_DEFAULT = 20_000;

/** Server-side stat artifact home (Slice 1c Part 2 — smallest-surface
 *  storage choice). A single small JSON file under the SERVER's own
 *  `~/.flair/`, written by MemoryDedupStats.ts's post() and read by
 *  health.ts's HealthDetail — both run INSIDE the same Harper process, so
 *  this is always the same file regardless of where the CLI/runner that
 *  TRIGGERED the sweep is running (see MemoryDedupStats.ts's module doc for
 *  why that distinction matters for remote/federated deployments). Mirrors
 *  the `REM_PAUSE_FLAG` "small well-known file directly under ~/.flair/"
 *  precedent in src/rem/runner.ts, rather than nesting under logs/ (this is
 *  a single overwritten snapshot, not an append-only log). */
export const REM_DEDUP_STATS_PATH = resolve(homedir(), ".flair", "rem-dedup-stats.json");

export interface DedupEdge {
  a: string;
  b: string;
}

export interface DedupClusterStats {
  clusterCount: number;
  largestClusterSize: number;
  totalMemoriesInClusters: number;
}

/** Minimal union-find (disjoint-set) with path compression + union-by-rank.
 *  Nodes are created lazily — a memory id only enters the structure when it
 *  appears in at least one edge, so a memory with zero near-duplicate edges
 *  (the common case) never shows up in the output at all. */
class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  private ensure(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    this.ensure(x);
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  nodes(): string[] {
    return [...this.parent.keys()];
  }
}

/**
 * Reduces a near-duplicate edge list to the cluster aggregate `flair
 * quality` renders. A "cluster" requires >=2 connected memories — a memory
 * with no qualifying edge never enters the graph, so it's correctly excluded
 * (never counted as a size-1 "cluster").
 *
 * Self-loop edges (a === b — a memory paired with itself, which the sweep
 * should already exclude, but this function stays defensive) are ignored:
 * they can never form or grow a cluster.
 *
 * Duplicate/symmetric edges (the sweep may discover the SAME pair from both
 * directions — A's neighbor search finds B, and independently B's finds A)
 * are harmless: union() on an already-joined pair is a no-op.
 */
export function countDedupClusters(edges: DedupEdge[]): DedupClusterStats {
  const uf = new UnionFind();
  for (const { a, b } of edges) {
    if (a === b) continue;
    uf.union(a, b);
  }

  const sizeByRoot = new Map<string, number>();
  for (const id of uf.nodes()) {
    const root = uf.find(id);
    sizeByRoot.set(root, (sizeByRoot.get(root) ?? 0) + 1);
  }

  let clusterCount = 0;
  let largestClusterSize = 0;
  let totalMemoriesInClusters = 0;
  for (const size of sizeByRoot.values()) {
    if (size < 2) continue; // shouldn't happen (a root only exists via an edge), but stay defensive
    clusterCount++;
    totalMemoriesInClusters += size;
    if (size > largestClusterSize) largestClusterSize = size;
  }

  return { clusterCount, largestClusterSize, totalMemoriesInClusters };
}
