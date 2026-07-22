/**
 * rem-runner.test.ts — Unit tests for src/rem/runner.ts.
 *
 * Pure orchestration coverage. No Harper or filesystem state required
 * outside an isolated tmpdir. Tests pause sentinel, env-var pause, dry-run
 * (skip write but still log), happy path (writes snapshot + log row),
 * api failure (fail-stops-cycle + error in log row), soul shape coercion
 * (single row vs multi row), and step 5 distillation (specs/
 * FLAIR-NIGHTLY-REM-SLICE-2-DISTILLATION.md § 3B): success populates
 * `candidates` and flips `slice` to "2"; failure is recorded in `errors[]`
 * without failing the cycle; dry-run skips the /ReflectMemories call
 * entirely and `slice` stays "2-maintenance".
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNightlyCycle, type ApiCall, type RunnerOpts } from "../src/rem/runner.ts";

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
