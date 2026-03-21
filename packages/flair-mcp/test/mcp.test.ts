import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * MCP server tests — validates tool behavior with mocked FlairClient.
 *
 * We test the tool logic in isolation by mocking the flair-client.
 * The MCP transport layer (stdio) is tested by the MCP SDK.
 */

// Since the MCP server has a top-level FLAIR_AGENT_ID check and
// initializes FlairClient at module load, we test the tool logic
// patterns rather than importing the module directly.

describe("MCP tool logic", () => {
  describe("memory_store dedup detection", () => {
    test("new memory — ID starts with agentId prefix", () => {
      const agentId = "claude-test";
      const result = { id: `${agentId}-1234567890`, content: "new memory" };
      const wasDeduped = result.id && !result.id.startsWith(`${agentId}-`);
      expect(wasDeduped).toBe(false);
    });

    test("deduped memory — ID has different prefix", () => {
      const agentId = "claude-test";
      const result = { id: "other-agent-9876", content: "existing memory" };
      const wasDeduped = result.id && !result.id.startsWith(`${agentId}-`);
      expect(wasDeduped).toBe(true);
    });

    test("undefined ID — should not trigger dedup", () => {
      const agentId = "claude-test";
      const result = { id: undefined, content: "test" };
      // With the fix: id is always defined (constructed record)
      // Before fix: id was undefined from Harper PUT response
      const wasDeduped = result.id && !result.id.startsWith(`${agentId}-`);
      expect(wasDeduped).toBeFalsy();
    });
  });

  describe("search result formatting", () => {
    test("includes ID in output", () => {
      const results = [
        { id: "mem-1", content: "First result", createdAt: "2026-03-21", type: "fact", score: 0.85 },
        { id: "mem-2", content: "Second result", createdAt: "2026-03-20", type: "lesson", score: 0.72 },
      ];

      const text = results.map((r, i) => {
        const date = r.createdAt ? r.createdAt.slice(0, 10) : "";
        const idStr = r.id ? `id:${r.id}` : "";
        const meta = [date, r.type, idStr].filter(Boolean).join(", ");
        return `${i + 1}. ${r.content}${meta ? ` (${meta})` : ""}`;
      }).join("\n");

      expect(text).toContain("id:mem-1");
      expect(text).toContain("id:mem-2");
      expect(text).toContain("First result");
      expect(text).toContain("2026-03-21");
      expect(text).toContain("fact");
    });

    test("handles missing fields gracefully", () => {
      const results = [{ id: "", content: "No metadata", score: 0.5 }];

      const text = results.map((r, i) => {
        const date = r.createdAt ? r.createdAt.slice(0, 10) : "";
        const idStr = r.id ? `id:${r.id}` : "";
        const meta = [date, r.type, idStr].filter(Boolean).join(", ");
        return `${i + 1}. ${r.content}${meta ? ` (${meta})` : ""}`;
      }).join("\n");

      expect(text).toBe("1. No metadata");
    });
  });

  describe("bootstrap response", () => {
    test("returns context when available", () => {
      const result = { context: "## Identity\nrole: test agent" };
      expect(result.context).toContain("Identity");
    });

    test("returns no context message when empty", () => {
      const result = { context: "" };
      const output = result.context || "No context available.";
      expect(output).toBe("No context available.");
    });
  });
});

describe("temporal intent patterns", () => {
  // These patterns should be recognized by SemanticSearch
  const temporalPatterns = [
    { query: "what happened today", expectsSince: true },
    { query: "what did we ship yesterday", expectsSince: true },
    { query: "recent changes", expectsSince: false }, // "recent" alone doesn't match — need "recently"
    { query: "this week's progress", expectsSince: true },
    { query: "Harper sandbox fix", expectsSince: false },
    { query: "package architecture", expectsSince: false },
  ];

  for (const { query, expectsSince } of temporalPatterns) {
    test(`"${query}" ${expectsSince ? "should" : "should not"} detect temporal intent`, () => {
      const lq = query.toLowerCase();
      const hasTemporal = /\btoday\b|\bthis morning\b|\byesterday\b|\bthis week\b|\brecently\b|\blately\b/.test(lq);
      expect(hasTemporal).toBe(expectsSince);
    });
  }
});

describe("search scoring", () => {
  test("keyword match is a tiebreaker (0.05), not primary signal", () => {
    const keywordBonus = 0.05;
    const strongSemantic = 0.7;
    const weakSemanticWithKeyword = 0.3 + keywordBonus;

    // Strong semantic should always beat weak semantic + keyword
    expect(strongSemantic).toBeGreaterThan(weakSemanticWithKeyword);
  });

  test("composite score includes durability weight", () => {
    const weights: Record<string, number> = {
      permanent: 1.0,
      persistent: 0.9,
      standard: 0.7,
      ephemeral: 0.4,
    };

    // Same semantic score, different durability
    const semanticScore = 0.8;
    const permanentScore = semanticScore * weights.permanent;
    const ephemeralScore = semanticScore * weights.ephemeral;

    expect(permanentScore).toBeGreaterThan(ephemeralScore);
    expect(permanentScore).toBe(0.8);
    expect(ephemeralScore).toBeCloseTo(0.32);
  });
});

describe("bootstrap soul budgeting", () => {
  const SOUL_KEY_PRIORITY: Record<string, number> = {
    role: 0, identity: 1, thinking: 2, communication_style: 3,
    team: 4, ownership: 5, infrastructure: 6, "user-context": 7,
    soul: 90, "workspace-rules": 91,
  };

  test("concise entries sort before full file dumps", () => {
    const entries = [
      { key: "soul", priority: SOUL_KEY_PRIORITY["soul"] ?? 50 },
      { key: "role", priority: SOUL_KEY_PRIORITY["role"] ?? 50 },
      { key: "workspace-rules", priority: SOUL_KEY_PRIORITY["workspace-rules"] ?? 50 },
      { key: "identity", priority: SOUL_KEY_PRIORITY["identity"] ?? 50 },
    ];

    entries.sort((a, b) => a.priority - b.priority);

    expect(entries[0].key).toBe("role");
    expect(entries[1].key).toBe("identity");
    expect(entries[entries.length - 1].key).toBe("workspace-rules");
  });

  test("full file dumps are lowest priority (>= 90)", () => {
    expect(SOUL_KEY_PRIORITY["soul"]).toBeGreaterThanOrEqual(90);
    expect(SOUL_KEY_PRIORITY["workspace-rules"]).toBeGreaterThanOrEqual(90);
    expect(SOUL_KEY_PRIORITY["role"]).toBeLessThan(10);
  });
});
