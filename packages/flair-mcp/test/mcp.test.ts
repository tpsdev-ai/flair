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

describe("coordination write surface (flair_workspace_set / flair_orgevent)", () => {
  // The tools attribute writes from the SIGNED identity (flair.request signs with
  // the agent's Ed25519 key), so the request BODY must never carry agentId /
  // authorId — including those would let a body forge another agent's record.
  // These tests pin the body-construction the tools perform (the same logic in
  // src/index.ts), mirroring the in-isolation style of the rest of this file.

  function buildWorkspaceBody(agentId: string, opts: { ref: string; label?: string; provider?: string; task?: string; phase?: string; summary?: string }) {
    const body: Record<string, unknown> = {
      id: `${agentId}:${opts.ref}`,
      ref: opts.ref,
      provider: opts.provider ?? "mcp",
      timestamp: new Date().toISOString(),
    };
    if (opts.label) body.label = opts.label;
    if (opts.task) body.taskId = opts.task;
    if (opts.phase) body.phase = opts.phase;
    if (opts.summary) body.summary = opts.summary;
    return body;
  }

  function buildOrgEventBody(opts: { kind: string; summary: string; detail?: string; scope?: string; targets?: string[] }) {
    const body: Record<string, unknown> = { kind: opts.kind, summary: opts.summary };
    if (opts.detail) body.detail = opts.detail;
    if (opts.scope) body.scope = opts.scope;
    if (opts.targets && opts.targets.length > 0) body.targetIds = opts.targets;
    return body;
  }

  test("flair_workspace_set body never carries agentId (no forging — attribute from signature)", () => {
    const body = buildWorkspaceBody("agent-alpha", { ref: "main", phase: "implement", task: "cp7-implement-task" });
    expect(body).not.toHaveProperty("agentId");
    expect(body.ref).toBe("main");
    expect(body.phase).toBe("implement");
    expect(body.taskId).toBe("cp7-implement-task");
    expect(body.provider).toBe("mcp");
  });

  test("flair_orgevent body never carries authorId (no forging — attribute from signature)", () => {
    const body = buildOrgEventBody({ kind: "coord.claim", summary: "claim", targets: ["anvil", "ember"] });
    expect(body).not.toHaveProperty("authorId");
    expect(body.kind).toBe("coord.claim");
    expect(body.targetIds).toEqual(["anvil", "ember"]);
  });

  test("flair_orgevent omits optional fields when absent", () => {
    const body = buildOrgEventBody({ kind: "status", summary: "alive" });
    expect(body).not.toHaveProperty("detail");
    expect(body).not.toHaveProperty("scope");
    expect(body).not.toHaveProperty("targetIds");
  });
});

describe("auto-presence (flair#598) — bootstrap wiring in index.ts", () => {
  // index.ts's `bootstrap` tool handler does two things before calling
  // flair.bootstrap(): `if (currentTask) lastKnownTask = currentTask;` then
  // `heartbeat(deriveActivity({ channel, surface }))`. runMcp() has
  // module-level side effects (FLAIR_AGENT_ID check, process.exit, stdio
  // connect) so it isn't imported directly here — same reason the rest of
  // this file tests logic snippets rather than the wired server. This pins
  // the lastKnownTask truthy-check specifically (presence.ts's own unit
  // tests, packages/flair-mcp/test/presence.test.ts, cover deriveActivity/
  // shouldSendHeartbeat/postPresenceSafe directly against the real module).

  test("lastKnownTask is set when bootstrap is called with a currentTask", () => {
    let lastKnownTask: string | undefined;
    function onBootstrapCall(currentTask?: string) {
      if (currentTask) lastKnownTask = currentTask;
    }
    onBootstrapCall("flair#598");
    expect(lastKnownTask).toBe("flair#598");
  });

  test("a LATER bootstrap call with no currentTask does not clear a previously-known task", () => {
    let lastKnownTask: string | undefined = "flair#598";
    function onBootstrapCall(currentTask?: string) {
      if (currentTask) lastKnownTask = currentTask;
    }
    onBootstrapCall(undefined);
    expect(lastKnownTask).toBe("flair#598");
  });

  test("an empty-string currentTask does not overwrite a previously-known task (truthy check, not undefined check)", () => {
    let lastKnownTask: string | undefined = "flair#598";
    function onBootstrapCall(currentTask?: string) {
      if (currentTask) lastKnownTask = currentTask;
    }
    onBootstrapCall("");
    expect(lastKnownTask).toBe("flair#598");
  });

  test("lastKnownTask starts undefined — no task is invented before bootstrap ever supplies one", () => {
    let lastKnownTask: string | undefined;
    expect(lastKnownTask).toBeUndefined();
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
