/**
 * Soul content refusals after the vendor-tag bridge was removed (flair#1540).
 *
 * The bridge refused a request carrying an `adk:` scope tag and a value that
 * exactly matched an `adk:`-tagged MemoryCandidate claim or Memory content row
 * for the target agent. The generic checks refuse those cases and more: a
 * request that supplies any non-empty `scopeTag` or `tags` array, a value that
 * exactly matches any MemoryCandidate claim or Memory content for the target
 * agent (no tag required), and a PATCH of a stored row that carries either
 * scope field.
 * Isolated so the harper mock does not collide with the other Soul suites.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

let soulStore: Map<string, any>;
let candidateStore: any[];
let memoryStore: Map<string, any>;
let agentStore: Map<string, any>;
let versionStore: Map<string, any>;
let eventStore: Map<string, any>;
let failTable: string | null = null;
let missingTable: string | null = null;
let getBehavior: "ok" | "throw" | "empty" = "ok";

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
  // Real Harper binds the resource to the URL target (`getId()`); this double
  // models the bound id on the instance as `.id` (the same shape the other
  // Soul/Memory/Agent doubles use). resources/originator-instance.ts's
  // resolveStoredRow reads the stored row by this id.
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
    if (getBehavior === "throw") throw new Error("unavailable");
    if (getBehavior === "empty") return null;
    const id = typeof target === "string" ? target : target?.id ?? (this as any).id;
    return soulStore.get(id) ?? null;
  }
}

// flair#2139 3b: the instruction-version writer appends one OrgEvent row in the
// same transaction; the write aborts when the table is missing (D2).
const OrgEventBase = {
  async *search() {},
  async create(record: any) {
    if (eventStore.has(record.id)) throw new Error("Record already exists");
    eventStore.set(record.id, { ...record });
  },
};

function search(table: string, rows: Iterable<any>) {
  return {
    async *[Symbol.asyncIterator]() {
      if (failTable === table) throw new Error("provenance unavailable");
      for (const row of rows) yield row;
    },
  };
}

const candidateTable = { search: () => search("MemoryCandidate", candidateStore) };
const memoryTable = {
  search: () => search("Memory", memoryStore.values()),
  get: async (id: string) => memoryStore.get(id) ?? null,
  put: async (record: any) => { memoryStore.set(record.id, { ...record }); return record; },
};
const agentTable = {
  get: async (id: string) => agentStore.get(id) ?? null,
  put: async (record: any) => { agentStore.set(record.id, { ...record }); return record; },
};

const flairTables: any = {
  Soul: BaseSoul,
  Memory: memoryTable,
  Agent: agentTable,
  Instance: { search: () => search("Instance", []) },
  InstructionVersion: InstructionVersionBase,
  OrgEvent: OrgEventBase,
};
Object.defineProperty(flairTables, "MemoryCandidate", {
  configurable: true,
  get: () => (missingTable === "MemoryCandidate" ? undefined : candidateTable),
});
Object.defineProperty(flairTables, "Memory", {
  configurable: true,
  get: () => (missingTable === "Memory" ? undefined : memoryTable),
});

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  Resource: class {},
  databases: { flair: flairTables },
}));

const { Soul } = await import("../../resources/Soul.ts");
const { AgentSeed } = await import("../../resources/AgentSeed.ts");
const { soulWriteSource } = await import("../../resources/soul-write-policy.ts");
const { SOUL_SCOPE_FIELDS_REFUSAL } = await import("../../src/lib/soul-scope-fields.ts");
const LEARNED_SOUL_REFUSAL = "soul_value_is_learned_content";

const OPERATOR = () => ({ request: { tpsAgent: "shared-app", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic verified-by-middleware" }) } });
const INTERNAL = () => ({ request: {}, __flairInternal: true });
type Source = "operator" | "internal";

function contextFor(source: Source) {
  return source === "operator" ? OPERATOR() : INTERNAL();
}

function makeSoul(source: Source, id?: string) {
  const r: any = new (Soul as any)();
  if (id) r.id = id;
  r.getContext = () => contextFor(source);
  return r;
}

function makeSeed(source: Source) {
  const r: any = new (AgentSeed as any)();
  r.getContext = () => contextFor(source);
  return r;
}

const ROW_ID = "shared-app:pref";
const STORED = { id: ROW_ID, agentId: "shared-app", key: "pref", value: "Be concise." };

beforeEach(() => {
  soulStore = new Map();
  versionStore = new Map();
  eventStore = new Map();
  candidateStore = [];
  memoryStore = new Map();
  agentStore = new Map();
  getBehavior = "ok";
  failTable = null;
  missingTable = null;
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

describe("a Soul request that supplies scope fields is refused by name", () => {
  const SCOPE_BODIES = [
    ["an adk scopeTag", { scopeTag: "adk:app:alice" }],
    ["an adk tags entry", { tags: ["ADK:app:alice"] }],
  ] as const;

  for (const source of ["operator", "internal"] as const) {
    for (const method of ["post", "put", "patch"] as const) {
      for (const [label, scope] of SCOPE_BODIES) {
        test(`${source} ${method.toUpperCase()} carrying ${label} is 403 soul_scope_fields_not_writable and writes nothing`, async () => {
          soulStore.set(ROW_ID, { ...STORED });
          const body = method === "patch"
            ? { value: "replacement", ...scope }
            : { id: ROW_ID, agentId: "shared-app", key: "pref", value: "replacement", ...scope };
          const res: any = await makeSoul(source, ROW_ID)[method](body);
          expect(res instanceof Response).toBe(true);
          expect(res.status).toBe(403);
          expect(await res.json()).toEqual({ error: SOUL_SCOPE_FIELDS_REFUSAL });
          expect(soulStore.get(ROW_ID)).toEqual(STORED);
          expect(versionStore.size).toBe(0);
        });
      }
    }
  }
});

describe("a PATCH of a stored row that carries scope fields is refused by the merged row", () => {
  const STORED_SCOPES = [
    ["an adk tags entry", { tags: ["adk:app:alice"] }],
    ["a non-adk tags entry", { tags: ["team-alpha"] }],
    ["an adk scopeTag", { scopeTag: "adk:app:alice" }],
  ] as const;

  for (const source of ["operator", "internal"] as const) {
    for (const [label, scope] of STORED_SCOPES) {
      test(`${source} PATCH of a stored row carrying ${label} is 403 soul_scope_fields_not_writable and writes nothing`, async () => {
        const stored = { ...STORED, ...scope };
        soulStore.set(ROW_ID, stored);
        const res: any = await makeSoul(source, ROW_ID).patch({ value: "replacement" });
        expect(res instanceof Response).toBe(true);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: SOUL_SCOPE_FIELDS_REFUSAL });
        expect(soulStore.get(ROW_ID)).toEqual(stored);
        expect(versionStore.size).toBe(0);
      });
    }
  }

  test("an untagged stored row still patches", async () => {
    soulStore.set(ROW_ID, { ...STORED });
    const res: any = await makeSoul("operator", ROW_ID).patch({ value: "replacement" });
    expect(res).not.toBeInstanceOf(Response);
    expect(soulStore.get(ROW_ID).value).toBe("replacement");
  });
});

describe("stored ADK-tagged content is refused by the generic learned-content check", () => {
  const TABLES = [
    ["MemoryCandidate", "claim"],
    ["Memory", "content"],
  ] as const;

  for (const source of ["operator", "internal"] as const) {
    for (const [table, field] of TABLES) {
      for (const method of ["post", "put", "patch"] as const) {
        test(`${source} ${method.toUpperCase()} of a value stored in ${table} with an adk: tag is 403 soul_value_is_learned_content and writes nothing`, async () => {
          const value = `learned ${source} ${method} ${table}`;
          if (table === "MemoryCandidate") {
            candidateStore.push({ id: "cand", agentId: "shared-app", [field]: value, scopeTag: "adk:app:alice" });
          } else {
            memoryStore.set("mem", { id: "mem", agentId: "shared-app", [field]: value, tags: ["adk:app:alice"] });
          }
          soulStore.set(ROW_ID, { ...STORED });
          const body = method === "patch"
            ? { value }
            : { id: ROW_ID, agentId: "shared-app", key: "pref", value };
          const res: any = await makeSoul(source, ROW_ID)[method](body);
          expect(res instanceof Response).toBe(true);
          expect(res.status).toBe(403);
          expect(await res.json()).toEqual({ error: LEARNED_SOUL_REFUSAL });
          expect(soulStore.get(ROW_ID)).toEqual(STORED);
          expect(versionStore.size).toBe(0);
        });
      }
    }
  }
});

describe("AgentSeed refuses stored learned content before writing", () => {
  const TABLES = [
    ["MemoryCandidate", "claim"],
    ["Memory", "content"],
  ] as const;

  for (const source of ["operator", "internal"] as const) {
    for (const [table, field] of TABLES) {
      test(`${source} seed with a soulTemplate value stored in ${table} is 403 soul_value_is_learned_content and writes nothing`, async () => {
        const value = `seed learned ${source} ${table}`;
        if (table === "MemoryCandidate") {
          candidateStore.push({ id: "cand", agentId: "seed-app", [field]: value, scopeTag: "adk:app:alice" });
        } else {
          memoryStore.set("mem", { id: "mem", agentId: "seed-app", [field]: value, tags: ["adk:app:alice"] });
        }
        const res: any = await makeSeed(source).post({ agentId: "seed-app", soulTemplate: { role: value } });
        expect(res instanceof Response).toBe(true);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: LEARNED_SOUL_REFUSAL });
        expect(agentStore.has("seed-app")).toBe(false);
        expect([...soulStore.keys()].some((key) => key.startsWith("seed-app:"))).toBe(false);
        expect([...memoryStore.values()].some((row) => row.source === "seed")).toBe(false);
      });
    }
  }

  test("an ordinary soulTemplate still seeds", async () => {
    const res: any = await makeSeed("operator").post({ agentId: "plain-seed", soulTemplate: { role: "Operator-authored role" } });
    expect(res instanceof Response).toBe(false);
    expect(agentStore.get("plain-seed")).toBeTruthy();
    expect(soulStore.get("plain-seed:role").value).toBe("Operator-authored role");
  });
});

describe("unavailable provenance refuses without writing", () => {
  const TABLES = ["MemoryCandidate", "Memory"] as const;

  for (const table of TABLES) {
    for (const mode of ["failed-read", "missing-table"] as const) {
      test(`a ${mode} of ${table} aborts post, put and patch and writes nothing`, async () => {
        for (const method of ["post", "put", "patch"] as const) {
          soulStore.set(ROW_ID, { ...STORED });
          if (mode === "failed-read") failTable = table;
          else missingTable = table;
          const body = method === "patch"
            ? { value: "replacement" }
            : { id: ROW_ID, agentId: "shared-app", key: "pref", value: "replacement" };
          const write = makeSoul("operator", ROW_ID)[method](body);
          if (method === "patch") {
            const res: any = await write;
            expect(res.status).toBe(500);
          } else {
            await expect(write).rejects.toThrow();
          }
          expect(soulStore.get(ROW_ID)).toEqual(STORED);
        }
      });
    }
  }
});

describe("soulWriteSource is Flair-derived from the credential", () => {
  const adminAgent = { kind: "agent" as const, agentId: "admin", isAdmin: true };
  const runtimeAgent = { kind: "agent" as const, agentId: "bot", isAdmin: false };
  const headers = (authorization: string) => new Headers({ authorization });

  test("verified Harper administrator Basic is operator; everything else is refused", () => {
    expect(soulWriteSource({ request: { headers: headers("Basic abc") } }, adminAgent)).toBe("operator");
    expect(soulWriteSource({ __flairInternal: true }, { kind: "internal" })).toBe("internal");
    expect(soulWriteSource({ request: { headers: headers("TPS-Ed25519 key") } }, adminAgent)).toBeNull();
    expect(soulWriteSource({ request: { headers: headers("Bearer token") } }, adminAgent)).toBeNull();
    expect(soulWriteSource({ request: { headers: headers("Basic abc") } }, runtimeAgent)).toBeNull();
    expect(soulWriteSource({ request: { headers: headers("Basic abc"), sourceClass: "operator" } }, runtimeAgent)).toBeNull();
    expect(soulWriteSource({}, { kind: "internal" })).toBeNull();
    expect(soulWriteSource({ request: { tpsAnonymous: true } }, { kind: "anonymous" })).toBeNull();
  });
});

describe("Soul source allowlist", () => {
  test("every mutation denies agent, admin-agent, delegated, unknown and anonymous contexts", async () => {
    const contexts = [
      { request: { tpsAgent: "shared-app", tpsAgentIsAdmin: false } },
      { request: { tpsAgent: "shared-app", tpsAgentIsAdmin: true } },
      { request: { tpsAgent: "shared-app", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Bearer delegated" }) } },
      { request: { tpsAgent: "shared-app", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "TPS-Ed25519 agent-key" }) } },
      { request: { tpsAgent: "shared-app", sourceClass: "operator", __flairInternal: true } },
      {},
      { request: { tpsAnonymous: true } },
    ];
    for (const context of contexts) {
      for (const method of ["post", "put", "patch", "delete"]) {
        const original = { id: "soul", agentId: "shared-app", value: "original" };
        soulStore.set("soul", original);
        const soul = makeSoul("operator", "soul");
        soul.getContext = () => context;
        const result = await soul[method](method === "delete" ? "soul" : {
          id: "soul", agentId: "shared-app", value: "forged", sourceClass: "operator", __flairInternal: true,
          provenance: JSON.stringify({ verified: { sourceClass: "operator" } }),
        });
        expect([401, 403]).toContain(result.status);
        expect(soulStore.get("soul")).toEqual(original);
      }
    }
  });

  test("operator and deliberate internal writes stamp their actual source, including PATCH", async () => {
    for (const source of ["operator", "internal"]) {
      for (const method of ["post", "put", "patch"]) {
        soulStore.set("soul", { id: "soul", agentId: "shared-app", value: "old" });
        const soul = makeSoul(source as Source, "soul");
        const result = await soul[method]({ id: "soul", agentId: "shared-app", value: "authored", provenance: "forged" });
        expect(result).not.toBeInstanceOf(Response);
        const stamp = JSON.parse(soulStore.get("soul").provenance);
        expect(stamp.verified.sourceClass).toBe(source);
        expect(stamp.verified.agentId).toBe(source === "operator" ? "shared-app" : null);
        await soul.delete("soul");
        expect(soulStore.has("soul")).toBe(false);
      }
    }
  });

  test("untagged learned content for the target owner is refused even with claimed operator provenance", async () => {
    for (const rows of [candidateStore, memoryStore]) {
      const add = (row: any) => {
        if (Array.isArray(rows)) rows.push(row);
        else rows.set("row", row);
      };
      add({ agentId: "shared-app", claim: "learned", content: "learned", provenance: '{"verified":{"sourceClass":"operator"}}' });
      for (const method of ["post", "put", "patch"]) {
        soulStore.set("soul", { id: "soul", agentId: "shared-app", value: "original" });
        const result = await makeSoul("operator", "soul")[method]({ id: "soul", agentId: "shared-app", value: "learned" });
        expect(result.status).toBe(403);
        expect(await result.json()).toEqual({ error: LEARNED_SOUL_REFUSAL });
        expect(soulStore.get("soul").value).toBe("original");
      }
      if (Array.isArray(rows)) rows.length = 0;
      else rows.clear();
    }
  });
});

test("failed learned-content lookup aborts all content writes", async () => {
  failTable = "MemoryCandidate";
  for (const method of ["post", "put", "patch"]) {
    soulStore.set("soul", { id: "soul", agentId: "shared-app", value: "original" });
    const write = makeSoul("operator", "soul")[method]({ id: "soul", agentId: "shared-app", value: "replacement" });
    if (method === "patch") expect((await write).status).toBe(500);
    else await expect(write).rejects.toThrow("provenance unavailable");
    expect(soulStore.get("soul").value).toBe("original");
  }
});

test("another agent cannot poison an operator edit by copying its text", async () => {
  memoryStore.set("other", { agentId: "other-agent", content: "Operator-authored role" });
  const result = await makeSoul("operator").put({ id: "soul", agentId: "shared-app", value: "Operator-authored role" });
  expect(result).not.toBeInstanceOf(Response);
  expect(soulStore.get("soul").value).toBe("Operator-authored role");
});
