import { describe, expect, test, beforeEach, mock } from "bun:test";
import { DECLARED_MEMORY_ATTRIBUTES } from "../../src/lib/memory-attributes.ts";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async () => [1, 0, 0, 0],
  getModelId: () => "mock-embedding-model",
  getMode: () => "local",
  EMBEDDING_ENGINE: "gguf",
}));

let memoryStore: Map<string, any>;

class BaseMemory {
  getId() { return (this as any).id; }
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id ?? (this as any).id;
    return memoryStore.get(id) ?? null;
  }
  static async get(id: any) {
    return memoryStore.get(typeof id === "string" ? id : id?.id) ?? null;
  }
  static async put(content: any) { memoryStore.set(content.id, { ...content }); return undefined; }
  // Harper PUT semantics: the stored row IS the content (full replacement).
  async put(content: any) {
    memoryStore.set(content.id, { ...content });
  }
  search() {
    async function* gen() { for (const r of memoryStore.values()) yield r; }
    return gen();
  }
}

mock.module("harper", () => ({
  databases: {
    flair: {
      Memory: BaseMemory,
      MemoryGrant: { search: () => (async function* () {})() },
      Agent: { get: async () => null, search: async () => [] },
      Instance: { search: () => (async function* () {})() },
    },
  },
  Resource: class {},
  logger: { warn: () => {} },
  server: { http: () => {}, getUser: async () => null },
}));

const { Memory } = await import("../../resources/Memory.ts");

(globalThis as any).transaction = (ctx: any, cb: (txn: any) => any) => {
  if (ctx?.transaction && ctx.transaction.open === 1) return cb(ctx.transaction);
  const txn: any = { open: 1, saveCommits: false, abort() { this.open = 0; }, commit() { this.open = 0; } };
  const c = ctx && typeof ctx === "object" ? ctx : {};
  c.transaction = txn;
  return cb(txn);
};

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const FROM = "2026-01-01T00:00:00.000Z";

async function reindex(body: Record<string, unknown>): Promise<any> {
  const r: any = new (Memory as any)();
  r.id = body.id;
  r.getContext = () => undefined; // internal caller: the admin gate passes
  return r.put({ ...body, _reindex: true });
}

const skill = () => ({
  id: "sk", agentId: "alice", content: "do x", trigger: "when x", tags: ["skill"], durability: "persistent",
  visibility: "shared", skillSubjectId: "sk", expiresAt: PAST, validFrom: FROM,
});
const plain = () => ({ id: "pm", agentId: "alice", content: "a note", durability: "standard", visibility: "private" });

beforeEach(() => {
  memoryStore = new Map();
  memoryStore.set("sk", skill());
  memoryStore.set("pm", plain());
});

const status = (res: unknown) => (res instanceof Response ? res.status : 200);

describe("_reindex protected payload and archival fields", () => {
  for (const [field, value] of [["archivedAt", FUTURE], ["archivedBy", "mallory"]] as const) {
    test(`a skill's changed ${field} is refused without changing the stored row`, async () => {
      const stored = { ...skill(), archived: true, archivedAt: PAST, archivedBy: "alice" };
      memoryStore.set(stored.id, stored);
      const result = await reindex({ ...stored, [field]: value });
      expect(status(result)).toBe(409);
      expect(await result.json()).toMatchObject({ error: "reindex_would_change_row" });
      expect(memoryStore.get(stored.id)).toEqual(stored);
    });
  }

  for (const [field, value] of [
    ["content", "rewritten"], ["tags", ["other-tag"]], ["metadata", { source: "other" }], ["durability", "persistent"],
  ] as const) {
    test(`a plain row's changed ${field} is refused without changing the stored row`, async () => {
      const stored = { ...plain(), tags: ["note"], metadata: { source: "original" } };
      memoryStore.set(stored.id, stored);
      const result = await reindex({ ...stored, [field]: value });
      expect(status(result)).toBe(409);
      expect(await result.json()).toMatchObject({ error: "reindex_would_change_row" });
      expect(memoryStore.get(stored.id)).toEqual(stored);
    });
  }

  for (const row of [skill, plain]) {
    test(`a same-values ${row.name} re-PUT succeeds`, async () => {
      const stored = { ...row(), tags: row === skill ? ["skill"] : ["note"], metadata: { source: "original" }, archived: true, archivedAt: PAST, archivedBy: "alice" };
      memoryStore.set(stored.id, stored);
      const body = JSON.parse(JSON.stringify(stored));
      expect(status(await reindex(body))).toBe(200);
      expect(memoryStore.get(stored.id)).toMatchObject(stored);
    });
  }
});

describe("_reindex cannot revive an expired skill", () => {
  test("a body that supplies a new expiresAt is refused", async () => {
    expect(status(await reindex({ ...skill(), expiresAt: FUTURE }))).toBe(409);
    expect(memoryStore.get("sk").expiresAt).toBe(PAST);
  });

  test("a body that omits expiresAt keeps the stored value", async () => {
    const { expiresAt: _drop, ...body } = skill();
    expect(status(await reindex(body))).toBe(200);
    expect(memoryStore.get("sk").expiresAt).toBe(PAST);
  });

  test("a body that supplies a new validFrom is refused; an omitted one is kept", async () => {
    expect(status(await reindex({ ...skill(), validFrom: FUTURE }))).toBe(409);
    const { validFrom: _drop, ...body } = skill();
    expect(status(await reindex(body))).toBe(200);
    expect(memoryStore.get("sk").validFrom).toBe(FROM);
  });
});

describe("_reindex cannot turn a plain memory into a skill", () => {
  test("a body that adds the skill tag is refused", async () => {
    expect(status(await reindex({ ...plain(), tags: ["skill"], content: "now a skill" }))).toBe(409);
    expect(memoryStore.get("pm")).toEqual(plain());
  });

  for (const [field, value] of [["skillSubjectId", "pm"], ["supersedes", "other"], ["validTo", PAST]] as const) {
    test(`a body that supplies ${field} is refused`, async () => {
      expect(status(await reindex({ ...plain(), [field]: value }))).toBe(409);
      expect(memoryStore.get("pm")).toEqual(plain());
    });
  }

  test("a bookkeeping re-PUT of the plain memory still succeeds", async () => {
    expect(status(await reindex(plain()))).toBe(200);
    expect(memoryStore.get("pm").content).toBe("a note");
  });
});


test("a partial plain-memory reindex retains lineage and lifecycle fields", async () => {
  const protectedFields = { supersedes: "old", validTo: PAST, skillSubjectId: "subject", validFrom: FROM, expiresAt: PAST, archived: true, archivedAt: PAST, archivedBy: "alice" };
  memoryStore.set("pm", { ...plain(), ...protectedFields });
  expect(status(await reindex(plain()))).toBe(200);
  expect(memoryStore.get("pm")).toMatchObject(protectedFields);
});


describe("_reindex declared fields", () => {
  for (const [field, storedValue, changedValue] of [
    ["summary", "original", "changed"],
    ["subject", "original", "changed"],
    ["entities", ["original"], ["changed"]],
    ["parentId", "original", "changed"],
    ["derivedFrom", ["original"], ["changed"]],
    ["source", "original", "changed"],
    ["type", "original", "changed"],
    ["sessionId", "original", "changed"],
    ["lastReflected", PAST, FUTURE],
    ["createdAt", PAST, FUTURE],
    ["_safetyFlags", ["original"], ["changed"]],
  ] as const) {
    test(`declared drift ${field}`, async () => {
      for (const row of [skill, plain]) {
        const stored = { ...row(), [field]: storedValue };
        memoryStore.set(stored.id, stored);
        const result = await reindex({ ...stored, [field]: changedValue });
        expect(status(result)).toBe(409);
        expect(await result.json()).toEqual({
          error: "reindex_would_change_row",
          message: `the _reindex re-PUT may not change '${field}'`,
        });
        expect(memoryStore.get(stored.id)).toEqual(stored);
      }
    });
  }

  test("bookkeeping changes return 200", async () => {
    const bookkeeping = { embedding: [1, 0, 0, 0], embeddingModel: "mock-embedding-model", contentHash: "hash", retrievalCount: 2, lastRetrieved: FUTURE, usageCount: 3 };
    expect(status(await reindex({ ...plain(), ...bookkeeping }))).toBe(200);
    expect(memoryStore.get("pm")).toMatchObject(bookkeeping);
  });
});


test("declared schema defaults to refusal", async () => {
  const bookkeeping = new Set(["embedding", "embeddingModel", "contentHash", "retrievalCount", "lastRetrieved", "usageCount"]);
  for (const field of DECLARED_MEMORY_ATTRIBUTES) {
    if (bookkeeping.has(field)) continue;
    const stored = { ...plain(), [field]: field === "id" ? "pm" : "original" };
    memoryStore.set("pm", stored);
    const resource: any = new (Memory as any)();
    resource.id = "pm";
    resource.getContext = () => undefined;
    const result = await resource.put({ ...stored, [field]: "changed", _reindex: true });
    expect(status(result), field).toBe(field === "id" ? 400 : 409);
    if (field !== "id") expect(await result.json()).toEqual({
      error: "reindex_would_change_row",
      message: `the _reindex re-PUT may not change '${field}'`,
    });
    expect(memoryStore.get("pm"), field).toEqual(stored);
  }
});

test("partial reindex retains omitted declared fields", async () => {
  const stored = { ...plain(), summary: "summary", subject: "subject", entities: ["entity"], derivedFrom: ["source"], _safetyFlags: ["flag"], createdAt: PAST, updatedAt: PAST };
  memoryStore.set("pm", stored);
  expect(status(await reindex({ id: "pm" }))).toBe(200);
  expect(memoryStore.get("pm")).toMatchObject(stored);
  expect(status(await reindex(JSON.parse(JSON.stringify(stored))))).toBe(200);
  expect(memoryStore.get("pm")).toMatchObject(stored);
});


test("anonymous reindex is refused", async () => {
  const resource: any = new (Memory as any)();
  resource.id = "pm";
  resource.getContext = () => ({ request: { headers: new Headers() } });
  const result = await resource.put({ ...plain(), retrievalCount: 2, _reindex: true });
  expect(status(result)).toBe(401);
  expect(memoryStore.get("pm")).toEqual(plain());
});
