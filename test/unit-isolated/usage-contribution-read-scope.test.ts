/**
 * resources/usage-recording.ts's recordUsageContribution() — the one ledger
 * write shared by POST /RecordUsage and citation-on-write — records a
 * contribution only for a memory its `canRead` predicate (the contributing
 * agent's resolveReadScope().isAllowed, admin agents included) accepts. A
 * memory it rejects on the first read ends on the same no-op as a missing id:
 * no ledger row, no count change. The predicate is applied again to the
 * re-read right before the count bump; a rejection there skips the bump, and
 * the ledger row written after the first read stays.
 *
 * Driven against an in-memory double of the two raw tables it touches
 * (Memory, MemoryUsage), with the REAL resolveReadScope predicate. Isolated
 * lane: the `harper` module mock below is process-global.
 */
import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";
import { installFakeHarperTransaction } from "../helpers/fake-harper-txn";

/** Commits a staged Memory write into the in-memory store when its owned
 *  transaction resolves (flair#2441: the count bump is a write-back). */
const txn = installFakeHarperTransaction((id, row) => memory.set(id, row));

afterAll(() => txn.restore());

const memory = new Map<string, any>();
const usage = new Map<string, any>();
/** Per-id queue of rows Memory.get returns before falling back to `memory`,
 *  so a test can change a row between the core's two reads of it. */
const memoryReadScript = new Map<string, any[]>();

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: {
    flair: {
      Memory: {
        get: async (id: string) => {
          const scripted = memoryReadScript.get(id);
          if (scripted && scripted.length > 0) return scripted.shift();
          return memory.has(id) ? { ...memory.get(id) } : null;
        },
        put: async (row: any) => {
          if (txn.stage(row.id, row)) return row.id;
          memory.set(row.id, { ...row });
          return row.id;
        },
      },
      MemoryUsage: {
        get: async (id: string) => usage.get(id) ?? null,
        put: async (row: any) => {
          usage.set(row.id, { ...row });
        },
      },
    },
  },
  Resource: class {},
}));

const { recordUsageContribution } = await import("../../resources/usage-recording.ts");
const { resolveReadScope } = await import("../../resources/memory-read-scope.ts");

const REPORTER = "agt_reporter";
const OWNER = "agt_owner";
const NOW = "2026-09-29T00:00:00.000Z";

beforeEach(() => {
  memory.clear();
  usage.clear();
  memoryReadScript.clear();
  memory.set("own-private", { id: "own-private", agentId: REPORTER, visibility: "private", content: "own" });
  memory.set("other-shared", { id: "other-shared", agentId: OWNER, visibility: "shared", content: "shared" });
  memory.set("other-private", { id: "other-private", agentId: OWNER, visibility: "private", content: "private" });
});

async function contribute(memoryId: string): Promise<void> {
  const scope = await resolveReadScope(REPORTER);
  await recordUsageContribution({}, REPORTER, memoryId, undefined, NOW, scope.isAllowed);
}

describe("recordUsageContribution — the contributing agent's read scope", () => {
  it("counts the agent's own memory, at any visibility", async () => {
    await contribute("own-private");
    expect(usage.has(`${REPORTER}:own-private`)).toBe(true);
    expect(memory.get("own-private").usageCount).toBe(1);
  });

  it("counts another agent's shared memory", async () => {
    await contribute("other-shared");
    expect(usage.has(`${REPORTER}:other-shared`)).toBe(true);
    expect(memory.get("other-shared").usageCount).toBe(1);
  });

  it("another agent's private memory ends exactly like a missing id: no ledger row, counters unchanged", async () => {
    const before = { ...memory.get("other-private") };
    await contribute("other-private");
    await contribute("does-not-exist");
    expect([...usage.keys()]).toEqual([]);
    expect(memory.get("other-private")).toEqual(before);
    expect(memory.has("does-not-exist")).toBe(false);
  });

  it("a memory that leaves the agent's read scope before the count bump is not counted", async () => {
    // First read: shared (passes the gate, ledger row written). Re-read right
    // before the bump: the owner has made it private. The bump is skipped; the
    // row written after the first read stays.
    memoryReadScript.set("other-shared", [
      { id: "other-shared", agentId: OWNER, visibility: "shared", content: "shared" },
      { id: "other-shared", agentId: OWNER, visibility: "private", content: "shared" },
    ]);
    await contribute("other-shared");
    expect(memory.get("other-shared").usageCount).toBeUndefined();
  });

  it("a predicate that throws counts nothing", async () => {
    const throwing = () => {
      throw new Error("simulated predicate failure");
    };
    await expect(recordUsageContribution({}, REPORTER, "other-shared", undefined, NOW, throwing)).rejects.toThrow();
    expect([...usage.keys()]).toEqual([]);
    expect(memory.get("other-shared").usageCount).toBeUndefined();
  });
});
