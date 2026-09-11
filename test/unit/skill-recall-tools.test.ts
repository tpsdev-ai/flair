// skill_search / skill_get wrapper-layer unit tests (flair#1546).
//
// These drive the SHIPPED `TOOLS.skill_search.impl` / `TOOLS.skill_get.impl`
// with CAPTURE DOUBLES injected via `__setHandlers` (never mock.module on the
// shared resources/*.ts — that leaks process-globally in bun), so they exercise
// the THIN WRAPPER SEAM in isolation: the delegated body skill_search sends to
// SemanticSearch, the lightweight card projection, and skill_get's read + skill
// guard. The REAL read-scope (resolveReadScope) is proven end-to-end against a
// live Harper in test/integration/skill-recall-tools.test.ts; here we prove the
// wrapper cannot itself widen scope (it forwards NO body agentId) and never
// leaks the full procedure over the catalog.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { TOOLS, __setHandlers, type ResolvedAgent } from "../../resources/mcp-tools.ts";

const AGENT: ResolvedAgent = { agentId: "skill-recall-agent", isAdmin: false };

// Capture the exact body the wrapper delegates to SemanticSearch.post().
let lastSearchBody: any = null;
let searchResult: any = { results: [] };
class FakeSemanticSearch {
  constructor(_id?: any, _ctx?: any) {}
  async post(body: any) {
    lastSearchBody = body;
    return searchResult;
  }
}

// A static-get double for Memory (skill_get uses the static `Cls.get(id, ctx)`
// by-id read form, per flair#1181).
let getResult: any = null;
const FakeMemory = {
  get: async (_target: any, _ctx: any) => getResult,
};

const restore = __setHandlers({ SemanticSearch: FakeSemanticSearch as any, Memory: FakeMemory as any });
afterAll(() => restore());

beforeEach(() => {
  lastSearchBody = null;
  searchResult = { results: [] };
  getResult = null;
});

describe("skill_search — delegated body", () => {
  test("rides SemanticSearch with a skill tag-seek, the task as q, and the trigger/metadata projection opts", async () => {
    await TOOLS.skill_search.impl(AGENT, { task: "resize an image before upload", limit: 3 });
    expect(lastSearchBody.tag).toBe("skill");
    expect(lastSearchBody.q).toBe("resize an image before upload");
    expect(lastSearchBody.limit).toBe(3);
    // name/description live in the metadata blob; trigger is not in DEFAULT_SELECT.
    expect(lastSearchBody.includeMetadata).toBe(true);
    expect(lastSearchBody.includeTrigger).toBe(true);
  });

  test("defaults limit to 5", async () => {
    await TOOLS.skill_search.impl(AGENT, { task: "anything" });
    expect(lastSearchBody.limit).toBe(5);
  });

  test("forwards NO body agentId — the wrapper cannot widen scope past the resolved agent", async () => {
    await TOOLS.skill_search.impl(AGENT, { task: "x", agentId: "some-other-agent" });
    expect(lastSearchBody.agentId).toBeUndefined();
  });
});

describe("skill_search — lightweight card projection (progressive disclosure)", () => {
  test("returns only id/name/trigger/description/tags/agentId; the full procedure + embedding are stripped", async () => {
    searchResult = {
      results: [
        {
          id: "sk-1",
          agentId: "author-1",
          trigger: "when resizing an image",
          content: "THE FULL PROCEDURE — must not appear on the card",
          tags: ["skill", "images"],
          metadata: JSON.stringify({ name: "resize-image", description: "Resize an image to a max dimension" }),
          embedding: [0.1, 0.2, 0.3],
          embeddingModel: "test-model",
          visibility: "shared",
        },
      ],
    };
    const res = await TOOLS.skill_search.impl(AGENT, { task: "resize" });
    expect(Array.isArray(res.results)).toBe(true);
    const card = res.results[0];
    expect(new Set(Object.keys(card))).toEqual(new Set(["id", "name", "trigger", "description", "tags", "agentId"]));
    expect(card.id).toBe("sk-1");
    expect(card.name).toBe("resize-image");
    expect(card.description).toBe("Resize an image to a max dimension");
    expect(card.trigger).toBe("when resizing an image");
    expect(card.tags).toEqual(["skill", "images"]);
    expect(card.agentId).toBe("author-1");
    // Progressive disclosure + no-leak: never the procedure, never the vector.
    expect("content" in card).toBe(false);
    expect("embedding" in card).toBe(false);
    expect("embeddingModel" in card).toBe(false);
  });

  test("a card with corrupt/absent metadata still projects (name/description simply absent)", async () => {
    searchResult = {
      results: [
        { id: "sk-2", agentId: "a", trigger: "t", tags: ["skill"], metadata: "{not json" },
        { id: "sk-3", agentId: "a", trigger: "t2", tags: ["skill"] },
      ],
    };
    const res = await TOOLS.skill_search.impl(AGENT, { task: "x" });
    expect(res.results[0].id).toBe("sk-2");
    expect(res.results[0].name).toBeUndefined();
    expect(res.results[1].id).toBe("sk-3");
    expect(res.results[1].description).toBeUndefined();
  });

  test("passes a guard/error Response through untouched (no results array to project)", async () => {
    searchResult = { error: "rate_limited", status: 429 };
    const res = await TOOLS.skill_search.impl(AGENT, { task: "x" });
    expect(res).toEqual({ error: "rate_limited", status: 429 });
  });
});

describe("skill_get — read + skill guard", () => {
  test("returns the full skill record, embedding stripped by default", async () => {
    getResult = {
      id: "sk-1",
      agentId: "author-1",
      content: "the full procedure",
      trigger: "when to use",
      tags: ["skill"],
      durability: "persistent",
      createdAt: new Date().toISOString(),
      embedding: [0.1, 0.2],
      embeddingModel: "test-model",
    };
    const res = await TOOLS.skill_get.impl(AGENT, { id: "sk-1" });
    expect(res.id).toBe("sk-1");
    expect(res.content).toBe("the full procedure");
    expect(res.trigger).toBe("when to use");
    expect("embedding" in res).toBe(false);
    expect("embeddingModel" in res).toBe(false);
  });

  test("skill_get never returns embedding even if includeEmbedding is passed (flair#1593)", async () => {
    getResult = {
      id: "sk-1",
      agentId: "a",
      content: "c",
      tags: ["skill"],
      createdAt: "t",
      embedding: [0.1, 0.2],
      embeddingModel: "test-model",
    };
    const res = await TOOLS.skill_get.impl(AGENT, { id: "sk-1", includeEmbedding: true });
    expect(res.content).toBe("c");
    expect("embedding" in res).toBe(false);
    expect("embeddingModel" in res).toBe(false);
  });

  test("skill_get does not advertise includeEmbedding (flair#1593)", () => {
    const props = (TOOLS.skill_get.def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).not.toHaveProperty("includeEmbedding");
  });

  test("a readable NON-skill row is reported not found (skill_get returns only skills)", async () => {
    getResult = { id: "mem-1", agentId: "a", content: "an ordinary memory", tags: ["lesson"], createdAt: "t" };
    const res = await TOOLS.skill_get.impl(AGENT, { id: "mem-1" });
    expect(res).toEqual({ error: "skill not found", status: 404 });
  });

  test("a 404/error Response (unreadable / another agent's private id) passes through", async () => {
    getResult = { error: "not found", status: 404 };
    const res = await TOOLS.skill_get.impl(AGENT, { id: "nope" });
    expect(res.status).toBe(404);
  });
});
