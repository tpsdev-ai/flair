/**
 * memory-reindex-confirm-2709.test.ts — MemoryReindex confirms written rows
 * against one agentId-index scan per agent, and still reports a written row
 * that the scan does not list. Isolated: owns the harper, write-back and
 * Memory mocks.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { memoryLockDouble } from "../helpers/memory-lock-double.ts";

const IDENTITY = ["id", "agentId", "instanceToken", "contentHash", "createdAt"];
let rows: any[] = [];
let missingFromIndex = new Set<string>();
let indexVisits = 0;
let countIndexVisits = false;
let failConfirmFor = new Set<string>();
let agentScans = new Map<string, number>();
let indexQueries: Array<{ conditions: any[]; confirmation: boolean }> = [];

function makeRows(count: number, agentId = "agent-a", prefix = "r"): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`, agentId, content: `row ${i}`,
    contentHash: `h${i}`, createdAt: "2026-01-01T00:00:00.000Z",
    instanceToken: `t${i}`, embedding: [0.1, 0.2], embeddingModel: "model-a",
  }));
}

beforeEach(() => {
  rows = [];
  missingFromIndex = new Set();
  indexVisits = 0;
  countIndexVisits = false;
  failConfirmFor = new Set();
  agentScans = new Map();
  indexQueries = [];
});

mock.module("harper", () => ({
  Resource: class {},
  databases: {
    flair: {
      Memory: {
        primaryStore: memoryLockDouble(),
        search: (query?: any, options?: any) => (async function* () {
          const agentCondition = query?.conditions?.find((condition: any) => condition.attribute === "agentId");
          if (query?.conditions) indexQueries.push({ conditions: query.conditions, confirmation: options !== undefined });
          if (agentCondition) {
            const agentId = String(agentCondition.value);
            const scan = (agentScans.get(agentId) ?? 0) + 1;
            agentScans.set(agentId, scan);
            // The first agentId scan per agent is the drift probe; a later one
            // is that agent's post-write confirmation scan.
            if (failConfirmFor.has(agentId) && scan >= 2) throw new Error(`index scan failed for ${agentId}`);
          }
          const selected = agentCondition
            ? rows.filter((row) => row.agentId === agentCondition.value && !missingFromIndex.has(row.id))
            : rows;
          for (const row of selected) {
            if (countIndexVisits && agentCondition) indexVisits++;
            yield { ...row };
          }
        })(),
        get: async (id: string) => rows.find((row) => row.id === id) ?? null,
        put: async () => {},
      },
    },
  },
}));
mock.module("../../resources/agent-auth.ts", () => ({ annotatedCallerIsAdmin: async () => true, allowAdmin: async () => true }));
mock.module("../../resources/Memory.ts", () => ({ buildReindexRow: (content: any) => ({ row: content }) }));
mock.module("../../resources/write-back.ts", () => ({
  WriteBackConflictError: class extends Error {
    constructor(label: string, id: string, _attempts: number, readonly outcome: "conflict" | "unconfirmed" = "conflict") { super(`${label}: ${id} ${outcome}`); }
  },
  writeBackIdentity: (row: Record<string, unknown>) => Object.fromEntries(IDENTITY.map((field) => [field, row[field]])),
  writeBackCommittedRow: async (_table: unknown, id: string, plan: any) => {
    const row = rows.find((candidate) => candidate.id === id);
    return row ? plan(row) : { skip: true };
  },
}));

const { MemoryReindex } = await import("../../resources/MemoryReindex.ts");

function reindexer() {
  const resource: any = new (MemoryReindex as any)();
  resource.getContext = () => ({ request: { headers: new Headers({ "x-tps-agent": "admin" }) } });
  return resource;
}

test("reports a written row that the committed agentId index does not list", async () => {
  rows = makeRows(3);
  missingFromIndex = new Set(["r1"]);
  const result = await reindexer().post({ batchSize: 10 });
  expect(result.stats.reindexed).toBe(2);
  expect(result.stats.errors).toBe(1);
  expect(result.stats.errorSamples[0]).toEqual({
    id: "r1",
    message: "MemoryReindex: row r1 was confirmed after commit but is now absent from the agentId index query (index unconfirmed)",
    outcome: "unconfirmed",
  });
});

test("a confirmation scan that fails reports that agent's written rows as errors and leaves the other agent's rows reindexed", async () => {
  rows = [...makeRows(2, "agent-a", "a"), ...makeRows(2, "agent-b", "b")];
  failConfirmFor = new Set(["agent-b"]);
  const result = await reindexer().post({ batchSize: 10 });
  expect(result.stats.reindexed).toBe(2);
  expect(result.stats.errors).toBe(2);
  expect(result.stats.errorSamples).toEqual([
    { id: "b0", message: "index scan failed for agent-b" },
    { id: "b1", message: "index scan failed for agent-b" },
  ]);
  expect(result.stats.totalMissing).toBe(0);
});

test("confirms each agent's rows with a scan scoped to that agent", async () => {
  rows = [...makeRows(2, "agent-a", "a"), ...makeRows(2, "agent-b", "b")];
  missingFromIndex = new Set(["b1"]);
  const result = await reindexer().post({ batchSize: 10 });
  expect(result.stats.reindexed).toBe(3);
  expect(result.stats.errors).toBe(1);
  expect(result.stats.errorSamples).toHaveLength(1);
  expect(result.stats.errorSamples[0]).toEqual({
    id: "b1",
    message: "MemoryReindex: row b1 was confirmed after commit but is now absent from the agentId index query (index unconfirmed)",
    outcome: "unconfirmed",
  });
  const confirmations = indexQueries.filter((query) => query.confirmation);
  expect(confirmations).toHaveLength(2);
  for (const query of confirmations) {
    expect(query.conditions).toHaveLength(1);
    expect(query.conditions[0]).toMatchObject({ attribute: "agentId", comparator: "equals" });
  }
  expect(confirmations.map((query) => query.conditions[0].value).sort()).toEqual(["agent-a", "agent-b"]);
});

for (const count of [50, 200]) {
  test(`mocked agentId search results consumed grow linearly with the number of selected rows when every write succeeds (${count})`, async () => {
    rows = makeRows(count);
    countIndexVisits = true;
    const result = await reindexer().post({ batchSize: 1000 });
    expect(result.stats.reindexed).toBe(count);
    expect(result.stats.errors).toBe(0);
    expect(indexVisits).toBeLessThanOrEqual(4 * count);
  }, 10_000);
}
