/**
 * rem-runner.test.ts — Unit tests for src/rem/runner.ts.
 *
 * Pure orchestration coverage. No Harper or filesystem state required
 * outside an isolated tmpdir. Tests pause sentinel, env-var pause, dry-run
 * (skip write but still log), happy path (writes snapshot + log row),
 * api failure (fail-stops-cycle + error in log row), and soul shape
 * coercion (single row vs multi row).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNightlyCycle, type ApiCall, type RunnerOpts } from "../src/rem/runner.ts";

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
    expect(r.logRow.slice).toBe("1");

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
      }),
    }));
    expect(r.status).toBe("completed");
    expect(r.logRow.memoryCount).toBe(3);
    expect(r.logRow.soulCount).toBe(1);
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
      }),
    }));
    // Candidate count is a non-fatal signal — the cycle still completes.
    expect(r.status).toBe("completed");
    expect(r.logRow.pendingCandidates).toBe(0);
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
