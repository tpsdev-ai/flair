/**
 * memory-write-redaction-2407.test.ts — server-side credential redaction on
 * explicit Memory writes (flair#2407).
 *
 * An explicit memory write (MCP `memory_store` / `memory_update`, `flair memory
 * add`, or a direct authenticated POST/PUT/PATCH to Memory) used to be stored
 * verbatim. The server now applies the SAME redactor the automatic-capture path
 * uses (packages/flair-mcp/src/secret-redaction.ts) to the free-text fields of
 * every write, and reports how many values it replaced.
 *
 * This file drives the REAL resources/Memory.ts write paths against a mocked
 * harper (same technique as memory-integrity.test.ts). It owns its harper +
 * embeddings mock in its own process (test/unit-isolated/).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { agentStore, middlewareCapture } from "../helpers/harper-mock.js";
import { createFakeReplayNonceTable } from "../helpers/fake-replay-store.ts";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

const FAKE_EMBEDDING = [1, 0, 0, 0];
// Records the exact text handed to the embedding engine, so a test can pin that
// it is the REDACTED text (flair#2407 seam 1).
let embedInputs: string[] = [];

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async (text: string, _inputType?: string) => {
    embedInputs.push(text);
    return FAKE_EMBEDDING;
  },
  getMode: () => "local",
  getModelId: () => "mock-embedding-model",
  EMBEDDING_ENGINE: "gguf",
}));

function matchesCondition(record: any, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const r = cond.conditions.map((c: any) => matchesCondition(record, c));
    return cond.operator === "or" ? r.some(Boolean) : r.every(Boolean);
  }
  const v = record[cond.attribute];
  if (cond.comparator === "equals") return v === cond.value;
  if (cond.comparator === "not_equal") return v !== cond.value;
  return true;
}

let memoryStore: Map<string, any>;
let memoryGrants: any[];
let idCounter: number;

function memorySearchGen(query: any) {
  let records = Array.from(memoryStore.values());
  const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
  for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
  const limit = typeof query?.limit === "number" ? query.limit : undefined;
  const sliced = limit !== undefined ? records.slice(0, limit) : records;
  async function* gen() {
    for (const r of sliced) yield r;
  }
  return gen();
}

class BaseMemory {
  async post(content: any) {
    const id = content.id ?? `mock-${++idCounter}`;
    content.id = id;
    memoryStore.set(id, { ...content });
    return id;
  }
  getId() {
    return (this as any)._targetId;
  }
  async put(content: any) {
    const id = (this as any)._targetId ?? content.id ?? `mock-${++idCounter}`;
    const rec = { ...content, id };
    memoryStore.set(id, rec);
    return id;
  }
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id ?? (this as any)._targetId;
    return memoryStore.get(id) ?? null;
  }
  async patch(content: any) {
    const id = content?.id ?? (this as any)._targetId;
    const merged = { ...(memoryStore.get(id) ?? {}), ...content };
    memoryStore.set(id, merged);
    return undefined; // real Table.patch returns undefined on the standard path
  }
  search(query: any) {
    return memorySearchGen(query);
  }
  static async get(id: any) {
    return memoryStore.get(id) ?? null;
  }
  static async put(content: any) {
    const rec = { ...content };
    memoryStore.set(content.id, rec);
    return rec;
  }
  static async post(content: any) {
    return new BaseMemory().post(content);
  }
  static async patch(content: any) {
    const id = content?.id;
    memoryStore.set(id, { ...(memoryStore.get(id) ?? {}), ...content });
    return undefined;
  }
  static search(query: any) {
    return memorySearchGen(query);
  }
}

const databasesMock = {
  flair: {
    Memory: BaseMemory,
    MemoryGrant: {
      search: (query: any) => {
        const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
        let grants = memoryGrants.slice();
        for (const cond of conditions) grants = grants.filter((g) => matchesCondition(g, cond));
        async function* gen() {
          for (const g of grants) yield g;
        }
        return gen();
      },
    },
    Agent: {
      get: async (id: string) => agentStore.get(id) ?? null,
      search: async function* () {
        for (const a of agentStore.values()) yield a;
      },
    },
    Instance: {
      search: () => {
        async function* gen() {}
        return gen();
      },
    },
    ReplayNonce: createFakeReplayNonceTable(),
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  server: {
    getUser: async () => null,
    http: (fn: any, _opts?: any) => {
      middlewareCapture.value = fn;
    },
  },
  Resource: class {},
  RequestTarget: class {},
}));

// Harper assigns `transaction` onto the global at load; the Memory write path
// refuses to run a write unwrapped. Same stand-in memory-integrity.test.ts uses.
(globalThis as any).transaction = (ctx: any, cb: (txn: any) => any) => {
  if (ctx?.transaction && ctx.transaction.open === 1) return cb(ctx.transaction);
  const txn: any = {
    open: 1,
    saveCommits: false,
    staged: [] as any[],
    abort() {
      this.open = 0;
      this.staged = [];
    },
    commit() {
      this.open = 0;
      for (const rec of this.staged) memoryStore.set(rec.id, rec);
      this.staged = [];
    },
  };
  const c = ctx && typeof ctx === "object" ? ctx : {};
  c.transaction = txn;
  let r: any;
  try {
    r = cb(txn);
  } catch (e) {
    txn.abort();
    throw e;
  }
  if (r && typeof r.then === "function") {
    return r.then((v: any) => {
      txn.commit();
      return v;
    }, (e: any) => {
      txn.abort();
      throw e;
    });
  }
  txn.commit();
  return r;
};

const { Memory } = await import("../../resources/Memory.ts");
const { FeedMemories } = await import("../../resources/MemoryFeed.ts");
const { computeContentHash } = await import("../../resources/memory-feed-lib.ts");
const { mergeRecord } = await import("../../resources/Federation.ts");
const { reconstructRecordVerifyBody } = await import("../../resources/federation-classify.ts");
const { stripInboundMemoryRow } = await import("../../resources/memory-declared-attributes.ts");

function makeMemory(ctxRequest: any) {
  const r: any = new (Memory as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });

beforeEach(() => {
  memoryStore = new Map();
  memoryGrants = [];
  idCounter = 0;
  embedInputs = [];
  agentStore.clear();
});

// Credential-shaped values the shared redactor recognizes.
const GITHUB_TOKEN = `ghp_${"a".repeat(24)}`;
const AWS_KEY = `AKIA${"B".repeat(16)}`;
const SLACK_TOKEN = `xoxb-${"c".repeat(12)}`;
const REDACTED = "[redacted]";

const AGENT = "agent-a";

describe("flair#2407 — Memory write paths redact credential-shaped text", () => {
  it("memory_store (Memory.post) stores the redacted content and reports the count", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const original = `deploy note: use token ${GITHUB_TOKEN} when calling the CI API`;
    const res: any = await m.post({ agentId: AGENT, content: original });

    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.content).toBe(`deploy note: use token ${REDACTED} when calling the CI API`);
    expect(res.written).toBe(true);
    expect(res.redactedValues).toBe(1);
  });

  it("seam 1: the embedding is computed from the REDACTED text, never the original", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const original = `deploy note: use token ${GITHUB_TOKEN} when calling the CI API`;
    await m.post({ agentId: AGENT, content: original });

    expect(embedInputs.length).toBeGreaterThan(0);
    expect(embedInputs).toContain(`deploy note: use token ${REDACTED} when calling the CI API`);
    expect(embedInputs).not.toContain(original);
  });

  it("memory_update (Memory.put, create) stores the redacted content and reports the count", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const original = `aws credentials for the backup job are ${AWS_KEY} rotate weekly`;
    const res: any = await m.put({ agentId: AGENT, content: original });

    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.content).toBe(`aws credentials for the backup job are ${REDACTED} rotate weekly`);
    expect(res.redactedValues).toBe(1);
  });

  it("Memory.put (update of an existing row) redacts the stored content too", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: AGENT, content: "old", archived: false, createdAt: new Date().toISOString() });
    const m: any = makeMemory(agentCtx(AGENT));
    m._targetId = "mem-1";
    const original = `now uses ${SLACK_TOKEN} for notifications`;
    const res: any = await m.put({ agentId: AGENT, content: original });

    const stored = await (BaseMemory as any).get("mem-1");
    expect(stored.content).toBe(`now uses ${REDACTED} for notifications`);
    expect(res.redactedValues).toBe(1);
  });

  it("Memory.patch redacts the content it merges and reports the count", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: AGENT, content: "old", archived: false, createdAt: new Date().toISOString() });
    const m: any = makeMemory(agentCtx(AGENT));
    m._targetId = "mem-1";
    const original = `rotate: ${GITHUB_TOKEN}`;
    const res: any = await m.patch({ content: original });

    const stored = await (BaseMemory as any).get("mem-1");
    expect(stored.content).toBe(`rotate: ${REDACTED}`);
    expect(res.redactedValues).toBe(1);
  });

  it("counts every redacted value across content and summary", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const res: any = await m.post({
      agentId: AGENT,
      content: `two tokens here: ${GITHUB_TOKEN} and ${AWS_KEY} in one paragraph of prose`,
      summary: `short summary carrying ${SLACK_TOKEN}`,
    });

    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.content).toBe(`two tokens here: ${REDACTED} and ${REDACTED} in one paragraph of prose`);
    expect(stored.summary).toBe(`short summary carrying ${REDACTED}`);
    expect(res.redactedValues).toBe(3);
  });
});

describe("flair#2407 seam 3 — a write with nothing credential-shaped is stored byte-identical", () => {
  it("plain prose is unchanged and the response reports no redaction", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const original = "The release notes for v0.59.0 describe the new memory write path in detail.";
    const res: any = await m.post({ agentId: AGENT, content: original });

    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.content).toBe(original);
    expect(res.redactedValues).toBeUndefined();
  });

  it("a string that merely STARTS like a known prefix is left alone", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const original = "the placeholder ghp_tooshort and sk-abc are not credentials and must survive";
    const res: any = await m.post({ agentId: AGENT, content: original });

    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.content).toBe(original);
    expect(res.redactedValues).toBeUndefined();
  });
});

describe("flair#2407 seam 2 — a federated record is not rewritten by the server-side redactor", () => {
  it("the sync-in apply path stores the originator's content verbatim, so its signature still verifies", async () => {
    const credentialShaped = `synced memory: the peer's token is ${GITHUB_TOKEN} and it must not be rewritten here`;
    const record: any = {
      table: "Memory",
      id: "m-fed",
      data: { id: "m-fed", agentId: AGENT, content: credentialShaped },
      updatedAt: new Date().toISOString(),
      originatorInstanceId: "inst-remote",
    };
    const verifyBodyBefore = reconstructRecordVerifyBody(record, "inst-remote");

    // Mirror resources/Federation.ts's per-record apply: merge → the inbound
    // whitelist → the RAW table handle. No Memory resource writer runs.
    const merged = mergeRecord(null, record);
    stripInboundMemoryRow(merged);
    await (databasesMock.flair.Memory as any).put(merged);

    const stored = await (BaseMemory as any).get("m-fed");
    expect(stored.content).toBe(credentialShaped); // NOT redacted — it was redacted at its origin
    expect(reconstructRecordVerifyBody({ ...record, data: stored }, "inst-remote")).toEqual(verifyBodyBefore);
  });
});

const FEED_REDACTED = "[redacted]";
describe("flair#2407 — the feed-ingest route (POST /FeedMemories) redacts too", () => {
  it("stores the redacted content, hashes the redacted text, and reports the count", async () => {
    const f: any = new (FeedMemories as any)();
    f.getContext = () => ({ request: agentCtx(AGENT) });
    const original = `feed memory carrying ${GITHUB_TOKEN} inside its body`;
    const redacted = `feed memory carrying ${FEED_REDACTED} inside its body`;
    const res: any = await f.post({ agentId: AGENT, content: original, durability: "permanent" });

    expect(res.redactedValues).toBe(1);
    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.content).toBe(redacted);
    // seam 1 for the feed: the stored content hash is the REDACTED text's hash.
    expect(stored.contentHash).toBe(computeContentHash(AGENT, redacted));
    expect(stored.contentHash).not.toBe(computeContentHash(AGENT, original));
  });
});

const OPERATOR_CTX = { tpsAgent: "admin", tpsAgentIsAdmin: true };
describe("flair#2407 — an operator/admin write is not agent-authored and stays byte-faithful", () => {
  it("stores prose the agent path would redact verbatim, with no count", async () => {
    // This text trips the redactor (the `Basic ` scheme word). The operator's
    // shipped-skill seed holds the same shape and is verified by comparing the
    // stored text to the source, so it must round-trip unchanged.
    const m = makeMemory(OPERATOR_CTX);
    const original = "A Basic administrator need not have an Agent row, and an Agent record is not a reachability promise.";
    const res: any = await m.post({ agentId: "admin", content: original });

    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.content).toBe(original);
    expect(res.redactedValues).toBeUndefined();
  });
});
