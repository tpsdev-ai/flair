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
import { create as tarCreate, extract as tarExtract } from "tar";

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

/**
 * Stateful apiCall that simulates Harper's GET-after-PUT consistency.
 * Use when a test exercises the full restore + verifyPostRestore loop —
 * the verify pass GETs back the actual post-restore state, which the
 * static recordingApi can't model.
 *
 * `seed` populates the initial state. Subsequent PUT/DELETE/GET mutate
 * and read that state. `corruptOnPut` lets tests simulate Harper silently
 * dropping rows (returns ok but skips the state write).
 */
function statefulApi(seed: { memories?: any[]; souls?: any[] } = {}, corruptOnPut?: (path: string) => boolean): {
  api: ApiCall;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  state: { memories: Map<string, any>; souls: Map<string, any> };
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const state = {
    memories: new Map<string, any>((seed.memories ?? []).map((m) => [String(m.id), m])),
    souls: new Map<string, any>((seed.souls ?? []).map((s) => [String(s.id), s])),
  };
  const api: ApiCall = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/Memory?")) return Array.from(state.memories.values());
    if (method === "GET" && path.startsWith("/Soul?")) return Array.from(state.souls.values());
    if (method === "DELETE" && path.startsWith("/Memory/")) {
      state.memories.delete(decodeURIComponent(path.split("/")[2]));
      return { ok: true };
    }
    if (method === "DELETE" && path.startsWith("/Soul/")) {
      state.souls.delete(decodeURIComponent(path.split("/")[2]));
      return { ok: true };
    }
    if (method === "PUT" && path.startsWith("/Memory/")) {
      if (!(corruptOnPut && corruptOnPut(path))) {
        state.memories.set(decodeURIComponent(path.split("/")[2]), body);
      }
      return { ok: true };
    }
    if (method === "PUT" && path.startsWith("/Soul/")) {
      if (!(corruptOnPut && corruptOnPut(path))) {
        state.souls.set(decodeURIComponent(path.split("/")[2]), body);
      }
      return { ok: true };
    }
    throw new Error(`unexpected api: ${method}:${path}`);
  };
  return { api, calls, state };
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

  it("refuses to restore when snapshot.metadata.agentId is missing (pre-0.9.0 / crafted snapshot)", async () => {
    // Build a tarball whose metadata.json omits agentId entirely — simulates
    // pre-v0.9.0 snapshots, hand-edited input, or attacker-crafted tarballs.
    // The original short-circuit predicate (`metadata.agentId && ...`) would
    // silently bypass the cross-agent guard for this case.
    const srcDir = await makeTestSnapshot("alice");
    const extractDir = join(testRoot, "extract-no-agentid");
    mkdirSync(extractDir, { recursive: true });
    await tarExtract({ file: srcDir, cwd: extractDir });
    const metaPath = join(extractDir, "metadata.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    delete meta.agentId;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const tamperedTarPath = join(testRoot, "tampered.tar.gz");
    await tarCreate(
      { gzip: true, cwd: extractDir, file: tamperedTarPath, portable: true },
      ["memories.jsonl", "soul.json", "metadata.json"],
    );

    const { api } = recordingApi();
    const r = await applySnapshot({
      agentId: "bob",
      snapshotPath: tamperedTarPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });
    expect(r.status).toBe("failed");
    expect(r.errors[0]).toContain("missing metadata.agentId");
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
  it("creates pre-restore snapshot, deletes current rows, PUTs snapshot rows, verifies clean", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = statefulApi({
      memories: [{ id: "old-1", agentId: "test-agent" }, { id: "old-2", agentId: "test-agent" }],
      souls: [{ id: "current-soul", agentId: "test-agent" }],
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

    // Verify pass ran and found a clean restore.
    expect(r.verified).toBeDefined();
    expect(r.verified!.missingMemoryIds).toEqual([]);
    expect(r.verified!.missingSoulIds).toEqual([]);
    expect(r.verified!.extraMemoryIds).toEqual([]);
    expect(r.verified!.extraSoulIds).toEqual([]);

    // Call ordering: pre-restore GETs, DELETEs (2 mem + 1 soul), PUTs (2 mem + 1 soul), post-restore verify GETs.
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
    const { api } = statefulApi({ memories: beforeState, souls: [] });

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

describe("applySnapshot — post-restore verification (detects silent write drift)", () => {
  it("flags drift when Harper silently drops PUT rows", async () => {
    // Simulates the failure mode the verify pass is designed to catch:
    // Harper returns ok on PUT but doesn't actually persist the row
    // (schema coercion, BlobDB rejection, 4xx-masked-as-2xx, etc.).
    const snapshotPath = await makeTestSnapshot();
    // Drop the second memory PUT silently.
    const { api } = statefulApi(
      {},
      (path) => path === "/Memory/m2",
    );

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });

    expect(r.status).toBe("failed");
    expect(r.verified).toBeDefined();
    expect(r.verified!.missingMemoryIds).toEqual(["m2"]);
    expect(r.verified!.extraMemoryIds).toEqual([]);
    expect(r.errors.some((e) => e.includes("post-restore-verify") && e.includes("memory rows missing") && e.includes("m2"))).toBe(true);
    // restored.memories says 2 because the apiCall returned ok — that's the
    // exact lie the verify pass is built to detect.
    expect(r.restored.memories).toBe(2);
  });

  it("flags drift when DELETE leaves rows behind (lingering pre-state)", async () => {
    const snapshotPath = await makeTestSnapshot();
    // Seed with a leftover row that won't match the snapshot's IDs.
    const { api } = statefulApi({
      memories: [{ id: "old-leftover", agentId: "test-agent" }],
    });

    // Intercept DELETE /Memory/old-leftover to no-op (simulates Harper
    // returning ok but not actually deleting).
    const innerApi = api;
    const interceptedApi: ApiCall = async (method, path, body) => {
      if (method === "DELETE" && path === "/Memory/old-leftover") {
        return { ok: true }; // silent no-op
      }
      return innerApi(method, path, body);
    };

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: interceptedApi,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });

    expect(r.status).toBe("failed");
    expect(r.verified).toBeDefined();
    expect(r.verified!.extraMemoryIds).toEqual(["old-leftover"]);
    expect(r.errors.some((e) => e.includes("post-restore-verify") && e.includes("unexpected memory rows") && e.includes("old-leftover"))).toBe(true);
  });

  it("respects verifyPostRestore: false (opt-out for tests)", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api } = statefulApi(
      {},
      (path) => path === "/Memory/m2", // would normally trigger drift
    );

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
      verifyPostRestore: false,
    });

    expect(r.status).toBe("completed");
    expect(r.verified).toBeUndefined();
  });

  it("does not run verify in dry-run", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = statefulApi({
      memories: [{ id: "anything", agentId: "test-agent" }],
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
    expect(r.verified).toBeUndefined();
    // dry-run does the pre-restore fetch GETs, but no PUT/DELETE and no verify pass.
    const writes = calls.filter((c) => c.method === "DELETE" || c.method === "PUT");
    expect(writes).toEqual([]);
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
