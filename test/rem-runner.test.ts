/**
 * rem-runner.test.ts — Unit tests for src/rem/runner.ts.
 *
 * Pure orchestration coverage. No Harper or filesystem state required
 * outside an isolated tmpdir. Tests pause sentinel, env-var pause, dry-run
 * (skip write but still log), happy path (writes snapshot + log row),
 * api failure (fail-stops-cycle + error in log row), soul shape coercion
 * (single row vs multi row), and step 5 distillation (§3B, issue #707): success populates
 * `candidates` and flips `slice` to "2"; failure is recorded in `errors[]`
 * without failing the cycle; dry-run skips the /ReflectMemories call
 * entirely and `slice` stays "2-maintenance".
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runNightlyCycle,
  deriveActiveAdkTags,
  deriveSettledContinuityTags,
  resolveSettleMs,
  ADK_TAG_PREFIX,
  CONTINUITY_TAG_PREFIX,
  DEFAULT_MAX_TAGS_PER_CYCLE,
  DEFAULT_REM_SETTLE_MS,
  type ApiCall,
  type RunnerOpts,
} from "../src/rem/runner.ts";

const sampleMemories = [
  { id: "m1", agentId: "test-agent", content: "first memory", durability: "persistent" },
  { id: "m2", agentId: "test-agent", content: "second memory" },
];
const sampleSoul = { id: "soul-test-agent", agentId: "test-agent", instructions: "be helpful" };

let testRoot: string;
let snapshotRoot: string;
let logPath: string;
let pauseFlagPath: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-rem-runner-test-"));
  snapshotRoot = join(testRoot, "snapshots");
  logPath = join(testRoot, "logs", "rem-nightly.jsonl");
  pauseFlagPath = join(testRoot, "rem.paused");
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function makeApi(handlers: Partial<Record<string, (path: string, body?: unknown) => Promise<any> | any>>): ApiCall {
  return async (method, path) => {
    const key = `${method}:${path.split("?")[0]}`;
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (key === pattern || (pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1)))) {
        return handler!(path);
      }
    }
    throw new Error(`unexpected api call: ${key}`);
  };
}

function readLogRows(): any[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

function baseOpts(overrides: Partial<RunnerOpts> = {}): RunnerOpts {
  return {
    agentId: "test-agent",
    flairVersion: "0.0.0-test",
    apiCall: makeApi({
      "GET:/Memory": () => [{ id: "m1" }, { id: "m2" }],
      "GET:/Soul": () => [{ id: "soul-test-agent", agentId: "test-agent" }],
      "POST:/MemoryCandidate/search_by_conditions": () => [],
      // #1205b-1: default test-agent is a non-ADK agent — enumeration returns
      // no adk: tags, so the cycle takes the unchanged agentId-only path.
      "POST:/Memory/search_by_conditions": () => [],
      "POST:/MemoryMaintenance": () => ({ expired: 0, archived: 0, total: 0, errors: 0 }),
      "POST:/ReflectMemories": () => ({ candidates: [], count: 0, model: "default" }),
      "POST:/MemoryDedupStats": () => ({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
    }),
    snapshotRoot,
    logPath,
    pauseFlagPath,
    envPaused: false,
    ...overrides,
  };
}

describe("pause handling", () => {
  it("exits clean when the pause sentinel exists", async () => {
    mkdirSync(testRoot, { recursive: true });
    writeFileSync(pauseFlagPath, "2026-05-14T03:00:00Z\n");
    const r = await runNightlyCycle(baseOpts());
    expect(r.status).toBe("paused");
    expect(r.snapshotPath).toBeUndefined();
    expect(r.logRow.errors).toEqual([]);
    expect(readLogRows()[0].status).toBe("paused");
  });

  it("exits clean when FLAIR_REM_PAUSE env is set", async () => {
    const r = await runNightlyCycle(baseOpts({ envPaused: true }));
    expect(r.status).toBe("paused");
    expect(r.snapshotPath).toBeUndefined();
  });

  it("runs the cycle when no pause signal", async () => {
    const r = await runNightlyCycle(baseOpts());
    expect(r.status).toBe("completed");
    expect(r.snapshotPath).toBeDefined();
    expect(existsSync(r.snapshotPath!)).toBe(true);
  });
});

describe("happy path", () => {
  it("snapshots, logs, and returns completed status", async () => {
    const r = await runNightlyCycle(baseOpts());
    expect(r.status).toBe("completed");
    expect(r.logRow.memoryCount).toBe(2);
    expect(r.logRow.soulCount).toBe(1);
    expect(r.logRow.pendingCandidates).toBe(0);
    expect(r.logRow.errors).toEqual([]);
    // With distillation wired in this PR, baseline (non-dry-run) cycles are
    // now full slice-2 — distillation was attempted (see rem-runner.test.ts
    // "step 5: distillation" below for the populated-candidates case).
    expect(r.logRow.slice).toBe("2");

    // Log file contains exactly one row.
    const rows = readLogRows();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].snapshotPath).toBe(r.snapshotPath);
  });

  it("reports pendingCandidates from the candidate search", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => [{ id: "m1" }],
        "GET:/Soul": () => [],
        "POST:/MemoryCandidate/search_by_conditions": () => [
          { id: "c1" }, { id: "c2" }, { id: "c3" },
        ],
        "POST:/MemoryMaintenance": () => ({ expired: 0, archived: 0, total: 0, errors: 0 }),
        "POST:/ReflectMemories": () => ({ candidates: [], count: 0, model: "default" }),
        "POST:/MemoryDedupStats": () => ({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
      }),
    }));
    expect(r.logRow.pendingCandidates).toBe(3);
  });

  it("handles Harper response shapes (results[] and items[])", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => ({ results: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }),
        "GET:/Soul": () => ({ items: [{ id: "s1" }] }),
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => ({ expired: 0, archived: 0, total: 0, errors: 0 }),
        "POST:/ReflectMemories": () => ({ candidates: [], count: 0, model: "default" }),
        "POST:/MemoryDedupStats": () => ({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
      }),
    }));
    expect(r.status).toBe("completed");
    expect(r.logRow.memoryCount).toBe(3);
    expect(r.logRow.soulCount).toBe(1);
  });

  it("populates archived and expired from /MemoryMaintenance response", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => sampleMemories,
        "GET:/Soul": () => [sampleSoul],
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => ({ expired: 5, archived: 12, total: 200, errors: 0 }),
        "POST:/ReflectMemories": () => ({ candidates: [], count: 0, model: "default" }),
        "POST:/MemoryDedupStats": () => ({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
      }),
    }));
    expect(r.status).toBe("completed");
    expect(r.logRow.archived).toBe(12);
    expect(r.logRow.expired).toBe(5);
    // Distillation was attempted this cycle (not dry-run) — slice is "2".
    expect(r.logRow.slice).toBe("2");
  });

  it("forwards dryRun to /MemoryMaintenance so counts are accurate without mutation", async () => {
    let receivedDryRun: unknown;
    const r = await runNightlyCycle(baseOpts({
      dryRun: true,
      apiCall: async (method, path, body) => {
        if (method === "POST" && path === "/MemoryMaintenance") {
          receivedDryRun = (body as any)?.dryRun;
          return { expired: 2, archived: 7, total: 100, errors: 0 };
        }
        if (method === "GET" && path.startsWith("/Memory?")) return sampleMemories;
        if (method === "GET" && path.startsWith("/Soul?")) return [sampleSoul];
        if (method === "POST" && path === "/MemoryCandidate/search_by_conditions") return [];
        throw new Error(`unexpected api: ${method}:${path}`);
      },
    }));
    expect(r.status).toBe("dry-run");
    expect(receivedDryRun).toBe(true);
    expect(r.logRow.archived).toBe(7);
    expect(r.logRow.expired).toBe(2);
  });
});

describe("step 5: distillation", () => {
  it("success — audit row slice is '2', candidates lists the staged ids", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => sampleMemories,
        "GET:/Soul": () => [sampleSoul],
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => ({ expired: 0, archived: 0, total: 0, errors: 0 }),
        "POST:/ReflectMemories": () => ({
          candidates: [
            { id: "cand_aaa", claim: "first insight" },
            { id: "cand_bbb", claim: "second insight" },
          ],
          count: 2,
          model: "llama3",
        }),
        "POST:/MemoryDedupStats": () => ({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
      }),
    }));
    expect(r.status).toBe("completed");
    expect(r.logRow.slice).toBe("2");
    expect(r.logRow.candidates).toEqual(["cand_aaa", "cand_bbb"]);
    expect(r.logRow.errors).toEqual([]);
  });

  it("distillation failure is recorded, not fatal — maintenance results stand, status completed", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => sampleMemories,
        "GET:/Soul": () => [sampleSoul],
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => ({ expired: 5, archived: 12, total: 200, errors: 0 }),
        "POST:/ReflectMemories": () => { throw new Error("fetch failed: connection reset"); },
        "POST:/MemoryDedupStats": () => ({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
      }),
    }));
    expect(r.status).toBe("completed");
    expect(r.logRow.slice).toBe("2");
    // Maintenance results from before the failed distillation call stand.
    expect(r.logRow.archived).toBe(12);
    expect(r.logRow.expired).toBe(5);
    expect(r.logRow.candidates).toBeUndefined();
    expect(r.logRow.errors.length).toBe(1);
    expect(r.logRow.errors[0]).toContain("distillation:");
    expect(r.logRow.errors[0]).toContain("fetch failed: connection reset");
  });

  it("no-backend (503) failure is recorded distinctly — structured message, not raw JSON", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => sampleMemories,
        "GET:/Soul": () => [sampleSoul],
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => ({ expired: 0, archived: 0, total: 0, errors: 0 }),
        // Mirrors api()'s throw shape (src/cli.ts) for a 503 response body.
        "POST:/ReflectMemories": () => {
          throw new Error(JSON.stringify({ error: "No generative backend configured. See the models configuration docs." }));
        },
        "POST:/MemoryDedupStats": () => ({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
      }),
    }));
    expect(r.status).toBe("completed");
    expect(r.logRow.errors.length).toBe(1);
    expect(r.logRow.errors[0]).toBe("distillation: No generative backend configured. See the models configuration docs.");
  });

  it("distillation_failed (502) failure surfaces the detail, distinct from the no-backend case", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => sampleMemories,
        "GET:/Soul": () => [sampleSoul],
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => ({ expired: 0, archived: 0, total: 0, errors: 0 }),
        // Mirrors api()'s throw shape (src/cli.ts) for a 502 response body.
        "POST:/ReflectMemories": () => {
          throw new Error(JSON.stringify({ error: "distillation_failed", detail: "model output did not validate after one retry" }));
        },
        "POST:/MemoryDedupStats": () => ({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
      }),
    }));
    expect(r.status).toBe("completed");
    expect(r.logRow.errors.length).toBe(1);
    expect(r.logRow.errors[0]).toBe("distillation: distillation_failed: model output did not validate after one retry");
  });
});

describe("step 6: instance-wide dedup-cluster stat (flair-quality Slice 1c)", () => {
  it("success — populates row.dedup from the /MemoryDedupStats response", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => sampleMemories,
        "GET:/Soul": () => [sampleSoul],
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => ({ expired: 0, archived: 0, total: 0, errors: 0 }),
        "POST:/ReflectMemories": () => ({ candidates: [], count: 0, model: "default" }),
        "POST:/MemoryDedupStats": () => ({
          clusterCount: 3,
          largestClusterSize: 5,
          totalMemoriesInClusters: 11,
          computedAt: "2026-07-22T03:00:00.000Z",
        }),
      }),
    }));
    expect(r.status).toBe("completed");
    expect(r.logRow.errors).toEqual([]);
    expect(r.logRow.dedup).toEqual({
      clusterCount: 3,
      largestClusterSize: 5,
      totalMemoriesInClusters: 11,
      computedAt: "2026-07-22T03:00:00.000Z",
    });
  });

  it("failure (e.g. non-admin caller — the resource is admin-gated) is recorded, not fatal", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => sampleMemories,
        "GET:/Soul": () => [sampleSoul],
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => ({ expired: 0, archived: 0, total: 0, errors: 0 }),
        "POST:/ReflectMemories": () => ({ candidates: [], count: 0, model: "default" }),
        "POST:/MemoryDedupStats": () => { throw new Error(JSON.stringify({ error: "forbidden: admin required" })); },
      }),
    }));
    // Maintenance + distillation already succeeded — the cycle still completes.
    expect(r.status).toBe("completed");
    expect(r.logRow.dedup).toBeUndefined();
    expect(r.logRow.errors.length).toBe(1);
    expect(r.logRow.errors[0]).toBe("dedup: forbidden: admin required");
  });

  it("unexpected response shape is recorded as an error, never a silently-accepted false stat", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => sampleMemories,
        "GET:/Soul": () => [sampleSoul],
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => ({ expired: 0, archived: 0, total: 0, errors: 0 }),
        "POST:/ReflectMemories": () => ({ candidates: [], count: 0, model: "default" }),
        "POST:/MemoryDedupStats": () => ({ ok: true }), // missing the expected fields
      }),
    }));
    expect(r.status).toBe("completed");
    expect(r.logRow.dedup).toBeUndefined();
    expect(r.logRow.errors).toEqual(["dedup: unexpected /MemoryDedupStats response shape"]);
  });

  it("dry-run skips the /MemoryDedupStats call entirely — persisting the stat is a side effect", async () => {
    const calls: string[] = [];
    const r = await runNightlyCycle(baseOpts({
      dryRun: true,
      apiCall: async (method, path, body) => {
        calls.push(`${method}:${path.split("?")[0]}`);
        if (method === "POST" && path === "/MemoryMaintenance") return { expired: 0, archived: 0, total: 0, errors: 0 };
        if (method === "GET" && path.startsWith("/Memory?")) return sampleMemories;
        if (method === "GET" && path.startsWith("/Soul?")) return [sampleSoul];
        if (method === "POST" && path === "/MemoryCandidate/search_by_conditions") return [];
        if (method === "POST" && path === "/MemoryDedupStats") {
          throw new Error("must not be called in dry-run mode");
        }
        throw new Error(`unexpected api: ${method}:${path}`);
      },
    }));
    expect(r.status).toBe("dry-run");
    expect(calls).not.toContain("POST:/MemoryDedupStats");
    expect(r.logRow.dedup).toBeUndefined();
    expect(r.logRow.errors).toEqual([]);
  });
});

describe("dry-run", () => {
  it("logs but does not write a snapshot tarball", async () => {
    const r = await runNightlyCycle(baseOpts({ dryRun: true }));
    expect(r.status).toBe("dry-run");
    expect(r.snapshotPath).toBeUndefined();

    const rows = readLogRows();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("dry-run");
    expect(rows[0].dryRun).toBe(true);
    expect(rows[0].memoryCount).toBe(2);
  });

  it("skips the /ReflectMemories execute call entirely — staging + token spend are side effects", async () => {
    const calls: string[] = [];
    const r = await runNightlyCycle(baseOpts({
      dryRun: true,
      apiCall: async (method, path, body) => {
        calls.push(`${method}:${path.split("?")[0]}`);
        if (method === "POST" && path === "/MemoryMaintenance") {
          expect((body as any)?.dryRun).toBe(true);
          return { expired: 0, archived: 0, total: 0, errors: 0 };
        }
        if (method === "GET" && path.startsWith("/Memory?")) return sampleMemories;
        if (method === "GET" && path.startsWith("/Soul?")) return [sampleSoul];
        if (method === "POST" && path === "/MemoryCandidate/search_by_conditions") return [];
        if (method === "POST" && path === "/ReflectMemories") {
          throw new Error("must not be called in dry-run mode");
        }
        throw new Error(`unexpected api: ${method}:${path}`);
      },
    }));
    expect(r.status).toBe("dry-run");
    expect(calls).not.toContain("POST:/ReflectMemories");
    // Distillation was skipped (not attempted) — slice stays "2-maintenance".
    expect(r.logRow.slice).toBe("2-maintenance");
    expect(r.logRow.candidates).toBeUndefined();
  });
});

describe("failure modes", () => {
  it("captures memory-fetch errors and exits failed without an empty tarball", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => { throw new Error("upstream is down"); },
      }),
    }));
    expect(r.status).toBe("failed");
    expect(r.snapshotPath).toBeUndefined();
    expect(r.logRow.errors.length).toBe(1);
    expect(r.logRow.errors[0]).toContain("upstream is down");

    // Log row recorded.
    const rows = readLogRows();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("failed");
    // No tarball.
    expect(existsSync(join(snapshotRoot, "test-agent"))).toBe(false);
  });

  it("captures soul-fetch errors", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => [{ id: "m1" }],
        "GET:/Soul": () => { throw new Error("soul gone"); },
      }),
    }));
    expect(r.status).toBe("failed");
    expect(r.logRow.errors[0]).toContain("soul gone");
  });

  it("does not fail on candidate-count errors — degrades gracefully to 0", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => [{ id: "m1" }],
        "GET:/Soul": () => [],
        "POST:/MemoryCandidate/search_by_conditions": () => { throw new Error("candidate table missing"); },
        "POST:/MemoryMaintenance": () => ({ expired: 0, archived: 0, total: 0, errors: 0 }),
        "POST:/ReflectMemories": () => ({ candidates: [], count: 0, model: "default" }),
        "POST:/MemoryDedupStats": () => ({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
      }),
    }));
    // Candidate count is a non-fatal signal — the cycle still completes.
    expect(r.status).toBe("completed");
    expect(r.logRow.pendingCandidates).toBe(0);
  });

  it("captures maintenance errors and exits failed (snapshot preserved)", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => [{ id: "m1" }],
        "GET:/Soul": () => [],
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => { throw new Error("maintenance worker offline"); },
      }),
    }));
    expect(r.status).toBe("failed");
    // Snapshot already wrote before maintenance ran — it's preserved.
    expect(r.snapshotPath).toBeDefined();
    expect(existsSync(r.snapshotPath!)).toBe(true);
    expect(r.logRow.errors[0]).toContain("maintenance:");
    expect(r.logRow.errors[0]).toContain("maintenance worker offline");
    expect(r.logRow.slice).toBe("2-maintenance");
  });

  it("treats { error: '...' } maintenance response as failure", async () => {
    const r = await runNightlyCycle(baseOpts({
      apiCall: makeApi({
        "GET:/Memory": () => [{ id: "m1" }],
        "GET:/Soul": () => [],
        "POST:/MemoryCandidate/search_by_conditions": () => [],
        "POST:/MemoryMaintenance": () => ({ error: "agentId required" }),
      }),
    }));
    expect(r.status).toBe("failed");
    expect(r.logRow.errors[0]).toContain("agentId required");
  });
});

describe("log append behavior", () => {
  it("appends consecutive runs to the same log file", async () => {
    await runNightlyCycle(baseOpts({ nowOverride: new Date("2026-05-14T03:00:00.000Z") }));
    await runNightlyCycle(baseOpts({ nowOverride: new Date("2026-05-15T03:00:00.000Z") }));
    const rows = readLogRows();
    expect(rows.length).toBe(2);
    expect(rows[0].runAt).toBe("2026-05-14T03:00:00.000Z");
    expect(rows[1].runAt).toBe("2026-05-15T03:00:00.000Z");
  });

  it("creates the log directory if missing", async () => {
    expect(existsSync(join(testRoot, "logs"))).toBe(false);
    await runNightlyCycle(baseOpts());
    expect(existsSync(logPath)).toBe(true);
  });
});

// ─── #1205b-1: tag-aware, per-user distillation ──────────────────────────────
//
// The core defect this slice fixes: adk-flair collapses (app,user) → one
// agentId, so an agentId-wide distill mixes every user's sessions. The
// tag-aware cycle enumerates the active adk:<app>:<user> tags and distills once
// per tag under scope:"tagged", so each user's candidates come from that user
// alone. See src/rem/runner.ts step 5.

describe("deriveActiveAdkTags (#1205b-1)", () => {
  // Pure reduction over the memories the runner ALREADY fetched for the
  // snapshot (no separate DB query — the Memory resource has no REST
  // search_by_conditions handler; see deriveActiveAdkTags' doc). The recency
  // cutoff is the in-memory threshold-gate.
  const since = new Date("2026-08-14T00:00:00.000Z");
  const recent = "2026-08-16T00:00:00.000Z";
  const old = "2026-08-01T00:00:00.000Z";
  const AGENT = "app-agent";

  it("returns DISTINCT active adk tags, sorted; non-adk tags dropped", () => {
    const mems = [
      { agentId: AGENT, tags: ["adk:app:alice", "episodic"], createdAt: recent },
      { agentId: AGENT, tags: ["adk:app:bob"], createdAt: recent },
      { agentId: AGENT, tags: ["adk:app:alice"], createdAt: recent }, // dupe → deduped
      { agentId: AGENT, tags: ["topic:infra"], createdAt: recent },   // non-adk → dropped
    ];
    const tags = deriveActiveAdkTags(mems, since, AGENT);
    expect(tags).toEqual(["adk:app:alice", "adk:app:bob"]);
    expect(tags).not.toContain("episodic");
    expect(tags).not.toContain("topic:infra");
  });

  it("OWNER-SCOPED: tags from OTHER agents' records are excluded (no cross-agent oracle)", () => {
    // The snapshot fetch is org-wide (Memory is open-within-org); enumeration
    // must confine to the runner's own agentId.
    const mems = [
      { agentId: AGENT, tags: ["adk:app:alice"], createdAt: recent },
      { agentId: "other-agent", tags: ["adk:otherapp:eve"], createdAt: recent }, // NOT ours
    ];
    const tags = deriveActiveAdkTags(mems, since, AGENT);
    expect(tags).toEqual(["adk:app:alice"]);
    expect(tags).not.toContain("adk:otherapp:eve");
  });

  it("recency cutoff (threshold-gate): a tag whose only records predate the cutoff is skipped", () => {
    const mems = [
      { agentId: AGENT, tags: ["adk:app:carol"], createdAt: old },     // idle → skipped
      { agentId: AGENT, tags: ["adk:app:alice"], createdAt: recent },
    ];
    expect(deriveActiveAdkTags(mems, since, AGENT)).toEqual(["adk:app:alice"]);
  });

  it("tolerates missing/malformed rows, tags, and createdAt", () => {
    const mems = [
      null,
      {},
      { agentId: AGENT, tags: null, createdAt: recent },
      { agentId: AGENT, tags: ["adk:x"], createdAt: undefined }, // no createdAt → skipped
      { agentId: AGENT, tags: ["adk:app:alice"], createdAt: recent },
    ] as any[];
    expect(deriveActiveAdkTags(mems, since, AGENT)).toEqual(["adk:app:alice"]);
  });

  it("empty input → []", () => {
    expect(deriveActiveAdkTags([], since, AGENT)).toEqual([]);
  });

  it("selects tags by ADK_TAG_PREFIX", () => {
    expect(ADK_TAG_PREFIX).toBe("adk:");
    expect(deriveActiveAdkTags([{ agentId: AGENT, tags: ["adk:app:z"], createdAt: recent }], since, AGENT)).toEqual(["adk:app:z"]);
  });
});

// Build an apiCall for a cycle. `GET /Memory` returns one recent session
// memory per active tag — that is the SAME set the runner snapshots AND derives
// active adk tags from (#1205b-1). Each scope:"tagged" reflect returns that
// tag's staged candidates.
function makeTagAwareApi(opts: {
  activeTags: string[];
  reflect: (body: any) => any; // maps the /ReflectMemories body → response (or throws)
  // #1205b-2: maps the /AutoPromoteCandidates body → response (or throws).
  // Defaults to a no-op sweep (nothing eligible) so the existing #1205b-1
  // tag-aware tests, which now trigger the post-distillation auto-promote step,
  // stay green.
  autoPromote?: (body: any) => any;
  // flair#1257 slice 3: full memory-row override for tests that need custom
  // createdAt/expiresAt/durability shapes (continuity settle-window cases).
  // When set, `activeTags` is ignored for memory synthesis.
  memories?: any[];
}): { api: ApiCall; reflectCalls: any[]; autoPromoteCalls: any[] } {
  const reflectCalls: any[] = [];
  const autoPromoteCalls: any[] = [];
  const createdAt = new Date().toISOString(); // within the default 48h window
  const memories = opts.memories ?? opts.activeTags.map((t, i) => ({
    id: `m-${i}`, agentId: "test-agent", content: "session", tags: [t], durability: "standard", createdAt,
  }));
  const api: ApiCall = async (method, path, body) => {
    const key = `${method}:${path.split("?")[0]}`;
    if (method === "GET" && path.startsWith("/Memory?")) return memories;
    if (method === "GET" && path.startsWith("/Soul?")) return [sampleSoul];
    if (key === "POST:/MemoryCandidate/search_by_conditions") return [];
    if (key === "POST:/MemoryMaintenance") return { expired: 0, archived: 0, total: 0, errors: 0 };
    if (key === "POST:/ReflectMemories") {
      reflectCalls.push(body);
      return opts.reflect(body);
    }
    if (key === "POST:/AutoPromoteCandidates") {
      autoPromoteCalls.push(body);
      return opts.autoPromote ? opts.autoPromote(body) : { agentId: "test-agent", promoted: [], skipped: [], count: 0, considered: 0 };
    }
    if (key === "POST:/MemoryDedupStats") {
      return { clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-08-16T03:00:00.000Z" };
    }
    throw new Error(`unexpected api: ${key}`);
  };
  return { api, reflectCalls, autoPromoteCalls };
}

describe("tag-aware distillation cycle (#1205b-1)", () => {
  it("PER-TAG: one scope:tagged /ReflectMemories call per active adk tag; candidates aggregated", async () => {
    const { api, reflectCalls } = makeTagAwareApi({
      activeTags: ["adk:app:alice", "adk:app:bob"],
      reflect: (body) => {
        const tag = body.tag as string;
        const user = tag.split(":").pop();
        return { candidates: [{ id: `cand_${user}` }], count: 1, model: "default" };
      },
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api }));

    expect(r.status).toBe("completed");
    // exactly one reflect call per tag, each scope:tagged + execute:true.
    expect(reflectCalls.length).toBe(2);
    for (const call of reflectCalls) {
      expect(call.execute).toBe(true);
      expect(call.scope).toBe("tagged");
      expect(call.agentId).toBe("test-agent");
      expect(typeof call.tag).toBe("string");
    }
    expect(reflectCalls.map((c) => c.tag).sort()).toEqual(["adk:app:alice", "adk:app:bob"]);
    // NO agentId-only (scope-less) reflect call happened — that is the bleed path.
    expect(reflectCalls.some((c) => c.scope === undefined)).toBe(false);
    // aggregated staged ids from every tag.
    expect((r.logRow.candidates ?? []).sort()).toEqual(["cand_alice", "cand_bob"]);
    expect(r.logRow.slice).toBe("2");
    expect(r.logRow.errors).toEqual([]);
  });

  it("NON-ADK fallback: no adk tags → a SINGLE agentId-only distill (unchanged pre-#1205b behavior)", async () => {
    const { api, reflectCalls } = makeTagAwareApi({
      activeTags: [],
      reflect: () => ({ candidates: [{ id: "cand_recent" }], count: 1, model: "default" }),
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api }));

    expect(r.status).toBe("completed");
    expect(reflectCalls.length).toBe(1);
    // agentId-only: no scope, no tag — exactly the old call shape.
    expect(reflectCalls[0]).toEqual({ agentId: "test-agent", execute: true });
    expect(r.logRow.candidates).toEqual(["cand_recent"]);
  });

  it("a per-tag failure is NON-FATAL: other tags still distill, cycle completes, error recorded", async () => {
    const { api, reflectCalls } = makeTagAwareApi({
      activeTags: ["adk:app:alice", "adk:app:bob"],
      reflect: (body) => {
        if (body.tag === "adk:app:bob") throw new Error("fetch failed: connection reset");
        return { candidates: [{ id: "cand_alice" }], count: 1, model: "default" };
      },
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api }));

    expect(r.status).toBe("completed");
    expect(reflectCalls.length).toBe(2); // both attempted
    expect(r.logRow.candidates).toEqual(["cand_alice"]); // alice's still staged
    expect(r.logRow.errors.length).toBe(1);
    expect(r.logRow.errors[0]).toContain("distillation[adk:app:bob]:");
  });

  it("respects the per-cycle tag cap; overflow deferred and recorded", async () => {
    const { api, reflectCalls } = makeTagAwareApi({
      activeTags: ["adk:app:alice", "adk:app:bob", "adk:app:carol"],
      reflect: (body) => ({ candidates: [{ id: `cand_${body.tag.split(":").pop()}` }], count: 1, model: "default" }),
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api, maxTagsPerCycle: 2 }));

    expect(r.status).toBe("completed");
    expect(reflectCalls.length).toBe(2); // capped
    expect(r.logRow.errors.some((e) => e.includes("exceed the per-cycle cap"))).toBe(true);
    expect(DEFAULT_MAX_TAGS_PER_CYCLE).toBeGreaterThan(0);
  });

  it("recency cutoff gates which tags distill: old-only tags are skipped end-to-end", async () => {
    const reflectCalls: any[] = [];
    const cutoff = new Date("2026-08-15T00:00:00.000Z");
    // carol's records predate the cutoff (idle); alice's are recent (active).
    const memories = [
      { id: "m-old", agentId: "test-agent", tags: ["adk:app:carol"], createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "m-new", agentId: "test-agent", tags: ["adk:app:alice"], createdAt: "2026-08-16T00:00:00.000Z" },
    ];
    const api: ApiCall = async (method, path, body) => {
      const key = `${method}:${path.split("?")[0]}`;
      if (method === "GET" && path.startsWith("/Memory?")) return memories;
      if (method === "GET" && path.startsWith("/Soul?")) return [sampleSoul];
      if (key === "POST:/MemoryCandidate/search_by_conditions") return [];
      if (key === "POST:/MemoryMaintenance") return { expired: 0, archived: 0 };
      if (key === "POST:/ReflectMemories") { reflectCalls.push(body); return { candidates: [], count: 0, model: "default" }; }
      if (key === "POST:/AutoPromoteCandidates") return { agentId: "test-agent", promoted: [], skipped: [], count: 0, considered: 0 };
      if (key === "POST:/MemoryDedupStats") return { clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "x" };
      throw new Error(`unexpected api: ${key}`);
    };
    await runNightlyCycle(baseOpts({ apiCall: api, distillSince: cutoff }));
    // Only the RECENT tag (alice) is distilled; carol (old-only) is skipped.
    expect(reflectCalls.map((c) => c.tag)).toEqual(["adk:app:alice"]);
  });
});

// ─── #1205b-2: post-distillation ADK auto-promote wiring ─────────────────────
// The SERVER (resources/AutoPromoteCandidates.ts) enforces every security
// invariant; these runner tests only assert the runner TRIGGERS the sweep at the
// right time (ADK agentId, not dry-run, not for non-ADK agents) and records its
// outcome. The end-to-end security acceptance lives in
// test/integration/adk-auto-promote-1205b2.test.ts.
describe("ADK auto-promote wiring (#1205b-2)", () => {
  it("calls /AutoPromoteCandidates ONCE after distillation for an ADK agentId, with a bounded limit", async () => {
    const { api, autoPromoteCalls } = makeTagAwareApi({
      activeTags: ["adk:app:alice", "adk:app:bob"],
      reflect: (body) => ({ candidates: [{ id: `cand_${(body.tag as string).split(":").pop()}` }], count: 1, model: "default" }),
      autoPromote: () => ({ agentId: "test-agent", promoted: ["m-1", "m-2"], skipped: [{ id: "c-x", reason: "no_adk_scope_tag" }], count: 2, considered: 3 }),
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api }));

    expect(r.status).toBe("completed");
    // exactly one sweep, for this agentId, bounded by a positive limit.
    expect(autoPromoteCalls.length).toBe(1);
    expect(autoPromoteCalls[0].agentId).toBe("test-agent");
    expect(typeof autoPromoteCalls[0].limit).toBe("number");
    expect(autoPromoteCalls[0].limit).toBeGreaterThan(0);
    // outcome recorded on the audit row.
    expect(r.logRow.autoPromoted).toEqual({ promoted: 2, skipped: 1 });
    expect(r.logRow.errors).toEqual([]);
  });

  it("does NOT call /AutoPromoteCandidates for a NON-ADK agent (no adk tags)", async () => {
    const { api, autoPromoteCalls } = makeTagAwareApi({
      activeTags: [],
      reflect: () => ({ candidates: [], count: 0, model: "default" }),
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api }));

    expect(r.status).toBe("completed");
    expect(autoPromoteCalls.length).toBe(0);
    expect(r.logRow.autoPromoted).toBeUndefined();
  });

  it("dry-run skips the auto-promote sweep entirely (a side effect, like distillation)", async () => {
    const { api, autoPromoteCalls, reflectCalls } = makeTagAwareApi({
      activeTags: ["adk:app:alice"],
      reflect: () => ({ candidates: [], count: 0, model: "default" }),
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api, dryRun: true }));

    expect(r.status).toBe("dry-run");
    expect(reflectCalls.length).toBe(0);
    expect(autoPromoteCalls.length).toBe(0);
    expect(r.logRow.autoPromoted).toBeUndefined();
  });

  it("an auto-promote failure is NON-FATAL: recorded in errors, cycle completes", async () => {
    const { api } = makeTagAwareApi({
      activeTags: ["adk:app:alice"],
      reflect: () => ({ candidates: [{ id: "cand_alice" }], count: 1, model: "default" }),
      autoPromote: () => { throw new Error("fetch failed: connection reset"); },
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api }));

    // distillation + maintenance still stand; the cycle is not aborted.
    expect(r.status).toBe("completed");
    expect(r.logRow.candidates).toEqual(["cand_alice"]);
    expect(r.logRow.autoPromoted).toBeUndefined();
    expect(r.logRow.errors.some((e) => e.startsWith("auto-promote:"))).toBe(true);
  });

  it("respects a caller-provided maxAutoPromotePerCycle as the sweep limit", async () => {
    const { api, autoPromoteCalls } = makeTagAwareApi({
      activeTags: ["adk:app:alice"],
      reflect: () => ({ candidates: [], count: 0, model: "default" }),
    });
    await runNightlyCycle(baseOpts({ apiCall: api, maxAutoPromotePerCycle: 7 }));
    expect(autoPromoteCalls[0].limit).toBe(7);
  });
});

// ─── flair#1257 slice 3: continuity-session selection + cycle wiring ─────────
// Selection: deriveSettledContinuityTags — a session distills only once
// SETTLED (newest entry older than the settle window; Kern: measured on the
// NEWEST entry) and only while un-expired entries remain. Wiring: settled
// sessions distill scope:"tagged" + focus:"continuity"; the auto-promote
// sweep fires for continuity-only agents; live sessions are never distilled.
describe("deriveSettledContinuityTags (flair#1257 slice 3)", () => {
  const AGENT = "flint";
  const NOW = new Date("2026-08-20T12:00:00.000Z");
  const SETTLE = DEFAULT_REM_SETTLE_MS; // 2h
  const future = "2026-08-21T00:00:00.000Z";
  const settled3h = "2026-08-20T09:00:00.000Z"; // 3h old → settled
  const live30m = "2026-08-20T11:30:00.000Z";   // 30min old → live
  const T = (s: string) => `${CONTINUITY_TAG_PREFIX}${s}`;

  const row = (tag: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    agentId: AGENT, tags: [tag], durability: "ephemeral", createdAt, expiresAt: future, ...extra,
  });

  it("a session whose NEWEST entry is older than the settle window is selected", () => {
    const mems = [row(T("s1"), "2026-08-20T08:00:00.000Z"), row(T("s1"), settled3h)];
    expect(deriveSettledContinuityTags(mems, { agentId: AGENT, now: NOW, settleMs: SETTLE })).toEqual([T("s1")]);
  });

  it("KERN'S LOAD-BEARING CASE: a 6h-long session quiet only 30min is still LIVE — not selected", () => {
    // Oldest entry is 6h old (well past the window); the NEWEST is 30min old.
    // Measuring on the oldest would select it — the window is on the NEWEST.
    const mems = [row(T("s1"), "2026-08-20T06:00:00.000Z"), row(T("s1"), live30m)];
    expect(deriveSettledContinuityTags(mems, { agentId: AGENT, now: NOW, settleMs: SETTLE })).toEqual([]);
  });

  it("TTL: a fully-expired session is not selected (nothing left to distill)", () => {
    const past = "2026-08-19T00:00:00.000Z";
    const mems = [row(T("s1"), settled3h, { expiresAt: past })];
    expect(deriveSettledContinuityTags(mems, { agentId: AGENT, now: NOW, settleMs: SETTLE })).toEqual([]);
  });

  it("TTL edge: a partially-expired session is still selected off its LIVE rows", () => {
    const past = "2026-08-19T00:00:00.000Z";
    const mems = [
      row(T("s1"), "2026-08-20T08:00:00.000Z", { expiresAt: past }), // expired
      row(T("s1"), settled3h),                                       // live + settled
    ];
    expect(deriveSettledContinuityTags(mems, { agentId: AGENT, now: NOW, settleMs: SETTLE })).toEqual([T("s1")]);
  });

  it("TTL edge: an expired row never marks a session LIVE either (only live rows count for the newest)", () => {
    const past = "2026-08-19T00:00:00.000Z";
    const mems = [
      row(T("s1"), settled3h),                          // live, settled
      row(T("s1"), live30m, { expiresAt: past }),        // 30min old but EXPIRED → ignored
    ];
    expect(deriveSettledContinuityTags(mems, { agentId: AGENT, now: NOW, settleMs: SETTLE })).toEqual([T("s1")]);
  });

  it("rows without expiresAt count as live rows (no TTL stamped — not expired)", () => {
    const mems = [{ agentId: AGENT, tags: [T("s1")], durability: "ephemeral", createdAt: settled3h }];
    expect(deriveSettledContinuityTags(mems, { agentId: AGENT, now: NOW, settleMs: SETTLE })).toEqual([T("s1")]);
  });

  it("PROMOTED rows (persistent, preserved scopeTag) never keep a session selectable — journal tier only", () => {
    // After the journal expires, only the promoted persistent row still
    // carries the tag; counting it would re-distill the session forever.
    const mems = [{ agentId: AGENT, tags: [T("s1"), "auto-promoted"], durability: "persistent", createdAt: settled3h }];
    expect(deriveSettledContinuityTags(mems, { agentId: AGENT, now: NOW, settleMs: SETTLE })).toEqual([]);
  });

  it("OWNER-SCOPED: another agent's sessions are never enumerated", () => {
    const mems = [
      row(T("mine"), settled3h),
      { ...row(T("theirs"), settled3h), agentId: "other-agent" },
    ];
    expect(deriveSettledContinuityTags(mems, { agentId: AGENT, now: NOW, settleMs: SETTLE })).toEqual([T("mine")]);
  });

  it("distinct + sorted; bare prefix and non-continuity tags dropped", () => {
    const mems = [
      row(T("s2"), settled3h),
      row(T("s1"), settled3h),
      row(T("s1"), "2026-08-20T08:00:00.000Z"), // dupe tag
      row("adk:continuity:", settled3h),         // bare prefix → not a session
      row("adk:app:alice", settled3h),           // ADK user tag → not continuity
    ];
    expect(deriveSettledContinuityTags(mems, { agentId: AGENT, now: NOW, settleMs: SETTLE })).toEqual([T("s1"), T("s2")]);
  });

  it("deriveActiveAdkTags EXCLUDES continuity tags (they must never ride the recency path)", () => {
    // Mutation check (run red during development): remove the continuity-skip
    // in deriveActiveAdkTags → this fails — and a LIVE session would distill.
    const since = new Date("2026-08-19T12:00:00.000Z");
    const mems = [
      { agentId: AGENT, tags: [T("s1")], createdAt: live30m },
      { agentId: AGENT, tags: ["adk:app:alice"], createdAt: live30m },
    ];
    expect(deriveActiveAdkTags(mems, since, AGENT)).toEqual(["adk:app:alice"]);
  });

  it("resolveSettleMs: override > FLAIR_REM_SETTLE_HOURS > 2h default", () => {
    expect(resolveSettleMs(undefined, {})).toBe(DEFAULT_REM_SETTLE_MS);
    expect(DEFAULT_REM_SETTLE_MS).toBe(2 * 3600_000);
    expect(resolveSettleMs(undefined, { FLAIR_REM_SETTLE_HOURS: "6" })).toBe(6 * 3600_000);
    expect(resolveSettleMs(1234, { FLAIR_REM_SETTLE_HOURS: "6" })).toBe(1234);
    // garbage env falls back to the default, never NaN
    expect(resolveSettleMs(undefined, { FLAIR_REM_SETTLE_HOURS: "soon" })).toBe(DEFAULT_REM_SETTLE_MS);
    expect(resolveSettleMs(undefined, { FLAIR_REM_SETTLE_HOURS: "-2" })).toBe(DEFAULT_REM_SETTLE_MS);
  });
});

describe("continuity distillation cycle wiring (flair#1257 slice 3)", () => {
  const T = (s: string) => `${CONTINUITY_TAG_PREFIX}${s}`;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  const future = () => new Date(Date.now() + 20 * 3600_000).toISOString();
  const journalRow = (tag: string, createdAt: string) => ({
    id: `j-${tag}-${createdAt}`, agentId: "test-agent", content: "stop: doing things",
    tags: [tag], durability: "ephemeral", visibility: "private", createdAt, expiresAt: future(),
  });

  it("a SETTLED session distills scope:'tagged' + focus:'continuity'; a LIVE one does not; sweep fires; row records the count", async () => {
    const { api, reflectCalls, autoPromoteCalls } = makeTagAwareApi({
      activeTags: [],
      memories: [
        journalRow(T("settled"), hoursAgo(3)),
        journalRow(T("livesess"), hoursAgo(0.2)),
      ],
      reflect: (body) => body.scope === "tagged"
        ? { candidates: [{ id: "cand_cont" }], count: 1, model: "default" }
        : { candidates: [], count: 0, model: "default" },
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api }));

    expect(r.status).toBe("completed");
    // The agentId-only distill still ran (non-ADK agent), PLUS one continuity
    // tagged distill for the settled session — and NONE for the live one.
    const tagged = reflectCalls.filter((c) => c.scope === "tagged");
    expect(tagged.length).toBe(1);
    expect(tagged[0]).toEqual({ agentId: "test-agent", execute: true, scope: "tagged", tag: T("settled"), focus: "continuity" });
    expect(reflectCalls.some((c) => c.tag === T("livesess"))).toBe(false);
    expect(reflectCalls.filter((c) => c.scope === undefined).length).toBe(1); // agentId-only path intact
    // Candidates aggregated; auto-promote sweep triggered by continuity alone.
    expect(r.logRow.candidates).toContain("cand_cont");
    expect(autoPromoteCalls.length).toBe(1);
    expect(r.logRow.continuitySessions).toBe(1);
  });

  it("no settled sessions → no tagged calls, no sweep, continuitySessions absent (unchanged non-ADK cycle)", async () => {
    const { api, reflectCalls, autoPromoteCalls } = makeTagAwareApi({
      activeTags: [],
      memories: [journalRow(T("livesess"), hoursAgo(0.5))],
      reflect: () => ({ candidates: [], count: 0, model: "default" }),
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api }));
    expect(reflectCalls.filter((c) => c.scope === "tagged").length).toBe(0);
    expect(autoPromoteCalls.length).toBe(0);
    expect(r.logRow.continuitySessions).toBeUndefined();
  });

  it("settleMs override is honored (a 3h-old session stays LIVE under a 4h window)", async () => {
    const { api, reflectCalls } = makeTagAwareApi({
      activeTags: [],
      memories: [journalRow(T("s3h"), hoursAgo(3))],
      reflect: () => ({ candidates: [], count: 0, model: "default" }),
    });
    await runNightlyCycle(baseOpts({ apiCall: api, settleMs: 4 * 3600_000 }));
    expect(reflectCalls.filter((c) => c.scope === "tagged").length).toBe(0);
  });

  it("a continuity distill failure is NON-FATAL and recorded per-tag", async () => {
    const { api } = makeTagAwareApi({
      activeTags: [],
      memories: [journalRow(T("boom"), hoursAgo(3))],
      reflect: (body) => {
        if (body.scope === "tagged") throw new Error("fetch failed: connection reset");
        return { candidates: [], count: 0, model: "default" };
      },
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api }));
    expect(r.status).toBe("completed");
    expect(r.logRow.errors.some((e) => e.includes(`distillation[${T("boom")}]:`))).toBe(true);
    expect(r.logRow.continuitySessions).toBe(0); // attempted, none succeeded
  });

  it("continuity sessions share the per-cycle tag cap with ADK tags; overflow deferred + recorded", async () => {
    const { api, reflectCalls } = makeTagAwareApi({
      activeTags: [],
      memories: [
        { id: "m-adk", agentId: "test-agent", content: "x", tags: ["adk:app:alice"], durability: "standard", createdAt: new Date().toISOString() },
        journalRow(T("s1"), hoursAgo(3)),
        journalRow(T("s2"), hoursAgo(4)),
      ],
      reflect: () => ({ candidates: [], count: 0, model: "default" }),
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api, maxTagsPerCycle: 2 }));
    // 1 ADK tag + budget 1 → only one continuity session runs this cycle.
    const tagged = reflectCalls.filter((c) => c.scope === "tagged");
    expect(tagged.length).toBe(2);
    expect(tagged.map((c) => c.tag)).toContain("adk:app:alice");
    expect(tagged.filter((c) => c.focus === "continuity").length).toBe(1);
    expect(r.logRow.errors.some((e) => e.includes("deferred by the per-cycle tag cap"))).toBe(true);
  });

  it("dry-run skips continuity distillation entirely (side effects, like every distill)", async () => {
    const { api, reflectCalls } = makeTagAwareApi({
      activeTags: [],
      memories: [journalRow(T("settled"), hoursAgo(3))],
      reflect: () => ({ candidates: [], count: 0, model: "default" }),
    });
    const r = await runNightlyCycle(baseOpts({ apiCall: api, dryRun: true }));
    expect(r.status).toBe("dry-run");
    expect(reflectCalls.length).toBe(0);
    expect(r.logRow.continuitySessions).toBeUndefined();
  });
});
