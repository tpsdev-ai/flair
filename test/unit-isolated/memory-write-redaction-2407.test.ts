/**
 * memory-write-redaction-2407.test.ts — server-side credential redaction on
 * Memory writes (flair#2407).
 *
 * Calls resources/Memory.ts post/put/patch and resources/MemoryFeed.ts post
 * directly against a mocked harper (same technique as
 * memory-integrity.test.ts), with the credential shapes the shared redactor
 * recognizes (packages/flair-mcp/src/secret-redaction.ts) in `content` and
 * `summary`. The real-Harper counterpart is
 * test/integration/memory-write-redaction-2407.test.ts. This file owns its
 * harper + embeddings mock in its own process (test/unit-isolated/).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { agentStore, middlewareCapture } from "../helpers/harper-mock.js";
import { createFakeReplayNonceTable } from "../helpers/fake-replay-store.ts";
import { memoryLockDouble } from "../helpers/memory-lock-double";

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
  /** flair#2478: Memory PUT/PATCH refuse a store with no per-id lock; this
   *  double injects one (test/helpers/memory-lock-double.ts). */
  static primaryStore = memoryLockDouble();
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
  static async put(content: any, ctx?: any) {
    content.id ??= `mock-${++idCounter}`;
    const rec = { ...content };
    // A put made through a transaction's context is staged and applied when
    // that transaction commits (see the `transaction` stand-in below), so a
    // read outside the transaction does not see it before then.
    const staged = ctx?.transaction?.open === 1 ? ctx.transaction.staged : undefined;
    if (Array.isArray(staged)) staged.push(rec);
    else memoryStore.set(content.id, rec);
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
const { isOperatorSeedPut, redactMemoryWrite, redactSkillWrite, storedMemoryText, suppliedMemoryTextFields, suppliedSkillTextFields, suppliedStoredTextFields } = await import("../../resources/memory-redaction.ts");
const { WRITE_RESPONSE_WITHHELD, WRITE_RESPONSE_WITHHELD_MESSAGE, buildFromAllowlist, feedResponseFields, REDACTION_RULES, storageResult, suppliedMemoryFields, writeResultResponse } = await import("../../resources/memory-write-response.ts");
const { SEED_SKILL_ROW_ID } = await import("../../resources/seed-ids.ts");
const { redactSecrets, redactSecretsWithCount } = await import("../../packages/flair-mcp/src/secret-redaction.ts");

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
  it("Memory.post stores the redacted content and reports the count", async () => {
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

  it("Memory.put (create) stores the redacted content and reports the count", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const original = `aws credentials for the backup job are ${AWS_KEY} rotate weekly`;
    // A PUT names its id (flair#2478: an idless PUT is refused 400 memory_id_required).
    const res: any = await m.put({ id: "mem-put-create-redacted", agentId: AGENT, content: original });

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

const BASIC_PROSE = "A Basic administrator need not have an Agent row, and an Agent record is not a reachability promise.";
describe("flair#2407 — the redaction exemption", () => {
  it("an admin agent key (Ed25519, admin role) is redacted", async () => {
    const m = makeMemory({ ...agentCtx("admin-agent", true), headers: new Headers({ authorization: "TPS-Ed25519 admin-agent:1:n:s" }) });
    const res: any = await m.post({ agentId: "admin-agent", content: BASIC_PROSE });

    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.content).toBe(redactSecrets(BASIC_PROSE));
    expect(stored.content).not.toBe(BASIC_PROSE);
    expect(res.redactedValues).toBe(1);
  });

  it("isOperatorSeedPut: true for a Basic administrator naming the reserved seed id; false for other ids or credentials", () => {
    const basic = { request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic ok" }) } };
    const ed25519 = { request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "TPS-Ed25519 a:1:n:s" }) } };
    const oauth = { request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Bearer t" }) } };
    const admin = { kind: "agent" as const, agentId: "admin", isAdmin: true };
    expect(isOperatorSeedPut(basic, admin, [SEED_SKILL_ROW_ID, SEED_SKILL_ROW_ID])).toBe(true);
    expect(isOperatorSeedPut(basic, admin, [SEED_SKILL_ROW_ID, undefined])).toBe(true);
    expect(isOperatorSeedPut(basic, admin, ["other-id"])).toBe(false);
    expect(isOperatorSeedPut(basic, admin, [SEED_SKILL_ROW_ID, "other-id"])).toBe(false);
    expect(isOperatorSeedPut(basic, admin, [undefined, null])).toBe(false);
    expect(isOperatorSeedPut(ed25519, admin, [SEED_SKILL_ROW_ID])).toBe(false);
    expect(isOperatorSeedPut(oauth, admin, [SEED_SKILL_ROW_ID])).toBe(false);
    expect(isOperatorSeedPut({ __flairInternal: true }, { kind: "internal" }, [SEED_SKILL_ROW_ID])).toBe(false);
  });
});

describe("flair#2407 — the count covers only values the redactor changed", () => {
  it("an already-redacted value is unchanged and counts 0", () => {
    expect(redactSecretsWithCount("API_KEY=[redacted]")).toEqual({ text: "API_KEY=[redacted]", count: 0 });
    const body: any = { content: "API_KEY=[redacted] and Authorization: [redacted]" };
    expect(redactMemoryWrite(body)).toEqual({ count: 0, embeddingDiscarded: false });
    expect(body.content).toBe("API_KEY=[redacted] and Authorization: [redacted]");
  });

  it("Memory.post counts only the values it changed", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const unchanged: any = await m.post({ agentId: AGENT, content: "the CI job reads API_KEY=[redacted] from its environment" });
    expect(unchanged.redactedValues).toBeUndefined();
    const mixed: any = await m.post({ agentId: AGENT, content: `the CI job reads API_KEY=[redacted] and ${GITHUB_TOKEN} from its environment` });
    expect(mixed.redactedValues).toBe(1);
    expect((await (BaseMemory as any).get(mixed.id)).content).toBe(`the CI job reads API_KEY=[redacted] and ${REDACTED} from its environment`);
  });
});

describe("flair#2575 — skill fields with distinct top-level metadata keys", () => {
  it("redactSkillWrite redacts the metadata name/description and every tags entry", () => {
    const body: any = {
      tags: ["skill", `release-${GITHUB_TOKEN}`, "ops"],
      metadata: JSON.stringify({ name: `deploy ${GITHUB_TOKEN}`, description: `runs the nightly ${AWS_KEY}`, source: "npm:example" }),
    };
    expect(redactSkillWrite(body)).toBe(3);
    expect(body.tags).toEqual(["skill", `release-${REDACTED}`, "ops"]);
    const meta = JSON.parse(body.metadata);
    expect(meta.name).toBe(`deploy ${REDACTED}`);
    expect(meta.description).toBe(`runs the nightly ${REDACTED}`);
    expect(meta.source).toBe("npm:example");
  });

  it("redactSkillWrite leaves a non-skill row's tags and metadata alone", () => {
    const body: any = { content: "plain", tags: [`release-${GITHUB_TOKEN}`], metadata: JSON.stringify({ name: `deploy ${GITHUB_TOKEN}` }) };
    expect(redactSkillWrite(body)).toBe(0);
    expect(body.tags).toEqual([`release-${GITHUB_TOKEN}`]);
    expect(JSON.parse(body.metadata).name).toBe(`deploy ${GITHUB_TOKEN}`);
  });

  it("redactSkillWrite redacts a skill row's string tag entries and keeps a null entry", () => {
    const body: any = { tags: ["skill", null, `release-${GITHUB_TOKEN}`] };
    expect(redactSkillWrite(body)).toBe(1);
    expect(body.tags).toEqual(["skill", null, `release-${REDACTED}`]);
  });

  it("storedMemoryText reports the redacted skill fields of a staged skill row, including a null tag", () => {
    const body: any = { tags: ["skill", null, `release-${GITHUB_TOKEN}`], metadata: JSON.stringify({ name: `deploy ${GITHUB_TOKEN}` }), content: "procedure", trigger: "when deploying" };
    // flair#2561: the supplied fields are read from the body as the request sent it.
    const supplied = suppliedStoredTextFields(body);
    redactSkillWrite(body);
    const stored = storedMemoryText(body, supplied);
    expect(stored).toEqual({
      content: "procedure",
      trigger: "when deploying",
      name: `deploy ${REDACTED}`,
      tags: ["skill", null, `release-${REDACTED}`],
    });
  });

  it("suppliedSkillTextFields names the metadata name/description and the tags the request body carries", () => {
    expect(suppliedSkillTextFields({ tags: ["skill"], metadata: JSON.stringify({ name: "n", description: "d", source: "s" }) })).toEqual(["name", "description", "tags"]);
    expect(suppliedSkillTextFields({ metadata: { name: "n", description: 4 } })).toEqual(["name"]);
    expect(suppliedSkillTextFields({ metadata: "not json", tags: null })).toEqual([]);
    expect(suppliedSkillTextFields({ content: "c", summary: "s" })).toEqual([]);
    expect(suppliedSkillTextFields(null)).toEqual([]);
    expect(suppliedStoredTextFields({ content: "c", trigger: 4, tags: ["skill"], metadata: JSON.stringify({ description: "d" }) }))
      .toEqual(["content", "description", "tags"]);
  });

  it("storedMemoryText reports, of a skill row's skill fields, only those the request supplied (flair#2561)", () => {
    // The staged row inherited its tags and metadata from a predecessor; the
    // request supplied only `summary`.
    const row: any = {
      content: "inherited procedure", summary: `rotated ${REDACTED}`, trigger: "inherited trigger",
      tags: ["skill", `release-${REDACTED}`],
      metadata: JSON.stringify({ name: `deploy ${REDACTED}`, description: "inherited description" }),
    };
    expect(storedMemoryText(row, suppliedStoredTextFields({ summary: `rotated ${GITHUB_TOKEN}` }))).toEqual({ summary: `rotated ${REDACTED}` });
    // The request supplied `metadata` with a name but no description, and `tags`.
    const supplied = suppliedStoredTextFields({ summary: "s", tags: ["skill"], metadata: JSON.stringify({ name: "deploy" }) });
    expect(storedMemoryText(row, supplied)).toEqual({ summary: `rotated ${REDACTED}`, name: `deploy ${REDACTED}`, tags: ["skill", `release-${REDACTED}`] });
    // A row that is not skill-tagged reports no skill field, supplied or not.
    expect(storedMemoryText({ content: "c", tags: ["note"], metadata: JSON.stringify({ name: "n" }) }, ["content", "name", "tags"])).toEqual({ content: "c" });
  });

  it("the write-response allowlist copies the supplied skill fields of `stored` by name and type", () => {
    const rules = { id: { type: "string", required: true }, ...REDACTION_RULES } as const;
    const tags = ["skill", null, `release-${REDACTED}`];
    const stored = { content: "c", name: `deploy ${REDACTED}`, description: "d", tags };
    const result: any = buildFromAllowlist({ id: "r1", redactedValues: 2, stored }, rules);
    expect(result).toEqual({ id: "r1", redactedValues: 2, stored: { content: "c", name: `deploy ${REDACTED}`, description: "d", tags: ["skill", null, `release-${REDACTED}`] } });
    expect(result.stored.tags).not.toBe(tags);
    tags[0] = "changed";
    expect(result.stored.tags[0]).toBe("skill");
    // A `tags` value that is not an array of strings and nulls, or a non-string
    // name/description, is left out.
    for (const bad of [["skill", 4], ["skill", { embedding: [1] }], "skill", { 0: "skill", length: 1 }, null]) {
      expect(buildFromAllowlist({ id: "r1", stored: { content: "c", name: 4, description: { embedding: [1] }, tags: bad } }, rules))
        .toEqual({ id: "r1", stored: { content: "c" } });
    }
  });
});

describe("flair#2407 — a supplied embedding is replaced when redaction changes its source text", () => {
  const SUPPLIED = [0, 0, 0, 1];
  it("Memory.post discards the supplied vector and stores the one computed from the redacted text", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const res: any = await m.post({ agentId: AGENT, content: `ship it with ${GITHUB_TOKEN} today`, embedding: SUPPLIED, embeddingModel: "client-model" });

    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.embedding).toEqual(FAKE_EMBEDDING);
    expect(stored.embeddingModel).toBe("mock-embedding-model");
    expect(embedInputs).toContain(`ship it with ${REDACTED} today`);
    expect(embedInputs.some((text) => text.includes(GITHUB_TOKEN))).toBe(false);
  });

  it("Memory.put discards the supplied vector and stores the one computed from the redacted text", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const res: any = await m.put({ id: "mem-put-supplied-vector", agentId: AGENT, content: `ship it with ${AWS_KEY} today`, embedding: SUPPLIED, embeddingModel: "client-model" });

    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.embedding).toEqual(FAKE_EMBEDDING);
    expect(stored.embeddingModel).toBe("mock-embedding-model");
    expect(embedInputs).toContain(`ship it with ${REDACTED} today`);
    expect(embedInputs.some((text) => text.includes(AWS_KEY))).toBe(false);
  });

  it("Memory.patch discards the supplied vector and stores the one computed from the redacted text", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: AGENT, content: "old", archived: false, createdAt: new Date().toISOString() });
    const m: any = makeMemory(agentCtx(AGENT));
    m._targetId = "mem-1";
    await m.patch({ content: `rotate: ${GITHUB_TOKEN}`, embedding: SUPPLIED, embeddingModel: "client-model" });

    const stored = await (BaseMemory as any).get("mem-1");
    expect(stored.embedding).toEqual(FAKE_EMBEDDING);
    expect(stored.embeddingModel).toBe("mock-embedding-model");
    expect(embedInputs).toEqual([`rotate: ${REDACTED}`]);
  });

  it("redactMemoryWrite removes a supplied vector when it changes `trigger`, and keeps it when it changes only `summary`", () => {
    const triggerBody: any = { content: "plain", trigger: `when the token=${GITHUB_TOKEN} expires`, embedding: SUPPLIED, embeddingModel: "client-model" };
    expect(redactMemoryWrite(triggerBody)).toEqual({ count: 1, embeddingDiscarded: true });
    expect("embedding" in triggerBody || "embeddingModel" in triggerBody).toBe(false);
    const summaryBody: any = { content: "plain", summary: `uses ${SLACK_TOKEN}`, embedding: SUPPLIED, embeddingModel: "client-model" };
    expect(redactMemoryWrite(summaryBody)).toEqual({ count: 1, embeddingDiscarded: false });
    expect(summaryBody.embedding).toEqual(SUPPLIED);
  });

  it("an administrator's supplied vector is kept when redaction changes nothing, or changes only `summary`", async () => {
    const m = makeMemory(agentCtx(AGENT, true));
    const clean: any = await m.post({ agentId: AGENT, content: "a plain note about the deploy job", embedding: SUPPLIED, embeddingModel: "client-model" });
    const summaryOnly: any = await m.post({
      agentId: AGENT, content: "another plain note about the deploy job", summary: `uses ${SLACK_TOKEN}`, embedding: SUPPLIED, embeddingModel: "client-model",
    });

    for (const id of [clean.id, summaryOnly.id]) {
      const stored = await (BaseMemory as any).get(id);
      expect(stored.embedding).toEqual(SUPPLIED);
      expect(stored.embeddingModel).toBe("client-model");
    }
    expect(summaryOnly.redactedValues).toBe(1);
  });

  it("a non-admin POST discards the supplied vector even when redaction changes nothing", async () => {
    const m = makeMemory(agentCtx(AGENT));
    const res: any = await m.post({ agentId: AGENT, content: "a plain note about the deploy job", embedding: SUPPLIED, embeddingModel: "client-model" });

    const stored = await (BaseMemory as any).get(res.id);
    expect(stored.embedding).toEqual(FAKE_EMBEDDING);
    expect(stored.embeddingModel).toBe("mock-embedding-model");
    expect(stored.embedding).not.toEqual(SUPPLIED);
  });
});

describe("flair#2407 — a deduplicated feed write reports the count in its response only", () => {
  it("the second identical feed write returns the stored row plus the count; the stored row has no count", async () => {
    const f: any = new (FeedMemories as any)();
    f.getContext = () => ({ request: agentCtx(AGENT) });
    const original = `feed memory carrying ${GITHUB_TOKEN} twice`;
    const first: any = await f.post({ agentId: AGENT, content: original, durability: "permanent" });
    const second: any = await f.post({ agentId: AGENT, content: original, durability: "permanent" });

    const { redactedValues, ...rest } = second;
    expect(redactedValues).toBe(1);
    // flair#2561: the stored row less contentHash, which the request did not supply.
    const { contentHash, ...reported } = memoryStore.get(first.id);
    expect(typeof contentHash).toBe("string");
    expect(rest).toEqual(reported);
    expect(memoryStore.size).toBe(1);
    expect("redactedValues" in memoryStore.get(first.id)).toBe(false);
  });
});


describe("skill metadata validation before redaction", () => {
  for (const path of ["POST", "PUT", "feed", "superseding POST"]) {
    it(`${path} refuses duplicate metadata without changing the supplied text or stored rows`, async () => {
      const root = { id: "metadata-root", agentId: AGENT, content: "procedure", trigger: "when deploying", tags: ["skill"], createdAt: new Date().toISOString() };
      memoryStore.set(root.id, root);
      const body: any = {
        agentId: AGENT, content: `procedure ${GITHUB_TOKEN}`, summary: `summary ${AWS_KEY}`,
        metadata: `{"name":"${GITHUB_TOKEN}","name":"deploy"}`,
      };
      if (path === "POST") body.tags = ["skill"];
      else if (path === "superseding POST") body.supersedes = root.id;
      else body.id = root.id;
      const original = structuredClone(body);
      const m: any = makeMemory(agentCtx(AGENT));
      const f: any = new (FeedMemories as any)();
      f.getContext = () => ({ request: agentCtx(AGENT) });
      if (path === "PUT") m._targetId = root.id;
      const result = path === "feed" ? await f.post(body) : path === "PUT" ? await m.put(body) : await m.post(body);
      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ error: "skill_metadata_duplicate_key" });
      for (const field of ["content", "summary", "metadata"]) expect(body[field]).toBe(original[field]);
      expect([...memoryStore.values()]).toEqual([root]);
      expect(embedInputs).toEqual([]);
    });
  }
});


it("a skill reindex requires distinct supplied or retained top-level metadata keys", async () => {
  const { buildReindexRow } = await import("../../resources/Memory.ts");
  const root = { id: "metadata-reindex", agentId: AGENT, content: "procedure", tags: ["skill"], createdAt: new Date().toISOString() };
  const metadata = `{"name":"${GITHUB_TOKEN}","name":"deploy"}`;
  for (const [body, stored] of [[{ ...root, metadata }, root], [root, { ...root, metadata }]]) {
    expect(buildReindexRow({ ...body, _reindex: true }, stored)).toMatchObject({ status: 400, error: "skill_metadata_duplicate_key" });
  }
});

describe("flair#2561 — `stored` reports only the string-valued text fields the request supplied, and the feed response the allowlisted primitive Memory attributes it supplied plus the listed response fields and `redactedValues` when present", () => {
  it("suppliedMemoryTextFields names the text fields that hold a string in the request body", () => {
    expect(suppliedMemoryTextFields({ content: "c", summary: null, trigger: 42, tags: ["skill"] })).toEqual(["content"]);
    expect(suppliedMemoryTextFields({ summary: "s", trigger: "" })).toEqual(["summary", "trigger"]);
    expect(suppliedMemoryTextFields({ tags: ["skill"], supersedes: "x" })).toEqual([]);
    expect(suppliedMemoryTextFields(null)).toEqual([]);
    expect(suppliedMemoryTextFields(["content"])).toEqual([]);
  });

  it("storedMemoryText copies only the supplied fields from the row, as stored", () => {
    const row = { content: "row content", summary: `row summary ${REDACTED}`, trigger: "row trigger", tags: ["skill"] };
    expect(storedMemoryText(row, ["summary"])).toEqual({ summary: `row summary ${REDACTED}` });
    expect(storedMemoryText(row, ["content", "summary", "trigger"])).toEqual({ content: "row content", summary: `row summary ${REDACTED}`, trigger: "row trigger" });
    expect(storedMemoryText({ content: "only content" }, ["content", "trigger"])).toEqual({ content: "only content" });
    expect(storedMemoryText(row, [])).toEqual({});
  });

  it("suppliedMemoryFields names the request body's keys that hold a non-null value", () => {
    expect([...suppliedMemoryFields({ content: "c", summary: null, trigger: undefined, tags: ["skill"], metadata: "" })]).toEqual(["content", "tags", "metadata"]);
    expect([...suppliedMemoryFields(null)]).toEqual([]);
    expect([...suppliedMemoryFields(["content"])]).toEqual([]);
  });

  it("feedResponseFields returns named primitive fields", () => {
    const row = {
      id: "r1", agentId: "a", durability: "persistent", visibility: "shared", createdAt: "t0", updatedAt: "t1", supersedes: "r0",
      content: "c", summary: "s", trigger: "t", tags: ["skill"], metadata: "{}", subject: "subj", contentHash: "h",
      embedding: [1, 0], embeddingModel: "m", _safetyFlags: [],
    };
    expect(feedResponseFields(row, new Set(["summary", "tags", "embedding", "embeddingModel"]))).toEqual({
      id: "r1", agentId: "a", durability: "persistent", visibility: "shared", createdAt: "t0", updatedAt: "t1", supersedes: "r0",
      summary: "s",
    });
    expect(row.content).toBe("c");
  });

  async function expectWithheld(result: unknown): Promise<void> {
    expect(result instanceof Response).toBe(true);
    const response = result as Response;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: WRITE_RESPONSE_WITHHELD, message: WRITE_RESPONSE_WITHHELD_MESSAGE });
  }

  const resultShapes: Array<[string, () => any]> = [
    ["Date", () => Object.assign(new Date(0), { id: "mem-2561-exits", embedding: [1] })],
    ["Map", () => Object.assign(new Map([["embedding", [1]]]), { id: "mem-2561-exits" })],
    ["wrapper", () => ({ id: "mem-2561-exits", row: { embedding: [1] } })],
    ["hidden array element", () => {
      const values = ["hidden"];
      Object.defineProperty(values, "0", { value: { embedding: [1] }, enumerable: false });
      return Object.assign(values, { id: "mem-2561-exits" });
    }],
    ["nested fields", () => ({ id: "mem-2561-exits", metadata: { embedding: [1] }, tags: [{ embeddingModel: "m" }], extra: { a: 1 } })],
    ["changing field", () => {
      let reads = 0;
      return Object.defineProperty({ id: "mem-2561-exits" }, "metadata", { enumerable: true, get: () => ++reads === 1 ? "{}" : { embedding: [1] } });
    }],
  ];

  async function memoryExits(result: () => any, redacted: boolean): Promise<Array<[string, any]>> {
    const row = {
      id: "mem-2561-exits", agentId: AGENT, content: "a note", embedding: FAKE_EMBEDDING,
      embeddingModel: "mock-embedding-model", instanceToken: "token", contentHash: "hash",
      visibility: "shared", archived: false, createdAt: "2026-01-01T00:00:00.000Z",
    };
    const oldPost = BaseMemory.post;
    const oldPut = BaseMemory.put;
    const oldPatch = BaseMemory.prototype.patch;
    const oldCreate = (Memory as any).create;
    const body = redacted ? `rotate ${GITHUB_TOKEN}` : "a changed note";
    const answers: Array<[string, any]> = [];
    BaseMemory.post = async () => result();
    // Stage the row for ordinary owned PUT verification after a normal result.
    // Refusals, storage Responses and skill PUT return before that read; composed
    // promotion uses its caller's in-transaction existence check.
    BaseMemory.put = async (content: any, ctx?: any) => {
      await oldPut.call(BaseMemory, content, ctx);
      return result();
    };
    BaseMemory.prototype.patch = async () => result();
    try {
      for (const adapter of ["post", "create"]) {
        if (adapter === "create") (Memory as any).create = async () => result();
        memoryStore.clear();
        answers.push([`POST ${adapter}`, await makeMemory(agentCtx(AGENT)).post({ id: row.id, agentId: AGENT, content: body, visibility: "shared" })]);
      }
      memoryStore.set(row.id, { ...row });
      const put = makeMemory(agentCtx(AGENT));
      put._targetId = row.id;
      answers.push(["PUT", await put.put({ id: row.id, agentId: AGENT, content: body, visibility: "shared" })]);
      memoryStore.set(row.id, { ...row });
      const patch = makeMemory(agentCtx(AGENT));
      patch._targetId = row.id;
      answers.push(["PATCH", await patch.patch({ summary: body })]);
      memoryStore.set(row.id, { ...row });
      const reindex = makeMemory({});
      reindex.getContext = () => ({ __flairInternal: true, request: {} });
      reindex._targetId = row.id;
      answers.push(["_reindex", await reindex.put({ ...row, _reindex: true })]);
      return answers;
    } finally {
      BaseMemory.post = oldPost;
      BaseMemory.put = oldPut;
      BaseMemory.prototype.patch = oldPatch;
      if (oldCreate === undefined) delete (Memory as any).create;
      else (Memory as any).create = oldCreate;
    }
  }

  for (const [shape, makeResult] of resultShapes) {
    for (const redacted of [false, true]) {
      it(`${shape}: Memory exits return exactly their named fields, and a PATCH or _reindex that replaced no value returns no body, redaction=${redacted}`, async () => {
        for (const [exit, result] of await memoryExits(makeResult, redacted)) {
          const redaction = redacted && exit !== "_reindex"
            ? { redactedValues: 1, stored: exit === "PATCH" ? { summary: "rotate [redacted]" } : { content: "rotate [redacted]" } }
            : {};
          const rowExit = exit === "PATCH" || exit === "_reindex";
          if (rowExit && !("redactedValues" in redaction)) {
            // No body (HTTP 204): nothing of the storage result is returned.
            expect(result, exit).toBeUndefined();
            continue;
          }
          const expected = rowExit
            ? { id: "mem-2561-exits", written: true, ...redaction }
            : { id: "mem-2561-exits", written: true, deduplicated: false, visibility: "shared", ...redaction };
          expect(result, exit).toEqual(expected);
          expect(Object.getPrototypeOf(result), exit).toBe(Object.prototype);
          expect(JSON.parse(JSON.stringify(result)), exit).toEqual(expected);
        }
      });
    }
    for (const redacted of [false, true]) {
      it(`${shape}: a feed match returns exactly its named primitive fields, redaction=${redacted}`, async () => {
        const requestContent = redacted ? `rotate ${GITHUB_TOKEN}` : "a feed match";
        const content = redacted ? "rotate [redacted]" : requestContent;
        const row = makeResult();
        row.agentId = AGENT;
        row.content = content;
        row.contentHash = computeContentHash(AGENT, content);
        row.durability = "permanent";
        row.createdAt = "2026-01-01T00:00:00.000Z";
        memoryStore.set(row.id, row);
        const feed: any = new (FeedMemories as any)();
        feed.getContext = () => ({ request: agentCtx(AGENT) });
        const response = await feed.post({ agentId: AGENT, content: requestContent, durability: "permanent", tags: ["a"] });
        const expected = { id: row.id, agentId: AGENT, content, durability: "permanent", createdAt: row.createdAt, ...(redacted ? { redactedValues: 1 } : {}) };
        expect(response).toEqual(expected);
        expect(Object.getPrototypeOf(response)).toBe(Object.prototype);
        expect(JSON.parse(JSON.stringify(response))).toEqual(expected);
      });
    }
  }

  for (const status of [200, 409]) {
    it(`storage Response status ${status}: Memory exits return write_response_withheld`, async () => {
      for (const [, result] of await memoryExits(() => Response.json({ id: "mem-2561-exits", embedding: [1] }, { status }), false)) {
        await expectWithheld(result);
      }
    });
  }

  for (const status of [200, 409]) {
    it(`feed storage Response status ${status} returns write_response_withheld`, async () => {
      const oldPut = BaseMemory.put;
      const oldUpdate = (BaseMemory as any).update;
      BaseMemory.put = async () => Response.json({ embedding: [1] }, { status });
      (BaseMemory as any).update = async () => Response.json({ embedding: [1] }, { status });
      try {
        const feed: any = new (FeedMemories as any)();
        feed.getContext = () => ({ request: agentCtx(AGENT) });
        await expectWithheld(await feed.post({ id: "feed-new", agentId: AGENT, content: "a new feed row", durability: "permanent" }));
        const content = "an ephemeral feed match";
        memoryStore.set("feed-repair", {
          id: "feed-repair", agentId: AGENT, content, contentHash: computeContentHash(AGENT, content),
          durability: "ephemeral", visibility: "private", createdAt: "2026-01-01T00:00:00.000Z",
        });
        await expectWithheld(await feed.post({ agentId: AGENT, content, durability: "ephemeral" }));
      } finally {
        BaseMemory.put = oldPut;
        if (oldUpdate === undefined) delete (BaseMemory as any).update;
        else (BaseMemory as any).update = oldUpdate;
      }
    });

    it(`skill storage Response status ${status} returns write_response_withheld`, async () => {
      const { defaultSkillHooks } = await import("../../resources/skill-version-write.ts");
      const oldPut = BaseMemory.put;
      BaseMemory.put = async () => Response.json({ embedding: [1] }, { status });
      try {
        const row = { id: "s1", agentId: AGENT, content: "a skill", createdAt: "2026-01-01T00:00:00.000Z" };
        await expectWithheld(await defaultSkillHooks.createSuccessor!(row, {}));
        await expectWithheld(await defaultSkillHooks.closePredecessor!(row, { validTo: "t" }, {}));
      } finally {
        BaseMemory.put = oldPut;
      }
    });
  }

  for (const status of [200, 409]) {
    it(`storage Response status ${status} retains write_response_withheld when the row changes`, async () => {
      for (const [, result] of await memoryExits(() => {
        memoryStore.clear();
        return Response.json({ embedding: [1] }, { status });
      }, false)) await expectWithheld(result);
      const oldPut = BaseMemory.put;
      BaseMemory.put = async (row: any) => {
        memoryStore.set(row.id, { id: row.id, agentId: AGENT, content: "changed", createdAt: "t" });
        return Response.json({ embedding: [1] }, { status });
      };
      try {
        const feed: any = new (FeedMemories as any)();
        feed.getContext = () => ({ request: agentCtx(AGENT) });
        await expectWithheld(await feed.post({ id: "changed-feed", agentId: AGENT, content: "a feed row", durability: "permanent" }));
      } finally {
        BaseMemory.put = oldPut;
      }
    });
  }

  it("POST requires a string id from both storage adapters", async () => {
    for (const value of [undefined, null, {}, { id: 4 }, { id: null }]) {
      const results = await memoryExits(() => value, false);
      for (const [, result] of results.filter(([exit]) => exit.startsWith("POST"))) await expectWithheld(result);
    }
  });

  it("the builder requires a string id and copies stored text by name", async () => {
    const rules = { id: { type: "string", required: true }, ...REDACTION_RULES } as const;
    for (const value of [undefined, null, {}, { id: 4 }, { id: null }]) {
      await expectWithheld(buildFromAllowlist(value, rules));
      await expectWithheld(feedResponseFields(value, new Set()));
    }
    const stored = { content: "c", summary: { embedding: [1] }, trigger: "t", extra: { embedding: [1] } };
    const source = { id: "r1", stored, redactedValues: 1, extra: { embedding: [1] } };
    const result: any = buildFromAllowlist(source, rules);
    expect(result).toEqual({ id: "r1", stored: { content: "c", trigger: "t" }, redactedValues: 1 });
    expect(result.stored).not.toBe(stored);
    stored.content = "changed";
    expect(result.stored.content).toBe("c");
    expect(buildFromAllowlist({ id: "r1", stored: 1, redactedValues: "1" }, rules)).toEqual({ id: "r1" });
  });

  it("the builder defines named fields as own properties", () => {
    const source = JSON.parse('{"id":"r1","__proto__":"a string"}');
    const rules = { id: { type: "string", required: true }, ["__proto__"]: { type: "string" } } as const;
    const result = buildFromAllowlist(source, rules);
    expect(result).toEqual(source);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("the feed copies a primitive field once and omits values of another type", () => {
    let reads = 0;
    const row = Object.defineProperty({ id: "r1", tags: ["a"], metadata: 2, archived: "false", retrievalCount: 1.5 }, "content", {
      get: () => ++reads === 1 ? "c" : { embedding: [1] },
    });
    expect(feedResponseFields(row, new Set(["content", "tags", "metadata", "archived", "retrievalCount"]))).toEqual({ id: "r1", content: "c" });
    expect(reads).toBe(1);
  });

  it("storage Responses are withheld and internal refusals retain their named error", async () => {
    for (const status of [200, 409]) {
      await expectWithheld(storageResult(Response.json({ embedding: [1] }, { status })));
      await expectWithheld(feedResponseFields(Response.json({ embedding: [1] }, { status }), new Set()));
    }
    const refusal = Response.json({ error: "stored_row_changed" }, { status: 409 });
    expect(writeResultResponse(refusal)).toBe(refusal);
    await expectWithheld(writeResultResponse(Response.json({ id: "r1" })));
  });

  it("Memory.patch of one field over a row holding all three reports only that field", async () => {
    memoryStore.set("mem-2561", { id: "mem-2561", agentId: AGENT, content: "base content", summary: "base summary", trigger: "base trigger", archived: false, createdAt: new Date().toISOString() });
    const m: any = makeMemory(agentCtx(AGENT));
    m._targetId = "mem-2561";
    const res: any = await m.patch({ trigger: `rotate ${GITHUB_TOKEN}` });
    expect(res.redactedValues).toBe(1);
    expect(res.stored).toEqual({ trigger: `rotate ${REDACTED}` });
    expect(memoryStore.get("mem-2561").content).toBe("base content");
  });

  it("a deduplicated feed write gets back only the Memory attributes it supplied and the write fields of the matched row, no embedding", async () => {
    const f: any = new (FeedMemories as any)();
    f.getContext = () => ({ request: agentCtx(AGENT) });
    const content = "a matched feed memory";
    memoryStore.set("mem-2561-match", {
      id: "mem-2561-match", agentId: AGENT, content, contentHash: computeContentHash(AGENT, content), durability: "permanent",
      metadata: JSON.stringify({ name: "n" }), subject: "subj", embedding: FAKE_EMBEDDING, embeddingModel: "mock-embedding-model",
      archived: false, createdAt: new Date().toISOString(),
    });
    const res: any = await f.post({ agentId: AGENT, content, durability: "permanent" });
    expect(res.id).toBe("mem-2561-match");
    for (const field of ["metadata", "subject", "embedding", "embeddingModel", "contentHash"]) expect(field in res, field).toBe(false);
    expect(res.content).toBe(content);
    expect(JSON.stringify(res).includes("embedding")).toBe(false);
  });

  it("a deduplicated feed write that supplies only content gets back no summary or trigger of the matched row", async () => {
    const f: any = new (FeedMemories as any)();
    f.getContext = () => ({ request: agentCtx(AGENT) });
    const original = `feed memory ${GITHUB_TOKEN} with a summary`;
    const first: any = await f.post({ agentId: AGENT, content: original, summary: "first summary", trigger: "first trigger", durability: "permanent" });
    expect([first.summary, first.trigger]).toEqual(["first summary", "first trigger"]);
    const second: any = await f.post({ agentId: AGENT, content: original, durability: "permanent" });
    expect(second.id).toBe(first.id);
    expect(second.redactedValues).toBe(1);
    expect(second.content).toBe(`feed memory ${REDACTED} with a summary`);
    expect("summary" in second || "trigger" in second).toBe(false);
    expect(memoryStore.get(first.id).summary).toBe("first summary");
  });
});
