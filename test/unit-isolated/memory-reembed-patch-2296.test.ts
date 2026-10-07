/**
 * memory-reembed-patch-2296.test.ts — Memory.patch()'s re-embed request
 * (flair#2296): a PATCH body of `{ embedding: null, embeddingModel: null }`.
 * The real-Harper path is covered by
 * test/integration/reembed-preserves-fields-2296.test.ts; this file drives the
 * resource's refusals and its write against the shared table mock, with the
 * embedding engine stubbed.
 */
import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  databasesMock, harnessState, mockTransaction, MockRequestTarget, resetHarnessState,
} from "../helpers/memory-search-harness";

type EmbedCall = { text: string; opts: any };
let embedCalls: EmbedCall[] = [];
let embedImpl: (text: string) => Promise<Array<number[]>> = async () => [[0.25, 0.5, 0.75]];

(globalThis as any).transaction = mockTransaction;
mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: databasesMock,
  Resource: class {},
  transaction: mockTransaction,
  RequestTarget: MockRequestTarget,
  models: {
    embed: async (text: string, opts: any) => {
      embedCalls.push({ text, opts });
      return embedImpl(text);
    },
  },
}));
const { Memory } = await import("../../resources/Memory.ts");
const { getModelId } = await import("../../resources/embeddings-provider.ts");

const REEMBED = { embedding: null, embeddingModel: null };
const agent = (id: string, isAdmin = false) => ({ request: { tpsAgent: id, tpsAgentIsAdmin: isAdmin } });

function resource(id: string, ctx: unknown): any {
  const r: any = new (Memory as any)();
  r.getId = () => id;
  r.getContext = () => ctx;
  return r;
}

function row(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, agentId: "agent-a", content: `content of ${id}`, subject: "subject-a", tags: ["release"],
    durability: "persistent", visibility: "private", createdAt: "2001-01-01T00:00:00.000Z",
    updatedAt: "2001-01-02T00:00:00.000Z", archived: true, promotionStatus: "approved",
    provenance: "{\"v\":1}", instanceToken: "token-a", embedding: [9, 9, 9], embeddingModel: "old-model",
    ...overrides,
  };
}

const documentEmbeds = () => embedCalls.filter((c) => c.opts?.inputType === "document");

beforeEach(() => {
  resetHarnessState();
  embedCalls = [];
  embedImpl = async () => [[0.25, 0.5, 0.75]];
});

test("the owner's request writes embedding, embeddingModel and updatedAt and leaves every other field", async () => {
  const before = row("m1");
  harnessState.memoryStore.set("m1", { ...before });
  const res = await resource("m1", agent("agent-a")).patch({ ...REEMBED });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ id: "m1", embeddingModel: getModelId(), updatedAt: expect.any(String) });
  const after = harnessState.memoryStore.get("m1");
  expect(after).toEqual({ ...before, embedding: [0.25, 0.5, 0.75], embeddingModel: getModelId(), updatedAt: body.updatedAt });
  expect(documentEmbeds().map((c) => c.text)).toEqual(["content of m1"]);
}, 10_000);

test("a skill row is re-embedded from its trigger, not refused as a skill patch", async () => {
  harnessState.memoryStore.set("s1", row("s1", { tags: ["skill"], trigger: "when releasing", archived: false }));
  const res = await resource("s1", agent("agent-a")).patch({ ...REEMBED });
  expect(res.status).toBe(200);
  expect(documentEmbeds().map((c) => c.text)).toEqual(["when releasing"]);
}, 10_000);

test("another agent's request is refused and nothing is written", async () => {
  const before = row("m1");
  harnessState.memoryStore.set("m1", { ...before });
  const res = await resource("m1", agent("agent-b")).patch({ ...REEMBED });
  expect(res.status).toBe(403);
  expect(harnessState.memoryStore.get("m1")).toEqual(before);
  expect(documentEmbeds()).toEqual([]);
}, 10_000);

test("an admin may re-embed another agent's row", async () => {
  harnessState.memoryStore.set("m1", row("m1"));
  const res = await resource("m1", agent("root", true)).patch({ ...REEMBED });
  expect(res.status).toBe(200);
  expect(harnessState.memoryStore.get("m1").embeddingModel).toBe(getModelId());
}, 10_000);

test("an anonymous request is refused and nothing is written", async () => {
  const before = row("m1");
  harnessState.memoryStore.set("m1", { ...before });
  const res = await resource("m1", { request: { tpsAnonymous: true } }).patch({ ...REEMBED });
  expect(res.status).toBe(401);
  expect(harnessState.memoryStore.get("m1")).toEqual(before);
}, 10_000);

test("a request for a row that does not exist is 404 and creates nothing", async () => {
  const res = await resource("missing", agent("root", true)).patch({ ...REEMBED });
  expect(res.status).toBe(404);
  expect(harnessState.memoryStore.size).toBe(0);
}, 10_000);

test.each([
  ["throws", async () => { throw new Error("engine down"); }],
  ["returns no vector", async () => []],
  ["returns an empty vector", async () => [[]]],
  ["returns a non-numeric vector", async () => [["bad"]]],
  ["returns a non-finite vector", async () => [[NaN]]],
])("when the embedding engine %s, the request is 503 and the row is unchanged", async (_label, impl) => {
  const before = row("m1");
  harnessState.memoryStore.set("m1", { ...before });
  embedImpl = impl as typeof embedImpl;
  const patch = spyOn(databasesMock.flair.Memory.prototype, "patch");
  try {
    const res = await resource("m1", agent("agent-a")).patch({ ...REEMBED });
    expect(res.status).toBe(503);
    expect(harnessState.memoryStore.get("m1")).toEqual(before);
    expect(patch).not.toHaveBeenCalled();
  } finally {
    patch.mockRestore();
  }
}, 10_000);

test("a failed stored-row read writes nothing", async () => {
  const before = row("m1");
  harnessState.memoryStore.set("m1", { ...before });
  harnessState.getOverride = () => { throw new Error("read failed"); };
  const res = await resource("m1", agent("agent-a")).patch({ ...REEMBED });
  expect(res.status).toBe(500);
  expect((await res.json()).error).toBe("stored_row_lookup_failed");
  harnessState.getOverride = null;
  expect(harnessState.memoryStore.get("m1")).toEqual(before);
  expect(documentEmbeds()).toEqual([]);
}, 10_000);

test("a body that also sets another field is an ordinary PATCH (a skill row stays refused)", async () => {
  const before = row("s1", { tags: ["skill"], trigger: "when releasing", archived: false });
  harnessState.memoryStore.set("s1", { ...before });
  const res = await resource("s1", agent("agent-a")).patch({ ...REEMBED, subject: "changed" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("skill_write_path");
  expect(harnessState.memoryStore.get("s1")).toEqual(before);
  expect(documentEmbeds()).toEqual([]);
}, 10_000);
