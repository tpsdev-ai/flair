/**
 * rem-restore.test.ts — Unit tests for src/rem/restore.ts.
 *
 * Verifies the apply-snapshot flow:
 *   - dry-run reports planned counts without mutating
 *   - real restore creates a pre-restore snapshot of current state
 *   - cross-agent restore is refused
 *   - DELETE-then-PUT happens in order
 *   - errors mid-flight produce status="failed" with preRestoreSnapshotPath
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applySnapshot, type ApiCall } from "../src/rem/restore.ts";
import { createSnapshot } from "../src/rem/snapshot.ts";

let testRoot: string;
let snapshotRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-rem-restore-test-"));
  snapshotRoot = join(testRoot, "snapshots");
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const snapshotMemories = [
  { id: "m1", agentId: "test-agent", content: "snapshot memory 1", durability: "persistent" },
  { id: "m2", agentId: "test-agent", content: "snapshot memory 2" },
];
const snapshotSoul = { id: "soul-test-agent", agentId: "test-agent", instructions: "be helpful" };

async function makeTestSnapshot(agentId = "test-agent"): Promise<string> {
  const r = await createSnapshot({
    agentId,
    flairVersion: "0.0.0-test",
    memories: snapshotMemories,
    soul: snapshotSoul,
    pendingCandidateCount: 0,
    rootOverride: snapshotRoot,
  });
  return r.path;
}

/** Builds a stubbed apiCall that records all method+path invocations. */
function recordingApi(handlers: Record<string, (path: string, body?: unknown) => any> = {}): {
  api: ApiCall;
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api: ApiCall = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method}:${path.split("?")[0].split("/").slice(0, 2).join("/")}`;
    if (handlers[key]) return handlers[key](path, body);
    // Default fall-throughs for the read endpoints when not stubbed
    if (method === "GET" && path.startsWith("/Memory?")) return [];
    if (method === "GET" && path.startsWith("/Soul?")) return [];
    if (method === "DELETE" || method === "PUT") return { ok: true };
    throw new Error(`unexpected api: ${method}:${path}`);
  };
  return { api, calls };
}

describe("applySnapshot — dry-run", () => {
  it("reports planned counts without making destructive calls", async () => {
    const snapshotPath = await makeTestSnapshot();
    const current = [{ id: "old-1", agentId: "test-agent" }, { id: "old-2", agentId: "test-agent" }];
    const { api, calls } = recordingApi({
      "GET:/Memory": () => current,
      "GET:/Soul": () => [{ id: "current-soul", agentId: "test-agent" }],
    });
    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
      dryRun: true,
    });
    expect(r.status).toBe("dry-run");
    expect(r.deleted.memories).toBe(2);
    expect(r.deleted.souls).toBe(1);
    expect(r.restored.memories).toBe(2);
    expect(r.restored.souls).toBe(1);
    expect(r.preRestoreSnapshotPath).toBeUndefined();
    expect(r.errors).toEqual([]);

    // Only GETs happened.
    const writes = calls.filter((c) => c.method === "DELETE" || c.method === "PUT");
    expect(writes).toEqual([]);
  });
});

describe("applySnapshot — agent-id mismatch", () => {
  it("refuses to restore when snapshot.metadata.agentId differs from target", async () => {
    const snapshotPath = await makeTestSnapshot("alice");
    const { api } = recordingApi();
    const r = await applySnapshot({
      agentId: "bob",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });
    expect(r.status).toBe("failed");
    expect(r.errors[0]).toContain("does not match target");
    expect(r.preRestoreSnapshotPath).toBeUndefined();
  });
});

describe("applySnapshot — missing snapshot", () => {
  it("returns failed when the tarball does not exist", async () => {
    const { api } = recordingApi();
    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath: join(testRoot, "ghost.tar.gz"),
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });
    expect(r.status).toBe("failed");
    expect(r.errors[0]).toContain("does not exist");
  });
});

describe("applySnapshot — real restore", () => {
  it("creates pre-restore snapshot, deletes current rows, PUTs snapshot rows", async () => {
    const snapshotPath = await makeTestSnapshot();
    const current = [{ id: "old-1", agentId: "test-agent" }, { id: "old-2", agentId: "test-agent" }];
    const { api, calls } = recordingApi({
      "GET:/Memory": () => current,
      "GET:/Soul": () => [{ id: "current-soul", agentId: "test-agent" }],
    });

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });

    expect(r.status).toBe("completed");
    expect(r.errors).toEqual([]);
    expect(r.deleted.memories).toBe(2);
    expect(r.deleted.souls).toBe(1);
    expect(r.restored.memories).toBe(2);
    expect(r.restored.souls).toBe(1);
    expect(r.preRestoreSnapshotPath).toBeDefined();
    expect(existsSync(r.preRestoreSnapshotPath!)).toBe(true);

    // Call ordering: 2 GETs for the pre-restore fetch, then DELETEs (2 mem + 1 soul), then PUTs (2 mem + 1 soul).
    const writes = calls.filter((c) => c.method === "DELETE" || c.method === "PUT");
    expect(writes.length).toBe(6);
    expect(writes.slice(0, 3).every((c) => c.method === "DELETE")).toBe(true);
    expect(writes.slice(3).every((c) => c.method === "PUT")).toBe(true);
  });

  it("preRestoreSnapshotPath contains current state for rollback", async () => {
    const snapshotPath = await makeTestSnapshot();
    const beforeState = [
      { id: "current-1", agentId: "test-agent", content: "current" },
      { id: "current-2", agentId: "test-agent", content: "more current" },
    ];
    const { api } = recordingApi({
      "GET:/Memory": () => beforeState,
      "GET:/Soul": () => [],
    });

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });
    expect(r.preRestoreSnapshotPath).toBeDefined();

    // The pre-restore snapshot should contain the BEFORE state.
    const extractDir = join(testRoot, "extract");
    const { extractSnapshot } = await import("../src/rem/snapshot.ts");
    await extractSnapshot({ snapshotPath: r.preRestoreSnapshotPath!, targetDir: extractDir });

    const lines = readFileSync(join(extractDir, "memories.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual(beforeState);
  });
});

describe("applySnapshot — failure modes", () => {
  it("captures PUT errors per-row without aborting", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api } = recordingApi({
      "GET:/Memory": () => [],
      "GET:/Soul": () => [],
      "PUT:/Memory": (_path) => {
        // Fail the second PUT.
        const stats = (api as any)._putCount ?? 0;
        (api as any)._putCount = stats + 1;
        if (stats === 1) throw new Error("conflict");
        return { ok: true };
      },
    });

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });

    expect(r.status).toBe("failed");
    expect(r.restored.memories).toBe(1); // first PUT succeeded
    expect(r.errors.some((e) => e.includes("put-memory") && e.includes("conflict"))).toBe(true);
    // Pre-restore snapshot was still created.
    expect(r.preRestoreSnapshotPath).toBeDefined();
    expect(existsSync(r.preRestoreSnapshotPath!)).toBe(true);
  });
});
