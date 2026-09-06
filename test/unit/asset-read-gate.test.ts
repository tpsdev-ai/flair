/**
 * asset-read-gate.test.ts — behavior guard for resources/Asset.ts
 * (images-in-Flair slice 1). Same harper-mock technique as
 * memory-candidate-read-gate.test.ts: mock harper so the resource loads
 * outside a real Harper runtime, then drive allowRead()/get()/search()/
 * post()/put()/delete() against an in-memory store. Also covers the base64→
 * Blob coercion via a mocked createBlob. No other test/unit/ file imports
 * resources/Asset.ts, so this file owns that mock+import with no collision.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

let assetStore: Map<string, any>;

function matchesCondition(record: any, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const results = cond.conditions.map((c: any) => matchesCondition(record, c));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  const fieldVal = record[cond.attribute];
  if (cond.comparator === "equals") return fieldVal === cond.value;
  if (cond.comparator === "not_equal") return fieldVal !== cond.value;
  return true;
}

class BaseAsset {
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id;
    return assetStore.get(id) ?? null;
  }
  async post(content: any) {
    const id = content.id ?? `asset_${Math.random().toString(36).slice(2)}`;
    content.id = id;
    assetStore.set(id, { ...content });
    return { ...content };
  }
  async put(content: any) {
    assetStore.set(content.id, { ...content });
    return { ...content };
  }
  async delete(id: any) {
    assetStore.delete(id);
    return { ok: true };
  }
  search(query?: any) {
    const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
    let records = Array.from(assetStore.values());
    for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
    async function* gen() {
      for (const r of records) yield r;
    }
    return gen();
  }
}

const databasesMock = {
  flair: {
    Asset: BaseAsset,
    Agent: { get: async () => null, search: async () => [] },
  },
};

const createBlobMock = (bytes: any, opts?: any) => ({ __blob: true, type: opts?.type, size: bytes?.length });

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: databasesMock,
  Resource: class {},
  createBlob: createBlobMock,
}));

const { Asset } = await import("../../resources/Asset.ts");

function makeAsset(ctxRequest: any) {
  const r: any = new (Asset as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

async function collect(res: any): Promise<any[]> {
  if (res && typeof res[Symbol.asyncIterator] === "function") {
    const out: any[] = [];
    for await (const r of res) out.push(r);
    return out;
  }
  return res;
}

beforeEach(() => {
  assetStore = new Map();
});

describe("Asset.allowRead — identity gate", () => {
  it("anonymous is denied", async () => {
    expect(await (makeAsset(anonCtx()) as any).allowRead()).toBe(false);
  });
  it("a verified non-admin agent is allowed", async () => {
    expect(await (makeAsset(agentCtx("agent-1")) as any).allowRead()).toBe(true);
  });
  it("an internal call (no request context) is allowed", async () => {
    const r: any = new (Asset as any)();
    r.getContext = () => undefined;
    expect(await r.allowRead()).toBe(true);
  });
});

describe("Asset.post — attribution + blob coercion", () => {
  it("anonymous is rejected (401)", async () => {
    const res: any = await (makeAsset(anonCtx()) as any).post({ data: "aGk=", contentType: "image/jpeg" });
    expect(res.status).toBe(401);
  });

  it("stamps the caller's agentId and coerces a base64 data string to a Blob", async () => {
    await (makeAsset(agentCtx("agent-owner")) as any).post({
      memoryId: "mem-1",
      contentType: "image/jpeg",
      data: Buffer.from("hello").toString("base64"),
    });
    const stored = Array.from(assetStore.values())[0];
    expect(stored.agentId).toBe("agent-owner");
    expect(stored.data.__blob).toBe(true);
    expect(stored.data.type).toBe("image/jpeg");
    expect(typeof stored.createdAt).toBe("string");
  });
});

describe("Asset.get / search — owner scoping", () => {
  it("an agent sees only its own assets on search", async () => {
    await (makeAsset(agentCtx("agent-a")) as any).post({ contentType: "image/png", data: "AA==" });
    await (makeAsset(agentCtx("agent-a")) as any).post({ contentType: "image/png", data: "AA==" });
    await (makeAsset(agentCtx("agent-b")) as any).post({ contentType: "image/png", data: "AA==" });

    const mine = await collect(await (makeAsset(agentCtx("agent-a")) as any).search());
    expect(mine.length).toBe(2);
    expect(mine.every((r: any) => r.agentId === "agent-a")).toBe(true);
  });

  it("a by-id read of another agent's asset is 404 (no id oracle)", async () => {
    await (makeAsset(agentCtx("agent-a")) as any).post({ id: "asset-x", contentType: "image/png", data: "AA==" });
    const res: any = await (makeAsset(agentCtx("agent-b")) as any).get({ id: "asset-x" });
    expect(res.status).toBe(404);
  });
});

describe("Asset.delete — owner only", () => {
  it("a non-owner cannot delete another agent's asset (403)", async () => {
    await (makeAsset(agentCtx("agent-a")) as any).post({ id: "asset-y", contentType: "image/png", data: "AA==" });
    const res: any = await (makeAsset(agentCtx("agent-b")) as any).delete("asset-y");
    expect(res.status).toBe(403);
    expect(assetStore.has("asset-y")).toBe(true);
  });
});
