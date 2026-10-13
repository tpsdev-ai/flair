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
 *
 * flair#2333: the ledger row READ decides whether this (agent, memory) pair
 * already has a row, so a read that FAILS is not "no row" — the contribution
 * aborts (named UsageLedgerReadError, no ledger write, no count bump) rather
 * than upsert over the stored row and bump the count a second time.
 */
import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";
import { installFakeHarperTransaction } from "../helpers/fake-harper-txn";

/** Commits a staged Memory write into the in-memory store when its owned
 *  transaction resolves (flair#2441: the count bump is a write-back). */
const txn = installFakeHarperTransaction((id, row) => memory.set(id, row));

afterAll(() => txn.restore());

const memory = new Map<string, any>();
const usage = new Map<string, any>();
/** Ledger ids whose read throws, to pin the fail-closed ledger read (flair#2333). */
const usageReadThrow = new Set<string>();
/** Every ledger id written through MemoryUsage.put, to prove none is overwritten. */
const usageWrites: string[] = [];
/** Per-id queue of rows Memory.get returns before falling back to `memory`,
 *  so a test can change a row between the core's two reads of it. */
const memoryReadScript = new Map<string, any[]>();
/** Ids a "competitor" changes (a replace) or removes (a delete or purge) by
 *  committing between the count bump's in-transaction read and its write — the
 *  interleaving the committed-row confirmation exists to catch (flair#2476).
 *  Applied inside the fake table's update(), i.e. after the read the plan was
 *  built from. `null` means the row is removed. */
const competitorBeforeWrite = new Map<string, any | null>();

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
        // flair#2470: the count bump is an incremental update of `usageCount`.
        update: async (id: string, patch: Record<string, unknown>) => {
          // A competitor commits between the bump's read and its write.
          if (competitorBeforeWrite.has(id)) {
            const competitor = competitorBeforeWrite.get(id);
            if (competitor === null) memory.delete(id);
            else memory.set(id, competitor);
          }
          const current = memory.get(id) ?? { id };
          const merged = { ...current, ...patch };
          if (txn.stage(id, merged)) return id;
          memory.set(id, merged);
          return id;
        },
      },
      MemoryUsage: {
        get: async (id: string) => {
          if (usageReadThrow.has(id)) throw new Error("simulated ledger read failure");
          return usage.get(id) ?? null;
        },
        put: async (row: any) => {
          usageWrites.push(row.id);
          usage.set(row.id, { ...row });
        },
        // Fake per-key lock for serialization within one Harper process.
        primaryStore: (() => {
          const held = new Set<string>();
          return {
            tryLock: (key: unknown) => {
              const k = JSON.stringify(key);
              if (held.has(k)) return false;
              held.add(k);
              return true;
            },
            unlock: (key: unknown) => {
              held.delete(JSON.stringify(key));
            },
            resetReadTxn: () => {},
          };
        })(),
      },
    },
  },
  Resource: class {},
}));

const { recordUsageContribution, UsageLedgerReadError } = await import("../../resources/usage-recording.ts");
const { resolveReadScope } = await import("../../resources/memory-read-scope.ts");

const REPORTER = "agt_reporter";
const OWNER = "agt_owner";
const NOW = "2026-09-29T00:00:00.000Z";

beforeEach(() => {
  memory.clear();
  usage.clear();
  usageReadThrow.clear();
  usageWrites.length = 0;
  memoryReadScript.clear();
  competitorBeforeWrite.clear();
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

  it("a ledger READ that fails is not 'no row': the contribution aborts, leaving the stored row and the count untouched", async () => {
    // The read is the decision "does this pair already have a row?". An ERROR is
    // not evidence there is none: swallowing it as "no row" would overwrite the
    // stored ledger row below and bump usageCount a second time.
    const ledgerId = `${REPORTER}:own-private`;
    const storedRow = { id: ledgerId, agentId: REPORTER, memoryId: "own-private", createdAt: NOW, attribution: "earlier" };
    usage.set(ledgerId, { ...storedRow }); // an existing ledger row
    usageReadThrow.add(ledgerId);
    await expect(contribute("own-private")).rejects.toThrow(UsageLedgerReadError);
    expect(usageWrites, "an aborted contribution writes no ledger row").toEqual([]);
    expect(usage.get(ledgerId), "the stored ledger row is not overwritten").toEqual(storedRow);
    expect(memory.get("own-private").usageCount, "the count is not bumped").toBeUndefined();
  });

  // flair#2476: the count bump confirms the committed row after staging the update and before committing. A
  // competitor that commits between the bump's read and its write — a delete, a
  // purge, or a same-id replace — must leave the competitor's state in place and
  // never bump the count.
  describe("the count bump confirms the committed row after staging the update and before committing (flair#2476)", () => {
    it("a row removed (deleted or purged) between the read and the write is not re-created and the count does not land", async () => {
      competitorBeforeWrite.set("own-private", null);
      await contribute("own-private");
      expect(memory.has("own-private"), "the count bump re-created the removed row").toBe(false);
      expect(usage.has(`${REPORTER}:own-private`), "the ledger row written after the first read stays").toBe(true);
    });

    it("a same-id replace between the read and the write is refused, not overwritten, and not counted", async () => {
      competitorBeforeWrite.set("own-private", { id: "own-private", agentId: REPORTER, visibility: "private", content: "replaced", instanceToken: "T2" });
      // The stored row is no longer the one read: the bump is refused by name.
      await expect(contribute("own-private")).rejects.toThrow();
      const row = memory.get("own-private");
      expect(row.content, "the competitor's content is overwritten").toBe("replaced");
      expect(row.instanceToken, "the competitor's incarnation token is overwritten").toBe("T2");
      expect(row.usageCount ?? null, "the stale bump incremented the replaced row").toBeNull();
    });

    it("CONTROL: with no competitor the count lands", async () => {
      await contribute("own-private");
      expect(memory.get("own-private").usageCount).toBe(1);
    });
  });
});
