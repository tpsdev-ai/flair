/**
 * stampMemoryPromotion failure after a successful Memory write must not abort
 * the auto-promote sweep or leave the candidate pending (Bugbot Medium on
 * #1534). Isolated: owns the harper + Memory mocks.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

const candidatePuts: any[] = [];
const memoryPuts: any[] = [];

const candidates = [
  { id: "cand-1", agentId: "alice", status: "pending", claim: "Eligible auto-promote claim one about release rollback.", scopeTag: "adk:app:alice", sourceMemoryIds: [] },
  { id: "cand-2", agentId: "alice", status: "pending", claim: "Eligible auto-promote claim two about deploy verification.", scopeTag: "adk:app:alice", sourceMemoryIds: [] },
];

const pendingManual = {
  id: "cand-manual",
  agentId: "alice",
  status: "pending",
  claim: "Manual promotion fixture about release verification.",
  sourceMemoryIds: [],
};

mock.module("../../resources/Memory.ts", () => ({
  Memory: {
    put: async (row: any) => {
      memoryPuts.push(row);
      return row;
    },
    get: async () => null,
  },
}));

mock.module("../../resources/MemoryCandidate.ts", () => ({
  MemoryCandidate: {
    get: async () => ({ ...pendingManual }),
  },
}));

mock.module("harper", () => ({
  databases: {
    flair: {
      MemoryCandidate: {
        search: () => (async function* () { for (const c of candidates) yield { ...c }; })(),
        put: async (row: any) => { candidatePuts.push(row); },
      },
      // Stamp reads the raw table. Returning null makes stampMemoryPromotion
      // throw — the Isolated wrapper must catch that.
      Memory: {
        get: async () => null,
        put: async () => { throw new Error("stamp put should not run when get misses"); },
      },
    },
  },
  Resource: class {},
  logger: { warn: () => {} },
  server: { http: () => {}, getUser: async () => null },
}));

mock.module("../../resources/agent-auth.ts", () => ({
  allowVerified: async () => true,
  isAdmin: async () => false,
  resolveAgentAuth: async () => ({ kind: "agent", agentId: "alice", isAdmin: false }),
}));

const { stampMemoryPromotion, stampMemoryPromotionIsolated } = await import("../../resources/promotion-stamp.ts");
const { AutoPromoteCandidates } = await import("../../resources/AutoPromoteCandidates.ts");
const { PromoteMemoryCandidate } = await import("../../resources/PromoteMemoryCandidate.ts");

beforeEach(() => {
  candidatePuts.length = 0;
  memoryPuts.length = 0;
});

describe("stampMemoryPromotionIsolated", () => {
  test("a stamp throw does not escape", async () => {
    await expect(stampMemoryPromotion("m1", "reviewer", "t")).rejects.toThrow("was not written");
    expect(await stampMemoryPromotionIsolated("m1", "reviewer", "t")).toBe(false);
  });
});

describe("AutoPromoteCandidates stamp isolation", () => {
  test("a stamp failure after a Memory write does not stop the sweep or leave candidates pending", async () => {
    const r: any = new (AutoPromoteCandidates as any)();
    r.getContext = () => ({ request: { tpsAgent: "alice", tpsAgentIsAdmin: false } });
    const result = await r.post({ agentId: "alice" });
    expect(result.promoted).toHaveLength(2);
    expect(result.count).toBe(2);
    expect(memoryPuts).toHaveLength(2);
    expect(candidatePuts).toHaveLength(2);
    expect(candidatePuts.every((c) => c.status === "promoted")).toBe(true);
    expect(candidatePuts.map((c) => c.id).sort()).toEqual(["cand-1", "cand-2"]);
  });
});

describe("PromoteMemoryCandidate stamp isolation", () => {
  test("a stamp failure still marks the candidate promoted so a retry is 409, not a second write", async () => {
    const r: any = new (PromoteMemoryCandidate as any)();
    r.getContext = () => ({ request: { tpsAgent: "alice", tpsAgentIsAdmin: false } });
    const result = await r.post({ candidateId: "cand-manual", rationale: "reviewed the claim" });
    expect(result.memoryId).toBeDefined();
    expect(result.candidateId).toBe("cand-manual");
    expect(candidatePuts.at(-1)?.status).toBe("promoted");
    expect(candidatePuts.at(-1)?.id).toBe("cand-manual");
  });
});
