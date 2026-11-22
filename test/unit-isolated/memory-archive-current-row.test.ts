import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { databasesMock, harnessState, installMemoryHarperMock, resetHarnessState } from "../helpers/memory-search-harness";

const { Memory } = await installMemoryHarperMock();
const { MemoryArchive } = await import("../../resources/MemoryArchive.ts");
const { resetLiveHitTracker } = await import("../../resources/hit-tracking.ts");
const originalGet = (Memory as any).get;
const originalPut = (Memory as any).put;
const tables = databasesMock.flair as any;
const originalStats = tables.MemoryHitStat;
const ctx = { request: { tpsAgent: "agent-a", tpsAgentIsAdmin: true } };
let reads: any[];
let beforeReread: (() => void) | undefined;

beforeEach(() => {
  resetHarnessState();
  resetLiveHitTracker();
  reads = [];
  beforeReread = undefined;
  harnessState.memoryStore.set("memory", {
    id: "memory", agentId: "agent-a", content: "note", createdAt: "2026-01-01T00:00:00.000Z",
    visibility: "shared", archived: false,
  });
  (Memory as any).get = async (id: string, context: any) => {
    if (reads.length === 1) beforeReread?.();
    const resource: any = new (Memory as any)();
    resource.getContext = () => context;
    const row = await resource.get(id);
    reads.push(row);
    return row;
  };
});

afterEach(() => {
  (Memory as any).get = originalGet;
  (Memory as any).put = originalPut;
  tables.MemoryHitStat = originalStats;
  resetLiveHitTracker();
});

async function archive(action: string, context: any = ctx) {
  const resource: any = new (MemoryArchive as any)();
  resource.getContext = () => context;
  return resource.post({ id: "memory", action });
}

for (const action of ["basement", "restore"]) {
  describe(action, () => {
    for (const status of [403, 503]) {
      for (const stage of ["initial read", "transaction read"]) {
        it(`returns the ${status} Response from the ${stage}`, async () => {
          const response = new Response(JSON.stringify({ error: `failure-${status}` }), { status });
          const before = { ...harnessState.memoryStore.get("memory") };
          const realGet = (Memory as any).get;
          let calls = 0;
          (Memory as any).get = async (id: string, context: any) => {
            if (++calls === (stage === "initial read" ? 1 : 2)) return response;
            return realGet(id, context);
          };
          const result = await archive(action);
          expect(result).toBe(response);
          expect(result.status).toBe(status);
          expect(await result.json()).toEqual({ error: `failure-${status}` });
          expect(harnessState.memoryStore.get("memory")).toEqual(before);
        });
      }
    }

    // flair#2478 part 3a: the write is the checked PUT body (putMemoryWithLock);
    // its own refusals are returned with their status and body.
    it("returns the 403 refusal of the write (another agent's row)", async () => {
      const before = { ...harnessState.memoryStore.get("memory") };
      const result = await archive(action, { request: { tpsAgent: "agent-b", tpsAgentIsAdmin: false } });
      expect(result.status).toBe(403);
      expect((await result.json()).error).toContain("cannot write memory owned by another agent");
      expect(harnessState.memoryStore.get("memory")).toEqual(before);
    });

    it("returns the 503 refusal of the write (its supersedes target cannot be read)", async () => {
      harnessState.memoryStore.set("memory", { ...harnessState.memoryStore.get("memory"), supersedes: "earlier" });
      harnessState.getOverride = (id) => {
        if (id === "earlier") throw new Error("store down");
        return undefined;
      };
      const before = { ...harnessState.memoryStore.get("memory") };
      const result = await archive(action);
      expect(result.status).toBe(503);
      expect((await result.json()).error).toBe("supersedes_target_unreadable");
      expect(harnessState.memoryStore.get("memory")).toEqual(before);
    });

    it("accepts an unchanged persisted row when hit stats appear on the second read", async () => {
      let calls = 0;
      tables.MemoryHitStat = {
        get: async () => ++calls === 1 ? null : {
          id: "memory", retrievalCount: 1, lastRetrieved: "2026-01-02T00:00:00.000Z",
        },
      };
      const result = await archive(action);
      expect(reads).toHaveLength(2);
      expect(reads[0].retrievalCount).toBeUndefined();
      expect(reads[0].lastRetrieved).toBeUndefined();
      expect(reads[1].retrievalCount).toBe(1);
      expect(reads[1].lastRetrieved).toBe("2026-01-02T00:00:00.000Z");
      expect(result instanceof Response).toBe(false);
      expect(result.written).toBe(true);
      expect(harnessState.memoryStore.get("memory").archived).toBe(action === "basement");
    });

    for (const [field, value] of Object.entries({
      content: "changed", agentId: "agent-b", visibility: "private", archived: true,
      retrievalCount: 2, lastRetrieved: "2026-01-03T00:00:00.000Z", extraStoredField: "changed",
    })) {
      it(`returns a conflict when persisted ${field} changes`, async () => {
        tables.MemoryHitStat = { get: async () => null };
        beforeReread = () => {
          const row = harnessState.memoryStore.get("memory");
          harnessState.memoryStore.set("memory", { ...row, [field]: value });
        };
        const result = await archive(action);
        expect(result.status).toBe(409);
        expect(await result.json()).toEqual({ error: "memory_changed" });
        expect(harnessState.memoryStore.get("memory")[field]).toBe(value);
      });
    }
  });
}
