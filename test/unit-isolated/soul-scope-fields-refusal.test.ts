/**
 * A Soul write that would store a non-empty `scopeTag` or a non-empty `tags`
 * array is refused with `soul_scope_fields_not_writable` when earlier guards
 * permit the request, whatever the tag's prefix and from either write source,
 * with nothing written. POST and PUT check the request body; PATCH checks the
 * merged row. Soul has no dedicated or enforced per-user scope field. Isolated
 * so the harper mock does not collide with the other Soul suites.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

let soulStore: Map<string, any>;
let candidateStore: any[];
let memoryStore: any[];
let versionStore: Map<string, any>;
let eventStore: Map<string, any>;

const versionPrimaryStore = { tryLock: () => true, unlock: () => {}, resetReadTxn: () => {} };
const InstructionVersionBase = {
  primaryStore: versionPrimaryStore,
  async *search(query: any) {
    const conditions: any[] = query?.conditions ?? [];
    const rows = [...versionStore.values()].filter((row) => conditions.every((c) => row[c.attribute] === c.value));
    rows.sort((a, b) => Number(b.version) - Number(a.version));
    for (const row of rows.slice(0, query?.limit ?? rows.length)) yield row;
  },
  async create(record: any) {
    if (versionStore.has(record.id)) throw new Error("Record already exists");
    versionStore.set(record.id, { ...record });
  },
};

class BaseSoul {
  static async get(id: string) { return new BaseSoul().get(id); }
  static async put(content: any, ctx: any) {
    ctx.transaction.soulWrites.push(() => soulStore.set(content.id, { ...content }));
  }
  getId() { return (this as any).id; }
  async delete(id: string) { soulStore.delete(id); }
  async post(content: any) {
    soulStore.set(content.id ?? "soul", { ...content });
    return content;
  }
  async put(content: any) {
    soulStore.set(content.id, { ...content });
    return content;
  }
  async patch(content: any) {
    const id = (this as any).id;
    const rec = { ...(soulStore.get(id) ?? {}), ...content };
    soulStore.set(id, rec);
    return rec;
  }
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id ?? (this as any).id;
    return soulStore.get(id) ?? null;
  }
}

const OrgEventBase = {
  async *search() {},
  async create(record: any) {
    if (eventStore.has(record.id)) throw new Error("Record already exists");
    eventStore.set(record.id, { ...record });
  },
};

function search(rows: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const row of rows) yield row;
    },
  };
}

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  Resource: class {},
  databases: {
    flair: {
      Soul: BaseSoul,
      MemoryCandidate: { search: () => search(candidateStore) },
      Memory: { search: () => search(memoryStore) },
      Instance: { search: () => search([]) },
      InstructionVersion: InstructionVersionBase,
      OrgEvent: OrgEventBase,
    },
  },
}));

const { Soul } = await import("../../resources/Soul.ts");
const { SOUL_SCOPE_FIELDS_REFUSAL } = await import("../../src/lib/soul-scope-fields.ts");

const OPERATOR = () => ({ request: { tpsAgent: "app-a", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic verified-by-middleware" }) } });
const INTERNAL = () => ({ request: {}, __flairInternal: true });

function makeSoul(source: "operator" | "internal", id?: string) {
  const r: any = new (Soul as any)();
  if (id) r.id = id;
  r.getContext = () => (source === "operator" ? OPERATOR() : INTERNAL());
  return r;
}

const ROW_ID = "app-a:role";
const STORED = { id: ROW_ID, agentId: "app-a", key: "role", value: "Be concise." };

beforeEach(() => {
  soulStore = new Map();
  versionStore = new Map();
  eventStore = new Map();
  candidateStore = [];
  memoryStore = [];
  (globalThis as any).transaction = (ctx: any, cb: (txn: any) => any) => {
    const context = ctx && typeof ctx === "object" ? ctx : {};
    if (context.transaction && context.transaction.open === 1) return cb(context.transaction);
    const txn: any = { open: 1, saveCommits: false, soulWrites: [] };
    context.transaction = txn;
    let result: any;
    try { result = cb(txn); } catch (e) { txn.open = 0; throw e; }
    if (result && typeof result.then === "function") {
      return result.then((v: any) => { txn.open = 0; for (const write of txn.soulWrites) write(); return v; }, (e: any) => { txn.open = 0; throw e; });
    }
    txn.open = 0;
    return result;
  };
});

const SCOPE_BODIES = [
  ["a non-adk scopeTag", { scopeTag: "team:alpha" }],
  ["a non-adk tags entry", { tags: ["team-alpha"] }],
] as const;

describe("a Soul write that supplies a non-empty scopeTag or tags array is refused by name", () => {
  for (const source of ["operator", "internal"] as const) {
    for (const method of ["post", "put", "patch"] as const) {
      for (const [label, scope] of SCOPE_BODIES) {
        test(`${source} ${method.toUpperCase()} carrying ${label} is 403 and writes nothing`, async () => {
          soulStore.set(ROW_ID, { ...STORED });
          const soul = makeSoul(source, ROW_ID);
          const body = method === "patch"
            ? { value: "replacement", ...scope }
            : { id: ROW_ID, agentId: "app-a", key: "role", value: "replacement", ...scope };
          const res = await soul[method](body);
          expect(res instanceof Response).toBe(true);
          expect((res as Response).status).toBe(403);
          expect(await (res as Response).json()).toEqual({ error: SOUL_SCOPE_FIELDS_REFUSAL });
          expect(soulStore.get(ROW_ID)).toEqual(STORED);
          expect(versionStore.size).toBe(0);
        });
      }
    }
  }
});

describe("the refusal reads the row this write would store", () => {
  test("a refused POST creates no row", async () => {
    const res: any = await makeSoul("operator").post({ agentId: "app-a", key: "role", value: "fresh", scopeTag: "team:alpha" });
    expect(res.status).toBe(403);
    expect(soulStore.size).toBe(0);
    expect(versionStore.size).toBe(0);
  });
  test("a PATCH of a stored row that carries a non-empty tags array is refused even when the patch sets neither field", async () => {
    soulStore.set(ROW_ID, { ...STORED, tags: ["team-alpha"], scopeTag: "team:alpha" });
    const res: any = await makeSoul("operator", ROW_ID).patch({ value: "replacement" });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SOUL_SCOPE_FIELDS_REFUSAL });
    expect(soulStore.get(ROW_ID)).toEqual({ ...STORED, tags: ["team-alpha"], scopeTag: "team:alpha" });
  });

  test("a PATCH that sets tags is refused even when the stored row carries none", async () => {
    soulStore.set(ROW_ID, { ...STORED });
    const res: any = await makeSoul("operator", ROW_ID).patch({ tags: ["team-alpha"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SOUL_SCOPE_FIELDS_REFUSAL });
    expect(soulStore.get(ROW_ID)).toEqual(STORED);
  });
});

describe("ordinary authored writes are unaffected", () => {
  for (const source of ["operator", "internal"] as const) {
    for (const method of ["post", "put", "patch"] as const) {
      test(`${source} ${method.toUpperCase()} of an ordinary Soul body still lands`, async () => {
        soulStore.set(ROW_ID, { ...STORED });
        const soul = makeSoul(source, ROW_ID);
        const body = method === "patch"
          ? { value: "Be the team's memory." }
          : { id: ROW_ID, agentId: "app-a", key: "role", value: "Be the team's memory." };
        const res: any = await soul[method](body);
        expect(res).not.toBeInstanceOf(Response);
        expect(soulStore.get(ROW_ID).value).toBe("Be the team's memory.");
      });

      test(`${source} ${method.toUpperCase()} with empty tags and no scopeTag is allowed`, async () => {
        soulStore.set(ROW_ID, { ...STORED });
        const soul = makeSoul(source, ROW_ID);
        const body = method === "patch"
          ? { value: "Be the team's memory.", tags: [] }
          : { id: ROW_ID, agentId: "app-a", key: "role", value: "Be the team's memory.", tags: [] };
        const res: any = await soul[method](body);
        expect(res).not.toBeInstanceOf(Response);
        expect(soulStore.get(ROW_ID).value).toBe("Be the team's memory.");
      });
    }
  }
});
