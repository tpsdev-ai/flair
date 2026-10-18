/**
 * memory-reindex-selection-2354.test.ts — MemoryReindex keeps only the
 * write-back identity fields of each scanned row (flair#2354), never the
 * embedding: each owned write re-reads the full row. Isolated: owns the
 * harper, write-back and Memory mocks.
 */
import { beforeEach, expect, mock, test } from "bun:test";

const IDENTITY = ["id", "agentId", "instanceToken", "contentHash", "createdAt"];
const rows = [
  { id: "r1", agentId: "agent-a", content: "one", contentHash: "h1", createdAt: "2026-01-01T00:00:00.000Z", instanceToken: "t1", embedding: [0.1, 0.2], embeddingModel: "model-a" },
  { id: "r2", agentId: "agent-a", content: "two", contentHash: "h2", createdAt: "2026-01-02T00:00:00.000Z", instanceToken: "t2", embedding: [0.3, 0.4], embeddingModel: "model-a" },
];
const expectedRows: any[] = [];
let simulateWrite = false;
let missingIndex = false;
beforeEach(() => {
  expectedRows.length = 0;
  simulateWrite = false;
  missingIndex = false;
});

mock.module("harper", () => ({
  Resource: class {},
  databases: {
    flair: {
      Memory: {
        search: (query?: any) => (async function* () { for (const row of rows) if (!query || !missingIndex) yield { ...row }; })(),
        get: async (id: string) => rows.find((row) => row.id === id) ?? null,
        put: async () => {},
      },
    },
  },
}));
mock.module("../../resources/agent-auth.ts", () => ({ isAdmin: async () => true, allowAdmin: async () => true }));
mock.module("../../resources/Memory.ts", () => ({ buildReindexRow: (content: any) => ({ row: content }) }));
mock.module("../../resources/write-back.ts", () => ({
  WriteBackConflictError: class extends Error {
    constructor(label: string, id: string, _attempts: number, readonly outcome: "conflict" | "unconfirmed" = "conflict") { super(`${label}: ${id} ${outcome}`); }
  },
  writeBackIdentity: (row: Record<string, unknown>) => Object.fromEntries(IDENTITY.map((field) => [field, row[field]])),
  writeBackCommittedRow: async (_table: unknown, id: string, plan: any, opts: any) => {
    expectedRows.push(opts.expectedRow);
    if (simulateWrite) return plan(rows.find(row => row.id === id));
    return { skip: true };
  },
}));

const { MemoryReindex } = await import("../../resources/MemoryReindex.ts");

test("each write-back is handed only the identity fields of its scanned row", async () => {
  const r: any = new (MemoryReindex as any)();
  r.getContext = () => ({ request: { headers: new Headers({ "x-tps-agent": "admin" }) } });
  await r.post({ batchSize: 10 });
  expect(expectedRows).toHaveLength(rows.length);
  for (const [i, expected] of expectedRows.entries()) {
    expect(Object.keys(expected).sort()).toEqual([...IDENTITY].sort());
    expect(expected).not.toHaveProperty("embedding");
    expect(expected.instanceToken).toBe(rows[i].instanceToken);
  }
});

for (const missing of [false, true]) {
  test(`reindex count requires an agentId index result (missing: ${missing})`, async () => {
    simulateWrite = true;
    missingIndex = missing;
    const r: any = new (MemoryReindex as any)();
    r.getContext = () => ({ request: { headers: new Headers({ "x-tps-agent": "admin" }) } });
    const result = await r.post({});
    expect(result.stats.reindexed).toBe(missing ? 0 : rows.length);
    expect(result.stats.errors).toBe(missing ? rows.length : 0);
    if (missing) {
      expect(result.stats.errorSamples[0].message).toContain("MemoryReindex agentId index");
      expect(result.stats.errorSamples[0].outcome).toBe("unconfirmed");
    }
  });
}
