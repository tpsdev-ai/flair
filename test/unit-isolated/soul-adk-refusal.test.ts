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
let getBehavior: "ok" | "throw" | "empty" = "ok";

class BaseSoul {
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
const { ADK_SOUL_REFUSAL } = await import("../../resources/soul-adk-guard.ts");

function makeSoul(id?: string) {
  const r: any = new (Soul as any)();
  if (id) r.id = id;
  r.getContext = () => ({ request: { tpsAgent: "shared-app", tpsAgentIsAdmin: false } });
  return r;
}

beforeEach(() => {
  soulStore = new Map();
  candidateStore = [];
  memoryStore = [];
  getBehavior = "ok";
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
