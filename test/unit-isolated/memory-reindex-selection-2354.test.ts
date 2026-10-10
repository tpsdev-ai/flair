/**
 * memory-reindex-selection-2354.test.ts — MemoryReindex keeps only the
 * write-back identity fields of each scanned row (flair#2354), never the
 * embedding: each owned write re-reads the full row. Isolated: owns the
 * harper, write-back and Memory mocks.
 */
import { expect, mock, test } from "bun:test";

const IDENTITY = ["id", "agentId", "instanceToken", "contentHash", "createdAt"];
const rows = [
  { id: "r1", agentId: "agent-a", content: "one", contentHash: "h1", createdAt: "2026-01-01T00:00:00.000Z", instanceToken: "t1", embedding: [0.1, 0.2], embeddingModel: "model-a" },
  { id: "r2", agentId: "agent-a", content: "two", contentHash: "h2", createdAt: "2026-01-02T00:00:00.000Z", instanceToken: "t2", embedding: [0.3, 0.4], embeddingModel: "model-a" },
];
const expectedRows: any[] = [];

mock.module("harper", () => ({
  Resource: class {},
  databases: {
    flair: {
      Memory: {
        search: () => (async function* () { for (const row of rows) yield { ...row }; })(),
        get: async (id: string) => rows.find((row) => row.id === id) ?? null,
        put: async () => {},
      },
    },
  },
}));
mock.module("../../resources/agent-auth.ts", () => ({ isAdmin: async () => true, allowAdmin: async () => true }));
mock.module("../../resources/Memory.ts", () => ({ buildReindexRow: (content: any) => ({ row: content }) }));
mock.module("../../resources/write-back.ts", () => ({
  writeBackIdentity: (row: Record<string, unknown>) => Object.fromEntries(IDENTITY.map((field) => [field, row[field]])),
  writeBackCommittedRow: async (_table: unknown, _id: string, _plan: unknown, opts: any) => {
    expectedRows.push(opts.expectedRow);
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
