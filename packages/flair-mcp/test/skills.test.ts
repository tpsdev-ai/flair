import { describe, expect, test } from "bun:test";
import {
  SKILL_TAG,
  buildSkillSearchBody,
  buildSkillStoreBody,
  formatSkillCatalog,
  isSkillRecord,
  projectSkillCard,
  projectSkillSearchResponse,
  stripInternalMemoryFields,
} from "../src/skills.ts";

describe("skill store body (stdio → Memory PUT)", () => {
  test("prepends the skill tag and omits durability (server forces persistent)", () => {
    const { id, body } = buildSkillStoreBody({
      agentId: "flint",
      content: "the procedure",
      trigger: "when resizing",
      name: "resize-image",
      description: "Resize before upload",
      tags: ["images"],
      claimedClient: "claude-code",
    });
    expect(id.startsWith("flint-")).toBe(true);
    expect(body.id).toBe(id);
    expect(body.agentId).toBe("flint");
    expect(body.content).toBe("the procedure");
    expect(body.trigger).toBe("when resizing");
    expect(body.tags).toEqual([SKILL_TAG, "images"]);
    expect(body.claimedClient).toBe("claude-code");
    expect(JSON.parse(body.metadata as string)).toEqual({
      name: "resize-image",
      description: "Resize before upload",
    });
    expect(body).not.toHaveProperty("durability");
  });

  test("does not invent metadata or claimedClient when omitted", () => {
    const { body } = buildSkillStoreBody({ agentId: "a", content: "c" });
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("claimedClient");
    expect(body).not.toHaveProperty("trigger");
    expect(body.tags).toEqual([SKILL_TAG]);
  });
});

describe("skill search body", () => {
  test("rides SemanticSearch with skill tag-seek, task as q, and trigger/metadata opts", () => {
    expect(buildSkillSearchBody({ task: "resize an image", limit: 3 })).toEqual({
      q: "resize an image",
      tag: SKILL_TAG,
      limit: 3,
      includeMetadata: true,
      includeTrigger: true,
    });
  });

  test("defaults limit to 5 and forwards NO body agentId", () => {
    const body = buildSkillSearchBody({ task: "anything" });
    expect(body.limit).toBe(5);
    expect(body).not.toHaveProperty("agentId");
  });
});

describe("skill catalog projection (progressive disclosure)", () => {
  const row = {
    id: "sk-1",
    agentId: "author-1",
    trigger: "when resizing an image",
    content: "THE FULL PROCEDURE — must not appear on the card",
    tags: ["skill", "images"],
    metadata: JSON.stringify({ name: "resize-image", description: "Resize an image to a max dimension" }),
    embedding: [0.1, 0.2, 0.3],
    embeddingModel: "test-model",
    visibility: "shared",
  };

  test("returns only id/name/trigger/description/tags/agentId", () => {
    const card = projectSkillCard(row);
    expect(new Set(Object.keys(card))).toEqual(new Set(["id", "name", "trigger", "description", "tags", "agentId"]));
    expect(card.id).toBe("sk-1");
    expect(card.name).toBe("resize-image");
    expect(card.description).toBe("Resize an image to a max dimension");
    expect("content" in card).toBe(false);
    expect("embedding" in card).toBe(false);
  });

  test("corrupt/absent metadata still projects (name/description simply absent)", () => {
    expect(projectSkillCard({ id: "sk-2", metadata: "{not json" }).name).toBeUndefined();
    expect(projectSkillCard({ id: "sk-3" }).description).toBeUndefined();
  });

  test("projectSkillSearchResponse maps results and passes a guard payload through", () => {
    const ok = projectSkillSearchResponse({ results: [row], _warning: "x" }) as { results: Array<Record<string, unknown>>; _warning: string };
    expect(ok._warning).toBe("x");
    expect("content" in ok.results[0]).toBe(false);
    expect(projectSkillSearchResponse({ error: "rate_limited", status: 429 })).toEqual({
      error: "rate_limited",
      status: 429,
    });
  });

  test("formatSkillCatalog lists name, trigger, id — never the procedure", () => {
    const text = formatSkillCatalog([projectSkillCard(row)]);
    expect(text).toContain("resize-image");
    expect(text).toContain("id:sk-1");
    expect(text).not.toContain("THE FULL PROCEDURE");
    expect(formatSkillCatalog([])).toBe("No matching skills found.");
  });
});

describe("skill_get guards", () => {
  test("isSkillRecord is the skill tag, not a general reader", () => {
    expect(isSkillRecord({ tags: ["skill"] })).toBe(true);
    expect(isSkillRecord({ tags: ["lesson"] })).toBe(false);
    expect(isSkillRecord({ content: "x" })).toBe(false);
  });

  test("stripInternalMemoryFields drops embedding fields and keeps content", () => {
    const stripped = stripInternalMemoryFields({
      id: "sk-1",
      content: "the full procedure",
      embedding: [0.1],
      embeddingModel: "m",
    });
    expect(stripped.content).toBe("the full procedure");
    expect("embedding" in stripped).toBe(false);
    expect("embeddingModel" in stripped).toBe(false);
  });
});
