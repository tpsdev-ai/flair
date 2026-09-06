/**
 * Scripted PUT /Soul with an ADK-sourced claim must not land. Isolated so
 * the harper mock does not collide with memory-soul-read-gate.test.ts.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

let soulStore: Map<string, any>;
let candidateStore: any[];
let memoryStore: any[];
let lookupFails = false;
let getBehavior: "ok" | "throw" | "empty" = "ok";

class BaseSoul {
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

function search(rows: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      if (lookupFails) throw new Error("provenance unavailable");
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
    },
  },
}));

const { Soul } = await import("../../resources/Soul.ts");
const ADK_SOUL_REFUSAL = "soul_value_is_learned_content";

function makeSoul(id?: string) {
  const r: any = new (Soul as any)();
  if (id) r.id = id;
  r.getContext = () => ({ request: { tpsAgent: "shared-app", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic verified-by-middleware" }) } });
  return r;
}

beforeEach(() => {
  soulStore = new Map();
  candidateStore = [];
  memoryStore = [];
  getBehavior = "ok";
  lookupFails = false;
});

describe("Soul.put refuses ADK-sourced claims", () => {
  test("PUT of an ADK candidate claim is 403 and writes nothing", async () => {
    candidateStore.push({ agentId: "shared-app", claim: "alice likes tea", scopeTag: "adk:app:alice" });
    const res = await makeSoul().put({
      id: "shared-app-pref",
      agentId: "shared-app",
      key: "pref",
      value: "alice likes tea",
    });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(await (res as Response).json()).toEqual({ error: ADK_SOUL_REFUSAL });
    expect(soulStore.size).toBe(0);
  });

  test("PUT of an ordinary Soul value still lands", async () => {
    const res: any = await makeSoul().put({
      id: "shared-app-role",
      agentId: "shared-app",
      key: "role",
      value: "Be the team's memory.",
    });
    expect(res).not.toBeInstanceOf(Response);
    expect(soulStore.get("shared-app-role").value).toBe("Be the team's memory.");
  });
});

describe("Soul.patch refuses ADK-sourced claims", () => {
  test("PATCH of an ADK candidate claim is 403 and writes nothing", async () => {
    soulStore.set("shared-app-pref", {
      id: "shared-app-pref",
      agentId: "shared-app",
      key: "pref",
      value: "Be concise.",
    });
    candidateStore.push({ agentId: "shared-app", claim: "alice likes tea", scopeTag: "adk:app:alice" });
    const res = await makeSoul("shared-app-pref").patch({ value: "alice likes tea" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(await (res as Response).json()).toEqual({ error: ADK_SOUL_REFUSAL });
    expect(soulStore.get("shared-app-pref").value).toBe("Be concise.");
  });

  test("PATCH of an ordinary Soul value still lands", async () => {
    soulStore.set("shared-app-role", {
      id: "shared-app-role",
      agentId: "shared-app",
      key: "role",
      value: "old",
    });
    const res: any = await makeSoul("shared-app-role").patch({ value: "Be the team's memory." });
    expect(res).not.toBeInstanceOf(Response);
    expect(soulStore.get("shared-app-role").value).toBe("Be the team's memory.");
  });

  test("a failed stored-state read cannot authorize a PATCH", async () => {
    soulStore.set("shared-app-pref", {
      id: "shared-app-pref",
      agentId: "shared-app",
      key: "pref",
      value: "Be concise.",
    });
    getBehavior = "throw";
    const soul = makeSoul("shared-app-pref");
    await expect(soul.patch({ value: "alice likes tea" })).rejects.toThrow("unavailable");
    expect(soulStore.get("shared-app-pref").value).toBe("Be concise.");
  });

  test("an empty stored-state read cannot authorize a PATCH", async () => {
    soulStore.set("shared-app-pref", {
      id: "shared-app-pref",
      agentId: "shared-app",
      key: "pref",
      value: "Be concise.",
    });
    getBehavior = "empty";
    const res = await makeSoul("shared-app-pref").patch({ value: "alice likes tea" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(await (res as Response).json()).toEqual({ error: "soul_stored_state_unavailable" });
    expect(soulStore.get("shared-app-pref").value).toBe("Be concise.");
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
        const soul = makeSoul("soul");
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
        const soul = makeSoul("soul");
        if (source === "internal") soul.getContext = () => ({ request: {}, __flairInternal: true });
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
      rows.push({ agentId: "shared-app", claim: "learned", content: "learned", provenance: '{"verified":{"sourceClass":"operator"}}' });
      for (const method of ["post", "put", "patch"]) {
        soulStore.set("soul", { id: "soul", agentId: "shared-app", value: "original" });
        const result = await makeSoul("soul")[method]({ id: "soul", agentId: "shared-app", value: "learned" });
        expect(result.status).toBe(403);
        expect(soulStore.get("soul").value).toBe("original");
      }
      rows.length = 0;
    }
  });
});


test("failed learned-content lookup aborts all content writes", async () => {
  lookupFails = true;
  for (const method of ["post", "put", "patch"]) {
    soulStore.set("soul", { id: "soul", agentId: "shared-app", value: "original" });
    await expect(makeSoul("soul")[method]({ id: "soul", agentId: "shared-app", value: "replacement" })).rejects.toThrow("provenance unavailable");
    expect(soulStore.get("soul").value).toBe("original");
  }
});


test("another agent cannot poison an operator edit by copying its text", async () => {
  memoryStore.push({ agentId: "other-agent", content: "Operator-authored role" });
  const result = await makeSoul().put({ id: "soul", agentId: "shared-app", value: "Operator-authored role" });
  expect(result).not.toBeInstanceOf(Response);
  expect(soulStore.get("soul").value).toBe("Operator-authored role");
});
