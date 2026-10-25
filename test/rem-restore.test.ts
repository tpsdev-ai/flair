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

import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applySnapshot, CANDIDATE_LIST_LIMIT, CANDIDATE_LIST_MAX_PAGES, type ApiCall } from "../src/rem/restore.ts";
import { ApiHttpError } from "../src/lib/auth-resolve.ts";
import { buildOpsSearch } from "../src/commands/rem.ts";
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
    if (method === "GET" && path.startsWith("/AdminMemoryCandidates/")) return { candidates: [], hasMore: false };
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
function statefulApi(seed: { memories?: any[]; souls?: any[]; candidates?: any[] } = {}, corruptOnPut?: (path: string) => boolean): {
  api: ApiCall;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  state: { memories: Map<string, any>; souls: Map<string, any>; candidates: Map<string, any> };
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const state = {
    memories: new Map<string, any>((seed.memories ?? []).map((m) => [String(m.id), m])),
    souls: new Map<string, any>((seed.souls ?? []).map((s) => [String(s.id), s])),
    candidates: new Map<string, any>((seed.candidates ?? []).map((c) => [String(c.id), c])),
  };
  const api: ApiCall = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/Memory?")) return Array.from(state.memories.values());
    if (method === "GET" && path.startsWith("/Soul?")) return Array.from(state.souls.values());
    if (method === "GET" && path.startsWith("/AdminMemoryCandidates/")) {
      return { candidates: Array.from(state.candidates.values()).map((c) => ({ id: c.id })), hasMore: false };
    }
    if (method === "DELETE" && path.startsWith("/Memory/")) {
      state.memories.delete(decodeURIComponent(path.split("/")[2]));
      return { ok: true };
    }
    if (method === "DELETE" && path.startsWith("/Soul/")) {
      state.souls.delete(decodeURIComponent(path.split("/")[2]));
      return { ok: true };
    }
    if (method === "DELETE" && path.startsWith("/MemoryCandidate/")) {
      state.candidates.delete(decodeURIComponent(path.split("/")[2]));
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
      // Candidates are listed through the apiCall the Memory writes use, on the
      // admin-only route `/AdminMemoryCandidates/{agentId}`.
      "GET:/AdminMemoryCandidates": () => ({ candidates: [{ id: "cand-1" }, { id: "cand-2" }], hasMore: false }),
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
    expect(r.deleted.candidates).toBe(2);
    expect(r.restored.memories).toBe(2);
    expect(r.restored.souls).toBe(1);
    expect(r.preRestoreSnapshotPath).toBeUndefined();
    expect(r.errors).toEqual([]);

    expect(calls.some((c) => c.method === "GET" && c.path === "/AdminMemoryCandidates/test-agent?limit=500")).toBe(true);
    expect(calls.some((c) => c.path.includes("search_by_conditions"))).toBe(false);
    const writes = calls.filter((c) => c.method === "DELETE" || c.method === "PUT");
    expect(writes).toEqual([]);
  });

  it("reports an unrecognised candidate-route body as an error, not as no candidates", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api } = recordingApi({
      "GET:/Memory": () => [],
      "GET:/Soul": () => [],
      "GET:/AdminMemoryCandidates": () => ({ error: "fixture" }),
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
    expect(r.status).toBe("failed");
    expect(r.errors).toEqual([
      "fetch-current: the target's MemoryCandidate listing for agent test-agent could not be read completely: GET /AdminMemoryCandidates returned an unexpected response shape: candidates is not an array. No target rows were deleted or written.",
    ]);
  });

  it("reports a /Memory 404 with its own message, not the candidate route's, when listing is off", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = recordingApi({
      "GET:/Memory": () => { throw new ApiHttpError(404, "memory route missing"); },
    });
    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
      dryRun: true,
      listCandidates: false,
    });
    expect(r.status).toBe("failed");
    expect(r.errors).toEqual(["fetch-current: memory route missing"]);
    expect(calls.some((c) => c.path.startsWith("/AdminMemoryCandidates/"))).toBe(false);
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
    expect(r.deleted.candidates).toBe(0);
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

    // Call ordering: pre-restore GETs, DELETEs (2 mem + 1 soul), PUTs (1 soul then 2 mem), post-restore verify GETs.
    const writes = calls.filter((c) => c.method === "DELETE" || c.method === "PUT");
    expect(writes.length).toBe(6);
    expect(writes.slice(0, 3).every((c) => c.method === "DELETE")).toBe(true);
    expect(writes.slice(3).every((c) => c.method === "PUT")).toBe(true);
    const puts = writes.filter((c) => c.method === "PUT");
    expect(puts[0].path.startsWith("/Soul/")).toBe(true);
    expect(puts.slice(1).every((c) => c.path.startsWith("/Memory/"))).toBe(true);
  });

  it("routes Soul DELETE/PUT through soulApiCall, not the agent-signed apiCall", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api } = statefulApi({
      memories: [{ id: "old-1", agentId: "test-agent" }],
      souls: [{ id: "current-soul", agentId: "test-agent" }],
    });
    const soulCalls: Array<{ method: string; path: string }> = [];
    const agentWrites: Array<{ method: string; path: string }> = [];
    const soulApi: ApiCall = async (method, path, body) => {
      soulCalls.push({ method, path });
      return api(method, path, body);
    };
    const agentApi: ApiCall = async (method, path, body) => {
      if (method === "DELETE" || method === "PUT") agentWrites.push({ method, path });
      return api(method, path, body);
    };

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: agentApi,
      soulApiCall: soulApi,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });

    expect(r.status).toBe("completed");
    expect(soulCalls.some((c) => c.method === "DELETE" && c.path.startsWith("/Soul/"))).toBe(true);
    expect(soulCalls.some((c) => c.method === "PUT" && c.path.startsWith("/Soul/"))).toBe(true);
    expect(soulCalls.every((c) => c.path.startsWith("/Soul/"))).toBe(true);
    expect(agentWrites.every((c) => !c.path.startsWith("/Soul/"))).toBe(true);
  });

  it("deletes leftover MemoryCandidates before Soul PUT so claim text cannot 403 restore", async () => {
    const snapshotPath = await makeTestSnapshot();
    const leftover = { id: "cand-leftover", agentId: "test-agent", claim: "be helpful", status: "pending" };
    const { api, calls, state } = statefulApi({
      memories: [],
      souls: [],
      candidates: [leftover],
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
    expect(r.deleted.candidates).toBe(1);
    expect(state.candidates.size).toBe(0);
    const writes = calls.filter((c) => c.method === "DELETE" || c.method === "PUT");
    const candDeleteAt = writes.findIndex((c) => c.method === "DELETE" && c.path === "/MemoryCandidate/cand-leftover");
    const soulPutAt = writes.findIndex((c) => c.method === "PUT" && c.path.startsWith("/Soul/"));
    expect(candDeleteAt).toBeGreaterThanOrEqual(0);
    expect(soulPutAt).toBeGreaterThan(candDeleteAt);
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
    // flair#2680: restore takes no candidate count, so the metadata says so.
    expect(JSON.parse(readFileSync(join(extractDir, "metadata.json"), "utf-8")).pendingCandidateCount).toBeNull();
  });

  it("a failed candidate listing stops --apply before any delete or write (flair#2687)", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = recordingApi({
      "GET:/Memory": () => [{ id: "mem-1", agentId: "test-agent" }],
      "GET:/Soul": () => [{ id: "soul-1", agentId: "test-agent" }],
      "GET:/AdminMemoryCandidates": () => { throw new Error("route down"); },
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
    const writes = calls.filter((c) => ["DELETE", "PUT", "POST", "PATCH"].includes(c.method));
    expect(writes).toEqual([]);
    expect(r.deleted).toEqual({ memories: 0, souls: 0, candidates: 0 });
    expect(r.errors).toEqual([
      "fetch-candidates: the target's MemoryCandidate listing for agent test-agent could not be read completely: GET /AdminMemoryCandidates failed: route down. No target rows were deleted or written.",
    ]);
  });

  it("lists through the target's apiCall, never an injected operations search", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = recordingApi({
      "GET:/Memory": () => [],
      "GET:/Soul": () => [],
      "GET:/AdminMemoryCandidates": () => ({ candidates: [{ id: "target-candidate" }], hasMore: false }),
    });
    let opsCalls = 0;
    const opts: any = {
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      opsSearch: async () => {
        opsCalls++;
        return [{ id: "other-endpoint-candidate" }];
      },
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
      verifyPostRestore: false,
    };

    const r = await applySnapshot(opts);

    expect(r.status).toBe("completed");
    expect(opsCalls).toBe(0);
    expect(calls.some((c) => c.method === "GET" && c.path.startsWith("/AdminMemoryCandidates/"))).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/MemoryCandidate/target-candidate")).toBe(true);
    expect(calls.some((c) => c.path === "/MemoryCandidate/other-endpoint-candidate")).toBe(false);
  });

  it("a candidate-route 404 is refused with the server version that adds the route, before any delete or write", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = recordingApi({
      "GET:/Memory": () => [{ id: "mem-1", agentId: "test-agent" }],
      "GET:/Soul": () => [{ id: "soul-1", agentId: "test-agent" }],
      "GET:/AdminMemoryCandidates": () => { throw new ApiHttpError(404, "Not found"); },
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
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("GET /AdminMemoryCandidates");
    expect(r.errors[0]).toContain("Flair server 0.63.0");
    expect(r.errors[0]).toContain("No target rows were deleted or written.");
    expect(calls.filter((c) => ["DELETE", "PUT", "POST", "PATCH"].includes(c.method))).toEqual([]);
  });

  it("refuses listCandidates: false on a live restore before any request", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = recordingApi({
      "GET:/Memory": () => [{ id: "mem-1", agentId: "test-agent" }],
      "GET:/Soul": () => [{ id: "soul-1", agentId: "test-agent" }],
      "GET:/AdminMemoryCandidates": () => ({ candidates: [{ id: "cand-1" }], hasMore: false }),
    });
    const soul = recordingApi();

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      soulApiCall: soul.api,
      listCandidates: false,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });

    expect(calls.filter((c) => ["DELETE", "PUT", "POST", "PATCH"].includes(c.method))).toEqual([]);
    expect(soul.calls).toEqual([]);
    expect(calls).toEqual([]);
    expect(r.status).toBe("failed");
    expect(r.errors).toEqual([
      "listCandidates: false is accepted only with dryRun: a live restore lists leftover MemoryCandidate rows before any delete. No request was sent to the target.",
    ]);
    expect(r.preRestoreSnapshotPath).toBeUndefined();
  });

  it("refuses a candidate listing answered 500 candidate_id_unusable as incomplete, before any delete or write", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = recordingApi({
      "GET:/Memory": () => [{ id: "mem-1", agentId: "test-agent" }],
      "GET:/Soul": () => [{ id: "soul-1", agentId: "test-agent" }],
      "GET:/AdminMemoryCandidates": () => {
        throw ApiHttpError.fromResponse(500, JSON.stringify({ error: "candidate_id_unusable", message: "fixture" }));
      },
    });
    const soul = recordingApi();

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      soulApiCall: soul.api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });

    expect(calls.filter((c) => ["DELETE", "PUT", "POST", "PATCH"].includes(c.method))).toEqual([]);
    expect(soul.calls).toEqual([]);
    expect(r.status).toBe("failed");
    expect(r.errors).toEqual([
      "fetch-candidates: the target's MemoryCandidate listing for agent test-agent could not be read completely: GET /AdminMemoryCandidates answered candidate_id_unusable (a row has no usable id). "
        + "No target rows were deleted or written. Remove or repair that agent's MemoryCandidate row without a usable id on the target, then retry.",
    ]);
  });

  const malformedListings: Array<[string, unknown, string]> = [
    ["a missing hasMore", { candidates: [{ id: "cand-1" }] }, "unexpected response shape: hasMore is missing or not a boolean"],
    ["a non-boolean hasMore", { candidates: [{ id: "cand-1" }], hasMore: "false" }, "unexpected response shape: hasMore is missing or not a boolean"],
    ["an entry without an id", { candidates: [{ id: "cand-1" }, {}], hasMore: false }, "unexpected response shape: candidates[1].id is not a non-empty string"],
    ["a non-string id", { candidates: [{ id: 7 }], hasMore: false }, "unexpected response shape: candidates[0].id is not a non-empty string"],
  ];
  for (const [name, body, message] of malformedListings) {
    it(`refuses a candidate listing with ${name} before any delete or write`, async () => {
      const snapshotPath = await makeTestSnapshot();
      const { api, calls } = recordingApi({
        "GET:/Memory": () => [{ id: "mem-1", agentId: "test-agent" }],
        "GET:/Soul": () => [{ id: "soul-1", agentId: "test-agent" }],
        "GET:/AdminMemoryCandidates": () => body,
      });
      const soul = recordingApi();

      const r = await applySnapshot({
        agentId: "test-agent",
        snapshotPath,
        flairVersion: "0.0.0-test",
        apiCall: api,
        soulApiCall: soul.api,
        preRestoreSnapshotRoot: snapshotRoot,
        tmpRootOverride: testRoot,
      });

      expect(calls.filter((c) => ["DELETE", "PUT", "POST", "PATCH"].includes(c.method))).toEqual([]);
      expect(soul.calls).toEqual([]);
      expect(r.status).toBe("failed");
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toStartWith("fetch-candidates: ");
      expect(r.errors[0]).toContain(message);
      expect(r.errors[0]).toMatch(/no target rows were deleted or written/i);
      expect(r.deleted).toEqual({ memories: 0, souls: 0, candidates: 0 });
    });
  }
});

describe("applySnapshot — paged candidate listing", () => {
  /** A listing route over `ids` in id order that pages by `limit` and `after`, as the real route does. */
  function pagedListing(ids: string[]) {
    const sorted = [...ids].sort();
    return (path: string) => {
      const url = new URL(path, "http://target.test");
      const limit = Number(url.searchParams.get("limit"));
      const after = url.searchParams.get("after");
      const rest = sorted.filter((id) => after === null || id > after);
      return { candidates: rest.slice(0, limit).map((id) => ({ id })), hasMore: rest.length > limit };
    };
  }

  async function restoreWith(listing: (path: string) => unknown) {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = recordingApi({
      "GET:/Memory": () => [{ id: "mem-1", agentId: "test-agent" }],
      "GET:/Soul": () => [{ id: "soul-1", agentId: "test-agent" }],
      "GET:/AdminMemoryCandidates": listing,
    });
    const soul = recordingApi();
    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      soulApiCall: soul.api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
      verifyPostRestore: false,
    });
    const listings = calls.filter((c) => c.method === "GET" && c.path.startsWith("/AdminMemoryCandidates/"));
    const writes = [...calls, ...soul.calls].filter((c) => ["DELETE", "PUT", "POST", "PATCH"].includes(c.method));
    return { r, listings, writes };
  }

  it("requests pages with after set to the last id of the page before, and deletes every listed candidate", async () => {
    const ids = Array.from({ length: CANDIDATE_LIST_LIMIT * 2 + 1 }, (_, i) => `cand-${String(i).padStart(4, "0")}`);
    const { r, listings, writes } = await restoreWith(pagedListing(ids));

    expect(r.errors).toEqual([]);
    expect(r.status).toBe("completed");
    expect(listings.map((c) => c.path)).toEqual([
      `/AdminMemoryCandidates/test-agent?limit=${CANDIDATE_LIST_LIMIT}`,
      `/AdminMemoryCandidates/test-agent?limit=${CANDIDATE_LIST_LIMIT}&after=${ids[CANDIDATE_LIST_LIMIT - 1]}`,
      `/AdminMemoryCandidates/test-agent?limit=${CANDIDATE_LIST_LIMIT}&after=${ids[CANDIDATE_LIST_LIMIT * 2 - 1]}`,
    ]);
    expect(r.deleted.candidates).toBe(ids.length);
    expect(writes.filter((c) => c.path.startsWith("/MemoryCandidate/")).map((c) => c.path)).toEqual(ids.map((id) => `/MemoryCandidate/${id}`));
  });

  it("refuses a hasMore: true page with no candidates (candidate_cursor_not_advancing) before any delete or write", async () => {
    let page = 0;
    const { r, listings, writes } = await restoreWith(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      page++;
      return page === 1 ? { candidates: [{ id: "cand-1" }], hasMore: true } : { candidates: [], hasMore: true };
    });

    expect(r.status).toBe("failed");
    expect(r.errors).toEqual([
      "fetch-candidates: the target's MemoryCandidate listing for agent test-agent could not be read completely: page 2 of GET /AdminMemoryCandidates answered hasMore: true with no candidates, so the cursor cannot move past cand-1 (candidate_cursor_not_advancing). No target rows were deleted or written.",
    ]);
    expect(listings).toHaveLength(2);
    expect(writes).toEqual([]);
    expect(r.deleted).toEqual({ memories: 0, souls: 0, candidates: 0 });
  }, 20_000);

  it("refuses a page that lists an id again (candidate_id_repeated) before any delete or write", async () => {
    const { r, listings, writes } = await restoreWith(() => ({ candidates: [{ id: "cand-1" }, { id: "cand-2" }], hasMore: true }));

    expect(r.status).toBe("failed");
    expect(r.errors).toEqual([
      "fetch-candidates: the target's MemoryCandidate listing for agent test-agent could not be read completely: GET /AdminMemoryCandidates listed candidate id cand-1 twice (candidate_id_repeated). No target rows were deleted or written.",
    ]);
    expect(listings).toHaveLength(2);
    expect(listings[1].path).toBe(`/AdminMemoryCandidates/test-agent?limit=${CANDIDATE_LIST_LIMIT}&after=cand-2`);
    expect(writes).toEqual([]);
  }, 20_000);

  it("stops after CANDIDATE_LIST_MAX_PAGES pages that each answer hasMore: true (candidate_listing_page_limit) before any delete or write", async () => {
    let page = 0;
    const { r, listings, writes } = await restoreWith(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      page++;
      return { candidates: [{ id: `cand-${String(page).padStart(6, "0")}` }], hasMore: true };
    });

    expect(r.status).toBe("failed");
    expect(r.errors).toEqual([
      `fetch-candidates: the target's MemoryCandidate listing for agent test-agent could not be read completely: GET /AdminMemoryCandidates still answered hasMore: true after ${CANDIDATE_LIST_MAX_PAGES} pages of ${CANDIDATE_LIST_LIMIT}, the most restore requests (candidate_listing_page_limit). No target rows were deleted or written.`,
    ]);
    expect(listings).toHaveLength(CANDIDATE_LIST_MAX_PAGES);
    expect(writes).toEqual([]);
  }, 20_000);
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


/** The server's provider-bound refusal, as `sendJsonRequest` surfaces it: 503 with the body on the error. */
function providerTimeout(): ApiHttpError {
  return ApiHttpError.fromResponse(
    503,
    JSON.stringify({
      error: "memory_provider_timeout",
      message: "the embedding provider did not answer within its bound; nothing was written, retry",
    }),
  );
}

/**
 * A target whose Memory PUT fails with the queued errors in order and writes
 * the row on every other attempt. Reads reflect the writes, so the restore's
 * own verification pass sees a clean state after a successful retry.
 */
function retryingTarget(putFailures: unknown[]): {
  api: ApiCall;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  state: { memories: Map<string, any>; souls: Map<string, any> };
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const state = { memories: new Map<string, any>(), souls: new Map<string, any>() };
  let memoryPuts = 0;
  const api: ApiCall = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/Memory?")) return Array.from(state.memories.values());
    if (method === "GET" && path.startsWith("/Soul?")) return Array.from(state.souls.values());
    if (method === "GET" && path.startsWith("/AdminMemoryCandidates/")) return { candidates: [], hasMore: false };
    if (method === "DELETE") return { ok: true };
    if (method === "PUT" && path.startsWith("/Memory/")) {
      const failure = putFailures[memoryPuts++];
      if (failure) throw failure;
      state.memories.set(decodeURIComponent(path.split("/")[2]), body);
      return { ok: true };
    }
    if (method === "PUT" && path.startsWith("/Soul/")) {
      state.souls.set(decodeURIComponent(path.split("/")[2]), body);
      return { ok: true };
    }
    throw new Error(`unexpected api: ${method}:${path}`);
  };
  return { api, calls, state };
}

describe("applySnapshot — provider-timeout retry (flair#2769)", () => {
  it("restores a memory write refused with 503 memory_provider_timeout once, then succeeding, and reports the row as retried", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls, state } = retryingTarget([providerTimeout()]);

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
    expect(r.restored.memories).toBe(2);
    expect(r.retried.memories).toEqual(["m1"]);
    expect(state.memories.get("m1")).toBeDefined();
    expect(calls.filter((c) => c.method === "PUT" && c.path.startsWith("/Memory/")).length).toBe(3);
    expect(r.verified?.missingMemoryIds).toEqual([]);
  }, 20_000);

  it("records the row as failed when the retry is refused with the same timeout", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = retryingTarget([providerTimeout(), providerTimeout()]);

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });

    expect(r.status).toBe("failed");
    expect(r.restored.memories).toBe(1); // m2 still restores; m1 stays failed
    expect(r.retried.memories).toEqual(["m1"]);
    expect(r.errors.some((e) => e.startsWith("put-memory m1:") && e.includes("memory_provider_timeout"))).toBe(true);
    expect(calls.filter((c) => c.method === "PUT" && c.path.startsWith("/Memory/")).length).toBe(3);
  }, 20_000);

  it("waits for the retry's own answer: a retry answered after 30 s of faked time is restored, not recorded failed", async () => {
    const snapshotPath = await makeTestSnapshot();
    const target = retryingTarget([providerTimeout()]);
    let answerRetry!: () => void;
    const retryAnswered = new Promise<void>((resolve) => (answerRetry = resolve));
    let firstPutSeen!: () => void;
    const firstPut = new Promise<void>((resolve) => (firstPutSeen = resolve));
    let memoryPuts = 0;
    const api: ApiCall = async (method, path, body) => {
      if (method === "PUT" && path.startsWith("/Memory/")) {
        memoryPuts++;
        // The clock is faked from the first memory PUT on, so the snapshot
        // IO before it runs on real timers.
        if (memoryPuts === 1) {
          jest.useFakeTimers();
          firstPutSeen();
        }
        if (memoryPuts === 2) await retryAnswered;
      }
      return target.api(method, path, body);
    };
    const settleTicks = async () => {
      for (let i = 0; i < 200; i++) await Promise.resolve();
    };

    try {
      let settled = false;
      const run = applySnapshot({
        agentId: "test-agent",
        snapshotPath,
        flairVersion: "0.0.0-test",
        apiCall: api,
        preRestoreSnapshotRoot: snapshotRoot,
        tmpRootOverride: testRoot,
      }).finally(() => (settled = true));

      await firstPut;
      await settleTicks();
      jest.advanceTimersByTime(1_000);
      await settleTicks();
      expect(memoryPuts).toBe(2);

      jest.advanceTimersByTime(30_000);
      await settleTicks();
      expect(settled).toBe(false);

      answerRetry();
      jest.useRealTimers();
      const r = await run;

      expect(r.status).toBe("completed");
      expect(r.errors).toEqual([]);
      expect(r.restored.memories).toBe(2);
      expect(r.retried.memories).toEqual(["m1"]);
      expect(target.state.memories.get("m1")).toBeDefined();
      expect(memoryPuts).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  }, 20_000);

  it("does not retry a 503 with a different error code", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = retryingTarget([
      ApiHttpError.fromResponse(503, JSON.stringify({ error: "memory_busy", caller: "agent-a" })),
    ]);

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });

    expect(r.status).toBe("failed");
    expect(r.retried.memories).toEqual([]);
    expect(calls.filter((c) => c.method === "PUT" && c.path.startsWith("/Memory/")).length).toBe(2);
    expect(r.errors.some((e) => e.startsWith("put-memory m1:") && e.includes("memory_busy"))).toBe(true);
  }, 20_000);

  it("does not retry a 503 whose message text names the code but whose error field does not", async () => {
    const snapshotPath = await makeTestSnapshot();
    const { api, calls } = retryingTarget([
      ApiHttpError.fromResponse(503, JSON.stringify({ error: "memory_busy", message: "memory_provider_timeout would be retried" })),
    ]);

    const r = await applySnapshot({
      agentId: "test-agent",
      snapshotPath,
      flairVersion: "0.0.0-test",
      apiCall: api,
      preRestoreSnapshotRoot: snapshotRoot,
      tmpRootOverride: testRoot,
    });

    expect(r.retried.memories).toEqual([]);
    expect(calls.filter((c) => c.method === "PUT" && c.path.startsWith("/Memory/")).length).toBe(2);
    expect(r.errors.some((e) => e.startsWith("put-memory m1:"))).toBe(true);
  }, 20_000);
});

describe("buildOpsSearch — CLI-wired candidate list uses the ops root", () => {
  it("POSTs the ops-root {search_by_conditions} body for MemoryCandidate, not a REST URL suffix", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: any, init: any) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify([{ id: "c1" }]), { status: 200 });
    }) as unknown as typeof fetch;

    const opsSearch = buildOpsSearch({ opsPort: 19926, adminUser: "admin", adminPass: "s3cret" }, fakeFetch);
    const rows = await opsSearch(
      "MemoryCandidate",
      [{ search_attribute: "agentId", search_type: "equals", search_value: "test-agent" }],
      ["id", "claim"],
    );

    expect(rows).toEqual([{ id: "c1" }]);
    expect(requests.length).toBe(1);
    // Ops port root — NOT /MemoryCandidate/search_by_conditions, which
    // Harper's REST dispatcher cannot route and answers 405.
    expect(requests[0].url).toBe("http://127.0.0.1:19926/");
    expect(requests[0].url).not.toContain("search_by_conditions");
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      operation: "search_by_conditions",
      schema: "flair",
      table: "MemoryCandidate",
      operator: "and",
      conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: "test-agent" }],
      get_attributes: ["id", "claim"],
    });
    expect(String((requests[0].init.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
  });

  it("throws on a non-2xx ops response instead of silently returning zero rows", async () => {
    const fakeFetch = (async () =>
      new Response("does not have a post method implemented", { status: 405 })) as unknown as typeof fetch;
    const opsSearch = buildOpsSearch({ opsPort: 19926, adminPass: "s3cret" }, fakeFetch);
    await expect(opsSearch("MemoryCandidate", [], ["id"])).rejects.toThrow(/ops API failed \(405\)/);
  });

  it("throws on a 2xx body that is neither rows nor { results: rows } (flair#2680)", async () => {
    let body: unknown = { error: "fixture" };
    const fakeFetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const opsSearch = buildOpsSearch({ opsPort: 19926, adminPass: "s3cret" }, fakeFetch);
    await expect(opsSearch("MemoryCandidate", [], ["id"])).rejects.toThrow("ops API returned an unexpected response shape");
    body = { results: [{ id: "c1" }] };
    expect(await opsSearch("MemoryCandidate", [], ["id"])).toEqual([{ id: "c1" }]);
  });
});
