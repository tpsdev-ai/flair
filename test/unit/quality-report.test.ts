/**
 * quality-report.test.ts — Unit tests for `computeQualityReport`, the pure
 * metric-computation core behind `flair quality` (Slice 1a of the
 * memory-quality-observability arc, ops/proposals/flair-quality-slice1-spec.md).
 *
 * Same pattern as doctor-summary.test.ts / doctor-agent-iteration.test.ts:
 * the CLI action drives a network fetch + a long console.log sequence
 * (high-effort/low-value to exercise directly), so the actual metric math is
 * extracted into a pure function and tested here against fixture
 * /HealthDetail-shaped payloads. No fetch, no fs, no Harper.
 */

import { describe, test, expect } from "bun:test";
import {
  computeQualityReport,
  QUALITY_QUIET_THRESHOLD_DAYS,
  QUALITY_HASH_FALLBACK_DEGRADED_PCT,
} from "../../src/cli.ts";

const NOW = new Date("2026-07-21T12:00:00.000Z").getTime();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// A realistic /HealthDetail fixture — field names match resources/health.ts's
// actual get() output (memories.{total,withEmbeddings,hashFallback,
// modelCounts,expired}, agents.perAgent[].{id,memoryCount,hashFallback,
// writes24h,lastWriteAt}, migrations.migrations[].{id,state,reason}) — NOT
// the design doc's originally-named fields (verified against the resolver,
// not trusted from memory).
function fixture(overrides: Record<string, any> = {}) {
  return {
    ok: true,
    caller: { agentId: "flint", isAdmin: true },
    memories: {
      total: 100,
      withEmbeddings: 95,
      hashFallback: 5,
      modelCounts: { "nomic-embed-text": 95, "hash-512d": 5 },
      byDurability: { permanent: 5, persistent: 20, standard: 70, ephemeral: 5 },
      archived: 2,
      expired: 8,
    },
    lastWrite: daysAgo(0),
    agents: {
      count: 3,
      names: ["flint", "anvil", "pulse"],
      perAgent: [
        { id: "flint", memoryCount: 60, hashFallback: 2, writes24h: 5, lastWriteAt: daysAgo(0) },
        { id: "anvil", memoryCount: 30, hashFallback: 5, writes24h: 0, lastWriteAt: daysAgo(3) },
        { id: "pulse", memoryCount: 10, hashFallback: 3, writes24h: 0, lastWriteAt: daysAgo(30) },
      ],
    },
    migrations: {
      cyclePhase: "idle",
      lastCycleAt: daysAgo(1),
      migrations: [{ id: "embedding-backfill", rowsDone: 100, rowsRemaining: 0, state: "completed" }],
    },
    version: "0.25.4",
    pid: 12345,
    uptimeSeconds: 3600,
    warnings: [],
    ...overrides,
  };
}

describe("computeQualityReport", () => {
  describe("instance health", () => {
    test("healthy + clean migrations + coverage under threshold → ok/clean/ok", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW });
      expect(r.instance.up).toBe(true);
      expect(r.instance.migrationsClean).toBe(true);
      expect(r.instance.haltedMigrations).toEqual([]);
      expect(r.instance.embeddingsStatus).toBe("ok");
    });

    test("unreachable instance → up: false, everything else degrades gracefully (no crash)", () => {
      const r = computeQualityReport(false, null, { now: NOW });
      expect(r.instance.up).toBe(false);
      expect(r.instance.migrationsClean).toBeNull();
      expect(r.instance.embeddingsStatus).toBe("unknown");
      expect(r.embeddingCoverage).toBeNull();
      expect(r.staleness).toBeNull();
      expect(r.signalDensity).toBeNull();
      expect(r.quietAgents).toBeNull();
      expect(r.gaps.length).toBeGreaterThan(0);
    });

    test("halted migration → migrationsClean: false, surfaced in haltedMigrations", () => {
      const data = fixture({
        migrations: {
          cyclePhase: "idle",
          migrations: [
            { id: "embedding-backfill", rowsDone: 50, rowsRemaining: 50, state: "halted", reason: "disk full" },
            { id: "other", rowsDone: 10, rowsRemaining: 0, state: "completed" },
          ],
        },
      });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.instance.migrationsClean).toBe(false);
      expect(r.instance.haltedMigrations).toEqual([{ id: "embedding-backfill", state: "halted", reason: "disk full" }]);
    });

    test("no migrations block at all → migrationsClean: null + a gap entry (not a false 'clean')", () => {
      const data = fixture();
      delete (data as any).migrations;
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.instance.migrationsClean).toBeNull();
      expect(r.gaps.some((g) => g.metric === "instance.migrationsClean")).toBe(true);
    });

    test("hash-fallback at/above the degraded threshold → embeddings degraded", () => {
      const data = fixture({
        memories: { total: 100, withEmbeddings: 89, hashFallback: 11, modelCounts: { x: 89, "hash-512d": 11 }, expired: 0 },
      });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.instance.embeddingsStatus).toBe("degraded");
      expect(r.instance.embeddingsDetail).toContain("11/100");
    });

    test("hash-fallback exactly at the threshold boundary counts as degraded (>=, not >)", () => {
      const data = fixture({
        memories: { total: 100, withEmbeddings: 90, hashFallback: QUALITY_HASH_FALLBACK_DEGRADED_PCT, modelCounts: {}, expired: 0 },
      });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.instance.embeddingsStatus).toBe("degraded");
    });

    test("mixed real embedding models (multiple non-hash-fallback models) → degraded even under the % threshold", () => {
      const data = fixture({
        memories: { total: 100, withEmbeddings: 98, hashFallback: 2, modelCounts: { "model-a": 60, "model-b": 38, "hash-512d": 2 }, expired: 0 },
      });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.instance.embeddingsStatus).toBe("degraded");
      expect(r.instance.embeddingsDetail).toContain("multiple embedding models");
    });

    test("zero memories → embeddings status unknown, not a false 'ok'", () => {
      const data = fixture({ memories: { total: 0, withEmbeddings: 0, hashFallback: 0, modelCounts: {}, expired: 0 } });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.instance.embeddingsStatus).toBe("unknown");
    });
  });

  describe("embedding coverage", () => {
    test("computes coverage % from withEmbeddings/total", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW });
      expect(r.embeddingCoverage).toEqual({ total: 100, withEmbeddings: 95, hashFallback: 5, coveragePct: 95 });
    });

    test("missing memories block → null + gap", () => {
      const data = fixture();
      delete (data as any).memories;
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.embeddingCoverage).toBeNull();
      expect(r.gaps.some((g) => g.metric === "embeddingCoverage")).toBe(true);
    });
  });

  describe("staleness", () => {
    test("computes % past validTo (expired/total) from the instance-wide `expired` count", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW });
      expect(r.staleness).toEqual({ scope: "instance", total: 100, expired: 8, stalePct: 8 });
    });

    test("always notes the instance-wide-only + never-recalled gap, even when the metric ships", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW });
      expect(r.gaps.some((g) => g.metric === "staleness" && g.reason.includes("instance-wide"))).toBe(true);
    });

    test("zero total memories → 0% staleness, not NaN/division-by-zero", () => {
      const data = fixture({ memories: { total: 0, withEmbeddings: 0, hashFallback: 0, modelCounts: {}, expired: 0 } });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.staleness).toEqual({ scope: "instance", total: 0, expired: 0, stalePct: 0 });
    });

    test("no expired count in the payload → null + gap", () => {
      const data = fixture({ memories: { total: 100, withEmbeddings: 90, hashFallback: 10, modelCounts: {} } });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.staleness).toBeNull();
      expect(r.gaps.some((g) => g.metric === "staleness" && g.reason.includes("no expired"))).toBe(true);
    });
  });

  describe("signal density — degrades to write-volume-only when the server predates per-agent usageCount (Slice 1a shape)", () => {
    test("all agents by default", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW });
      expect(r.signalDensity?.scope).toBe("write-volume");
      expect(r.signalDensity?.perAgent).toEqual([
        { id: "flint", memoryCount: 60, writes24h: 5, lastWriteAt: daysAgo(0) },
        { id: "anvil", memoryCount: 30, writes24h: 0, lastWriteAt: daysAgo(3) },
        { id: "pulse", memoryCount: 10, writes24h: 0, lastWriteAt: daysAgo(30) },
      ]);
      // No row carries `usageCount` — fixture() is a Slice-1a-shaped /HealthDetail
      // payload — so citationRate/usageCount must not appear on any row at all
      // (never a silent 0 masquerading as real data).
      for (const row of r.signalDensity?.perAgent ?? []) {
        expect((row as any).usageCount).toBeUndefined();
        expect((row as any).citationRate).toBeUndefined();
      }
      // Citation-rate gap always noted, with the "upgrade the server" framing.
      expect(
        r.gaps.some(
          (g) =>
            g.metric === "signalDensity" &&
            g.reason.includes("citation rate unavailable") &&
            g.reason.includes("predates") &&
            g.reason.includes("usageCount"),
        ),
      ).toBe(true);
    });

    test("--agent scopes to exactly that agent's row", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW, agentId: "anvil" });
      expect(r.signalDensity?.perAgent).toEqual([{ id: "anvil", memoryCount: 30, writes24h: 0, lastWriteAt: daysAgo(3) }]);
    });

    test("--agent for an id not present in perAgent → empty array, not a crash", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW, agentId: "nonexistent" });
      expect(r.signalDensity?.perAgent).toEqual([]);
    });

    test("no per-agent stats → null + gap", () => {
      const data = fixture();
      delete (data as any).agents;
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.signalDensity).toBeNull();
      expect(r.gaps.some((g) => g.metric === "signalDensity" && g.reason.includes("no per-agent stats"))).toBe(true);
    });

    test("MIXED presence (some rows have usageCount, some don't) still degrades — a server either supports the aggregate for all agents or none", () => {
      const data = fixture({
        agents: {
          count: 2,
          perAgent: [
            { id: "flint", memoryCount: 60, hashFallback: 2, writes24h: 5, lastWriteAt: daysAgo(0), usageCount: 30 },
            { id: "anvil", memoryCount: 30, hashFallback: 5, writes24h: 0, lastWriteAt: daysAgo(3) }, // no usageCount
          ],
        },
      });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.signalDensity?.scope).toBe("write-volume");
      expect((r.signalDensity?.perAgent[0] as any).citationRate).toBeUndefined();
    });
  });

  describe("signal density — write-and-citation (server reports per-agent usageCount, Slice 1b)", () => {
    function fixtureWithUsage(usageByAgent: Record<string, number>) {
      return fixture({
        agents: {
          count: 3,
          names: ["flint", "anvil", "pulse"],
          perAgent: [
            { id: "flint", memoryCount: 60, hashFallback: 2, writes24h: 5, lastWriteAt: daysAgo(0), usageCount: usageByAgent.flint ?? 0 },
            { id: "anvil", memoryCount: 30, hashFallback: 5, writes24h: 0, lastWriteAt: daysAgo(3), usageCount: usageByAgent.anvil ?? 0 },
            { id: "pulse", memoryCount: 10, hashFallback: 3, writes24h: 0, lastWriteAt: daysAgo(30), usageCount: usageByAgent.pulse ?? 0 },
          ],
        },
      });
    }

    test("computes citationRate = round(usageCount / memoryCount, 2) per agent and flips scope", () => {
      const data = fixtureWithUsage({ flint: 30, anvil: 3, pulse: 0 });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.signalDensity?.scope).toBe("write-and-citation");
      expect(r.signalDensity?.perAgent).toEqual([
        { id: "flint", memoryCount: 60, writes24h: 5, lastWriteAt: daysAgo(0), usageCount: 30, citationRate: 0.5 },
        { id: "anvil", memoryCount: 30, writes24h: 0, lastWriteAt: daysAgo(3), usageCount: 3, citationRate: 0.1 },
        { id: "pulse", memoryCount: 10, writes24h: 0, lastWriteAt: daysAgo(30), usageCount: 0, citationRate: 0 },
      ]);
    });

    test("drops the old 'citation rate unavailable' gap entry once the server supplies usageCount", () => {
      const data = fixtureWithUsage({ flint: 30, anvil: 3, pulse: 0 });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.gaps.some((g) => g.metric === "signalDensity")).toBe(false);
    });

    test("citationRate rounds to 2 decimal places, not a long float", () => {
      const data = fixtureWithUsage({ flint: 1, anvil: 0, pulse: 0 }); // 1/60 = 0.016666...
      const r = computeQualityReport(true, data, { now: NOW });
      const flintRow = r.signalDensity?.perAgent.find((r) => r.id === "flint");
      expect(flintRow?.citationRate).toBe(0.02);
    });

    test("memoryCount 0 → citationRate 0, not NaN/Infinity (division-by-zero guard)", () => {
      const data = fixture({
        agents: {
          count: 1,
          perAgent: [{ id: "fresh", memoryCount: 0, hashFallback: 0, writes24h: 0, lastWriteAt: null, usageCount: 0 }],
        },
      });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.signalDensity?.perAgent[0]).toEqual({
        id: "fresh", memoryCount: 0, writes24h: 0, lastWriteAt: null, usageCount: 0, citationRate: 0,
      });
    });

    test("--agent scopes to exactly that agent's row, citationRate included", () => {
      const data = fixtureWithUsage({ flint: 30, anvil: 3, pulse: 0 });
      const r = computeQualityReport(true, data, { now: NOW, agentId: "anvil" });
      expect(r.signalDensity?.perAgent).toEqual([
        { id: "anvil", memoryCount: 30, writes24h: 0, lastWriteAt: daysAgo(3), usageCount: 3, citationRate: 0.1 },
      ]);
    });
  });

  describe("quiet agents", () => {
    test("flags agents at/over the threshold, not under it", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW });
      const byId = Object.fromEntries((r.quietAgents?.perAgent ?? []).map((a) => [a.id, a]));
      expect(byId.flint.quiet).toBe(false); // 0 days
      expect(byId.anvil.quiet).toBe(false); // 3 days < 7
      expect(byId.pulse.quiet).toBe(true); // 30 days >= 7
      expect(r.quietAgents?.thresholdDays).toBe(QUALITY_QUIET_THRESHOLD_DAYS);
      expect(r.quietAgents?.quietCount).toBe(1);
    });

    test("exactly at the threshold boundary counts as quiet (>=, not >)", () => {
      const data = fixture({
        agents: {
          count: 1,
          perAgent: [{ id: "solo", memoryCount: 5, hashFallback: 0, writes24h: 0, lastWriteAt: daysAgo(QUALITY_QUIET_THRESHOLD_DAYS) }],
        },
      });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.quietAgents?.perAgent[0].quiet).toBe(true);
      expect(r.quietAgents?.perAgent[0].daysSinceLastWrite).toBe(QUALITY_QUIET_THRESHOLD_DAYS);
    });

    test("agent with no lastWriteAt at all → quiet: true, daysSinceLastWrite: null ('never written', not a crash)", () => {
      const data = fixture({
        agents: {
          count: 1,
          perAgent: [{ id: "fresh", memoryCount: 0, hashFallback: 0, writes24h: 0, lastWriteAt: null }],
        },
      });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.quietAgents?.perAgent[0]).toEqual({
        id: "fresh",
        memoryCount: 0,
        writes24h: 0,
        lastWriteAt: null,
        daysSinceLastWrite: null,
        quiet: true,
      });
    });

    test("--agent scopes quiet-agent detection to one agent", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW, agentId: "pulse" });
      expect(r.quietAgents?.perAgent.map((a) => a.id)).toEqual(["pulse"]);
      expect(r.quietAgents?.quietCount).toBe(1);
    });
  });

  describe("dedup clusters (flair-quality Slice 1c — instance-wide near-duplicate cluster count)", () => {
    test("server reports a dedup stat → populated, no gap", () => {
      const data = fixture({
        dedup: { clusterCount: 3, largestClusterSize: 5, totalMemoriesInClusters: 11, computedAt: daysAgo(0) },
      });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.dedupClusters).toEqual({
        clusterCount: 3,
        largestClusterSize: 5,
        totalMemoriesInClusters: 11,
        computedAt: daysAgo(0),
      });
      expect(r.gaps.some((g) => g.metric === "dedupClusters")).toBe(false);
    });

    test("no dedup field at all (fresh instance / REM never ran the step / older server) → null + gap, never a false zero", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW });
      expect(r.dedupClusters).toBeNull();
      expect(r.gaps.some((g) => g.metric === "dedupClusters" && g.reason.includes("REM"))).toBe(true);
    });

    test("dedup field present but null (server computed HealthDetail's shape, REM hasn't run yet) → null + gap", () => {
      const data = fixture({ dedup: null });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.dedupClusters).toBeNull();
      expect(r.gaps.some((g) => g.metric === "dedupClusters")).toBe(true);
    });

    test("malformed/partial dedup shape (missing a field) → null + gap, not a crash or partial object", () => {
      const data = fixture({ dedup: { clusterCount: 3 } });
      const r = computeQualityReport(true, data, { now: NOW });
      expect(r.dedupClusters).toBeNull();
      expect(r.gaps.some((g) => g.metric === "dedupClusters")).toBe(true);
    });

    test("--agent does not filter dedupClusters — it's instance-wide by construction (no per-memory cluster membership is ever exposed)", () => {
      const data = fixture({
        dedup: { clusterCount: 2, largestClusterSize: 3, totalMemoriesInClusters: 5, computedAt: daysAgo(1) },
      });
      const r = computeQualityReport(true, data, { now: NOW, agentId: "anvil" });
      expect(r.dedupClusters).toEqual({
        clusterCount: 2,
        largestClusterSize: 3,
        totalMemoriesInClusters: 5,
        computedAt: daysAgo(1),
      });
    });
  });

  describe("--json output shape (the full report object)", () => {
    test("top-level keys are stable — agentFilter, instance, embeddingCoverage, staleness, signalDensity, quietAgents, dedupClusters, gaps", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW });
      expect(Object.keys(r).sort()).toEqual(
        ["agentFilter", "embeddingCoverage", "gaps", "instance", "quietAgents", "signalDensity", "staleness", "dedupClusters"].sort(),
      );
    });

    test("agentFilter reflects the --agent value, or null for the fleet-wide default", () => {
      expect(computeQualityReport(true, fixture(), { now: NOW }).agentFilter).toBeNull();
      expect(computeQualityReport(true, fixture(), { now: NOW, agentId: "flint" }).agentFilter).toBe("flint");
    });

    test("report is JSON-serializable with no undefined/function leakage", () => {
      const r = computeQualityReport(true, fixture(), { now: NOW });
      expect(() => JSON.stringify(r)).not.toThrow();
      const round = JSON.parse(JSON.stringify(r));
      expect(round.instance.up).toBe(true);
    });
  });
});
