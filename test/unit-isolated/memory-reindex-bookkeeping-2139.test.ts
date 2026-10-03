/**
 * flair#2139 S2 — `_reindex` is bookkeeping only. A skill's expiresAt/validFrom
 * cannot be changed or dropped by a re-PUT, and a plain memory cannot be turned
 * into a skill. Isolated: owns the harper mock for Memory.ts.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

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
