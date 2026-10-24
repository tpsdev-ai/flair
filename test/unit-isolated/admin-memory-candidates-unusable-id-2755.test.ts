/**
 * admin-memory-candidates-unusable-id-2755.test.ts — the candidate route fails
 * a listing that would leave out a row without a usable id.
 *
 * Drives the REAL `AdminMemoryCandidates.get()` against a mocked `harper` whose
 * MemoryCandidate search yields scripted rows, so a numeric id (which Harper's
 * primary key refuses) and a missing id (for which Harper generates one) reach
 * the handler too. The real-Harper
 * cases, an empty string and an array id, are in
 * test/integration/admin-memory-candidates-2755.test.ts.
 *
 * Isolated: this file owns its `harper` mock.
 */
import { describe, expect, mock, test } from "bun:test";

class NoopBase {
  constructor(_id?: any, _ctx?: any) {}
}

let rows: any[] = [];
mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  Resource: NoopBase,
  databases: {
    flair: new Proxy(
      {
        MemoryCandidate: {
          search: async function* () {
            for (const row of rows) yield row;
          },
        },
      },
      { get: (target: any, key) => target[key] ?? { get: async () => null, search: async function* () {} } },
    ),
  },
}));

const { AdminMemoryCandidates } = await import("../../resources/AdminMemoryCandidates.ts");

async function listFor(scripted: any[], limit = 10): Promise<{ status: number; body: any }> {
  rows = scripted;
  const route: any = new (AdminMemoryCandidates as any)();
  route.getContext = () => ({ request: { url: `http://localhost/AdminMemoryCandidates/agent-a?limit=${limit}` } });
  const res: Response = await route.get("agent-a");
  return { status: res.status, body: await res.json() };
}

describe("flair#2755 — AdminMemoryCandidates with an unusable row id", () => {
  for (const [name, row] of [
    ["a missing id", { agentId: "agent-a" }],
    ["an empty id", { id: "", agentId: "agent-a" }],
    ["a numeric id", { id: 7, agentId: "agent-a" }],
    ["an array id", { id: ["a", "b"], agentId: "agent-a" }],
  ] as Array<[string, any]>) {
    test(`fails the listing with candidate_id_unusable for a row with ${name}`, async () => {
      const { status, body } = await listFor([{ id: "c-1", agentId: "agent-a" }, row, { id: "c-2", agentId: "agent-a" }]);
      expect(status).toBe(500);
      expect(body.error).toBe("candidate_id_unusable");
      expect(body.candidates).toBeUndefined();
    });
  }

  test("lists usable rows completely, with hasMore only past the limit", async () => {
    const usable = [{ id: "c-1" }, { id: "c-2" }, { id: "c-3" }];
    expect(await listFor(usable)).toEqual({ status: 200, body: { candidates: usable, hasMore: false } });
    expect(await listFor(usable, 2)).toEqual({ status: 200, body: { candidates: usable.slice(0, 2), hasMore: true } });
  });
});
