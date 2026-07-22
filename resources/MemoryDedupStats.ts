/**
 * MemoryDedupStats.ts — instance-wide near-duplicate CLUSTER count.
 *
 * POST /MemoryDedupStats — admin-only. Triggered once per REM nightly cycle
 * (src/rem/runner.ts, after the per-agent maintenance/distillation passes —
 * see that file's module doc for why this step is instance-wide rather than
 * folded into the per-agent runner loop).
 *
 * flair-quality Slice 1c (ops/proposals/flair-quality-slice1c-dedup-spec.md).
 * K&S split resolved to "Option C, server-side": Sherlock's hard security
 * objection to a CLI-side computation was that embeddings are the most
 * sensitive data in the system and must never leave the server; Kern's
 * arch counter was that this doesn't fit REM's PER-AGENT pass (which also
 * strips embeddings before handing memories to the model). Resolution:
 * a SEPARATE server-side nightly job — this resource — that:
 *   1. Reads embeddings DIRECTLY off `databases.flair.Memory` (same access
 *      HealthDetail already has — resources/health.ts's `db.flair.Memory.
 *      search({})` reads full records instance-wide for its own stats).
 *   2. Uses them ONLY as HNSW query vectors, via `retrieveCandidates()`
 *      (resources/semantic-retrieval-core.ts) called BARE — the same
 *      in-process, no-HTTP pattern resources/MemoryBootstrap.ts already
 *      uses to reuse SemanticSearch's retrieval core without going over the
 *      wire. The embedding vector itself is never serialized into an HTTP
 *      response or returned to a caller — it lives only in this process's
 *      memory for the span of one ANN query, then is discarded.
 *   3. Persists ONLY the aggregate `{ clusterCount, largestClusterSize,
 *      totalMemoriesInClusters, computedAt }` to REM_DEDUP_STATS_PATH
 *      (resources/dedup-cluster.ts) — never per-memory cluster membership
 *      (Sherlock: that would itself be a disclosure surface), never on
 *      Memory rows (would pollute the authority/attribution path — #735
 *      zero-authority spine).
 *
 * Why the stat file lives on the SERVER's own filesystem (not written by
 * the CLI-side runner, unlike the snapshot/audit-log artifacts in
 * src/rem/snapshot.ts and src/rem/runner.ts): the runner's `apiCall` talks
 * to `flairUrl`, which is not guaranteed to be the same host the CLI runs
 * on (a remote/federated Flair is a real deployment shape — see
 * src/rem/scheduler.ts's `FLAIR_URL` substitution). resources/health.ts's
 * HealthDetail (Part 3 of this slice) is a Resource running INSIDE the same
 * Harper process as this one, so writing here and reading there are
 * guaranteed to be the same file regardless of where the triggering CLI
 * lives. The runner's own audit-log row (src/rem/runner.ts) gets a COPY of
 * the result for convenience/history, but this file is the canonical source
 * `/HealthDetail` reads from.
 *
 * Auth: allowAdmin, matching the codebase's existing convention for
 * INSTANCE-WIDE (not self-scoped) maintenance jobs — see MemoryReindex.ts
 * (also admin-only, also a fleet-wide sweep) and
 * test/unit/resource-allow.test.ts's structural ADMIN_ONLY list, which this
 * resource is added to. Per-agent nightly steps (/MemoryMaintenance,
 * /ReflectMemories) use allowVerified because they're scoped to the calling
 * agent's own memories; this one is never scoped that way — it reads every
 * agent's embeddings — so it follows the admin-gated precedent instead.
 */

import { Resource, databases } from "@harperfast/harper";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { allowAdmin } from "./agent-auth.js";
import { retrieveCandidates } from "./semantic-retrieval-core.js";
import { DEDUP_COSINE_THRESHOLD_DEFAULT } from "./dedup.js";
import {
  countDedupClusters,
  DEDUP_CLUSTER_ANN_K_DEFAULT,
  DEDUP_CLUSTER_MAX_MEMORIES_DEFAULT,
  REM_DEDUP_STATS_PATH,
  type DedupEdge,
} from "./dedup-cluster.js";

const NOT_ARCHIVED = [{ attribute: "archived", comparator: "not_equal", value: true }];

export interface MemoryDedupStatsResult {
  clusterCount: number;
  largestClusterSize: number;
  totalMemoriesInClusters: number;
  computedAt: string;
}

function persistStat(stat: MemoryDedupStatsResult, pathOverride?: string): void {
  const path = pathOverride ?? REM_DEDUP_STATS_PATH;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(stat, null, 2) + "\n", { mode: 0o600 });
}

/**
 * The DB-touching sweep, factored out of post() so it takes an explicit
 * `ctx` and `nowOverride`/`pathOverride` rather than reaching for Resource
 * internals — kept close to post() (not exported broadly) since it needs a
 * live Harper `databases` handle and isn't unit-testable without one; the
 * PURE part (countDedupClusters) is what's unit-tested, in
 * dedup-cluster.ts's own test file.
 */
async function computeAndPersist(ctx: any, opts?: { annK?: number; maxMemories?: number; nowOverride?: Date; pathOverride?: string }): Promise<MemoryDedupStatsResult> {
  const annK = opts?.annK ?? DEDUP_CLUSTER_ANN_K_DEFAULT;
  const maxMemories = opts?.maxMemories ?? DEDUP_CLUSTER_MAX_MEMORIES_DEFAULT;

  // ── 1. Load the sweep set: every non-archived memory's id + embedding,
  // instance-wide (no agentId condition — near-duplicates ACROSS agents are
  // exactly what this stat is for). Bounded to the most-recently-created
  // maxMemories when the instance exceeds the safety cap (see
  // dedup-cluster.ts's doc on why this is a defensive bound, not sampling).
  const all: Array<{ id: string; embedding: number[]; createdAt?: string }> = [];
  for await (const record of (databases as any).flair.Memory.search({
    conditions: NOT_ARCHIVED,
    select: ["id", "embedding", "createdAt"],
  })) {
    if (!record?.id || !Array.isArray(record.embedding) || record.embedding.length === 0) continue;
    all.push({ id: record.id, embedding: record.embedding, createdAt: record.createdAt });
  }

  let sweepSet = all;
  if (all.length > maxMemories) {
    sweepSet = [...all]
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, maxMemories);
  }

  // ── 2. Bounded-k ANN query per memory, via the SAME retrieval core
  // SemanticSearch/MemoryBootstrap use, called bare (in-process, no HTTP —
  // see module doc). Each memory's OWN embedding is the query vector; the
  // vector never leaves this function (select: ["id"] — no embedding field
  // comes back out, and nothing here is returned to an HTTP caller).
  //
  // limit: annK + 1 — a memory's own stored embedding is always its own
  // closest match (cosine 1.0), so the unfiltered result set always
  // contains the memory itself. Fetching one extra slot and filtering self
  // out below (n.id === memory.id) keeps the REAL candidate-neighbor count
  // at the documented annK, rather than silently examining annK-1.
  const edges: DedupEdge[] = [];
  for (const memory of sweepSet) {
    let neighbors: any[];
    try {
      neighbors = await retrieveCandidates({
        queryEmbedding: memory.embedding,
        conditions: NOT_ARCHIVED,
        limit: annK + 1,
        hybrid: false,
        scoring: "raw",
        withSemSimilarity: true,
        select: ["id"],
        ctx,
      });
    } catch {
      // A single memory's ANN query failing (embedding engine hiccup, etc.)
      // must not abort the whole sweep — skip it, the rest still counts.
      continue;
    }
    for (const n of neighbors) {
      if (!n?.id || n.id === memory.id) continue;
      const cosine = typeof n._semSimilarity === "number" ? n._semSimilarity : 0;
      if (cosine >= DEDUP_COSINE_THRESHOLD_DEFAULT) {
        edges.push({ a: memory.id, b: n.id });
      }
    }
  }

  // ── 3. Reduce edges → connected components (pure, unit-tested elsewhere).
  const clusters = countDedupClusters(edges);
  const computedAt = (opts?.nowOverride ?? new Date()).toISOString();
  const result: MemoryDedupStatsResult = { ...clusters, computedAt };

  // ── 4. Persist server-side ONLY the aggregate (never per-memory edges).
  persistStat(result, opts?.pathOverride);

  return result;
}

export class MemoryDedupStats extends Resource {
  async allowCreate(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async post(_data: any) {
    const ctx = (this as any).getContext?.();
    try {
      return await computeAndPersist(ctx);
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err?.message ?? String(err) }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }
}
