/**
 * agent-federation-bookkeeping-2433.test.ts — the Agent resource and the
 * receiver bookkeeping fields (`_syncedFrom`, `_originatorInstanceId`).
 * The real-Harper cases are in test/integration/agent-home-2433.test.ts; this
 * file drives the resource against a table stub and records what it writes.
 */
import { beforeEach, expect, mock, test } from "bun:test";

const store = new Map<string, Record<string, unknown>>();
let written: Record<string, unknown> | null = null;

class StubAgentTable {
  static async get(id: string) {
    return store.get(id) ?? null;
  }
  async get() {
    return store.get((this as any).getId()) ?? null;
  }
  async put(content: any) {
    written = { ...content };
    return { status: 200 };
  }
  async patch(content: any) {
    written = { ...content };
    return { status: 200 };
  }
  async post(content: any) {
    written = { ...content };
    return { status: 200 };
  }
}

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: { flair: { Agent: StubAgentTable, Instance: { search: async function* () { yield { id: "inst-local" }; } } } },
  Resource: class {},
}));
const { Agent } = await import("../../resources/Agent.ts");

function resource(id: string): any {
  const r: any = new (Agent as any)();
  r.getId = () => id;
  r.getContext = () => undefined;
  return r;
}

const STORED = { id: "a1", name: "a1", publicKey: "pk", _syncedFrom: "peer-1", _originatorInstanceId: "peer-1" };

beforeEach(() => {
  store.clear();
  written = null;
  store.set("a1", { ...STORED });
});

test("a put that supplies or omits the bookkeeping writes the stored values", async () => {
  await resource("a1").put({ id: "a1", name: "a1", _syncedFrom: "forged", _originatorInstanceId: "forged" });
  expect(written?._syncedFrom).toBe("peer-1");
  expect(written?._originatorInstanceId).toBe("peer-1");
  await resource("a1").put({ id: "a1", name: "a1" });
  expect(written?._syncedFrom).toBe("peer-1");
  expect(written?._originatorInstanceId).toBe("peer-1");
});

test("a patch that supplies or clears the bookkeeping writes the stored values", async () => {
  await resource("a1").patch({ _syncedFrom: "forged", _originatorInstanceId: null });
  expect(written?._syncedFrom).toBe("peer-1");
  expect(written?._originatorInstanceId).toBe("peer-1");
});

test("a post drops any supplied bookkeeping", async () => {
  await resource("new").post({ id: "new", name: "new", publicKey: "pk", _syncedFrom: "forged", _originatorInstanceId: "forged", _syncedAt: "x" });
  expect(written).not.toBeNull();
  expect(written?._syncedFrom).toBeUndefined();
  expect(written?._originatorInstanceId).toBeUndefined();
  expect(written?._syncedAt).toBeUndefined();
});
