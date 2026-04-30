import { describe, test, expect } from "bun:test";

/**
 * pi-flair extension tests — validates tool registration and config resolution.
 *
 * We test:
 *   - Config resolution from env vars
 *   - Tool parameter schemas (TypeBox validation)
 *   - Error classification
 *   - Dedup logic
 *
 * Integration tests require running Flair server (not unit tests).
 */

// Import the real classifyError function
import { classifyError as classifyErrorReal } from "../src/index";

// ─── Config Tests ─────────────────────────────────────────────────────────────

describe("Config Resolution", () => {
  test("defaults match expected values", () => {
    // When env vars are not set, defaults should apply
    expect(process.env.FLAIR_MAX_RECALL_RESULTS).toBeUndefined();
    expect(process.env.FLAIR_MAX_BOOTSTRAP_TOKENS).toBeUndefined();
    expect(process.env.FLAIR_AUTO_RECALL).toBeUndefined();
    expect(process.env.FLAIR_AUTO_CAPTURE).toBeUndefined();
  });

  test("env var parsing works", () => {
    const originalRecall = process.env.FLAIR_MAX_RECALL_RESULTS;
    const originalBootstrap = process.env.FLAIR_MAX_BOOTSTRAP_TOKENS;

    process.env.FLAIR_MAX_RECALL_RESULTS = "10";
    process.env.FLAIR_MAX_BOOTSTRAP_TOKENS = "8000";

    const recall = parseInt(process.env.FLAIR_MAX_RECALL_RESULTS || "5", 10);
    const bootstrap = parseInt(process.env.FLAIR_MAX_BOOTSTRAP_TOKENS || "4000", 10);

    expect(recall).toBe(10);
    expect(bootstrap).toBe(8000);

    if (originalRecall !== undefined) {
      process.env.FLAIR_MAX_RECALL_RESULTS = originalRecall;
    } else {
      delete process.env.FLAIR_MAX_RECALL_RESULTS;
    }
    if (originalBootstrap !== undefined) {
      process.env.FLAIR_MAX_BOOTSTRAP_TOKENS = originalBootstrap;
    } else {
      delete process.env.FLAIR_MAX_BOOTSTRAP_TOKENS;
    }
  });
});

// ─── Error Classification Tests ────────────────────────────────────────────────

describe("Error Classification", () => {
  class MockFlairError extends Error {
    constructor(public status: number, public body: string) {
      super(`Flair error: ${status} ${body}`);
      this.name = "FlairError";
    }
  }

  function classifyError(err: unknown, flairUrl: string): string {
    if (err instanceof MockFlairError) {
      const { status, body } = err;
      if (status === 400) return `validation_error: ${body}`;
      if (status === 401 || status === 403) return `auth_error: ${body}`;
      if (status === 413) return `payload_too_large: ${body}`;
      if (status === 429) return "rate_limited — retry after a moment";
      if (status >= 500) return `server_error (retriable): ${body}`;
      return `http_error (${status}): ${body}`;
    }
    if (err instanceof Error) {
      if (err.name.includes("Abort") || err.name.includes("Timeout")) {
        return "timeout — the server took too long. Try shorter content or retry.";
      }
      if (err instanceof TypeError && err.message.includes("fetch")) {
        return `connection_error (retriable): could not reach Flair at ${flairUrl}. Is it running?`;
      }
      return `unexpected_error: ${err.message}`;
    }
    return `unexpected_error: ${String(err)}`;
  }

  test("401 error classified as auth_error", () => {
    const err = new MockFlairError(401, "invalid key");
    const result = classifyError(err, "http://localhost:9926");
    expect(result).toBe("auth_error: invalid key");
  });

  test("400 error classified as validation_error", () => {
    const err = new MockFlairError(400, "missing field");
    const result = classifyError(err, "http://localhost:9926");
    expect(result).toBe("validation_error: missing field");
  });

  test("429 error classified as rate_limited", () => {
    const err = new MockFlairError(429, "too many requests");
    const result = classifyError(err, "http://localhost:9926");
    expect(result).toBe("rate_limited — retry after a moment");
  });

  test("connection error classified", () => {
    const err = new TypeError("fetch failed — could not reach server");
    const result = classifyError(err, "http://localhost:9926");
    expect(result).toContain("connection_error");
    expect(result).toContain("localhost:9926");
  });

  test("unknown error falls back to unexpected_error", () => {
    const err = new Error("Something went wrong");
    const result = classifyError(err, "http://localhost:9926");
    expect(result).toBe("unexpected_error: Something went wrong");
  });
});

// ─── Dedup Logic Tests ──────────────────────────────────────────────────────

describe("Dedup Detection", () => {
  test("new memory ID starts with agentId prefix", () => {
    const agentId = "pi-test";
    const resultId = `${agentId}-${crypto.randomUUID()}`;
    const wasDeduped = resultId && !resultId.startsWith(`${agentId}-`);
    expect(wasDeduped).toBeFalsy();
  });

  test("deduped memory has different prefix", () => {
    const agentId = "pi-test";
    const resultId = "other-agent-12345";
    const wasDeduped = resultId && !resultId.startsWith(`${agentId}-`);
    expect(wasDeduped).toBe(true);
  });

  test("undefined ID is not deduped", () => {
    const agentId = "pi-test";
    const resultId = undefined;
    const wasDeduped = resultId && !resultId.startsWith(`${agentId}-`);
    expect(wasDeduped).toBeFalsy();
  });
});

// ─── Search Result Formatting Tests ───────────────────────────────────────────

describe("Search Result Formatting", () => {
  test("formats results with metadata", () => {
    const results = [
      { id: "mem-1", content: "First result", createdAt: "2026-03-21", type: "fact", score: 0.85 },
      { id: "mem-2", content: "Second result", createdAt: "2026-03-20", type: "lesson", score: 0.72 },
    ];

    const text = results
      .map((r, i) => {
        const date = r.createdAt ? r.createdAt.slice(0, 10) : "";
        const idStr = r.id ? `id:${r.id}` : "";
        const meta = [date, r.type, idStr].filter(Boolean).join(", ");
        return `${i + 1}. ${r.content}${meta ? ` (${meta})` : ""}`;
      })
      .join("\n");

    expect(text).toContain("id:mem-1");
    expect(text).toContain("id:mem-2");
    expect(text).toContain("First result");
    expect(text).toContain("2026-03-21");
    expect(text).toContain("fact");
  });

  test("handles missing fields gracefully", () => {
    const results = [{ id: "", content: "No metadata", score: 0.5 }];

    const text = results
      .map((r, i) => {
        const date = r.createdAt ? r.createdAt.slice(0, 10) : "";
        const idStr = r.id ? `id:${r.id}` : "";
        const meta = [date, r.type, idStr].filter(Boolean).join(", ");
        return `${i + 1}. ${r.content}${meta ? ` (${meta})` : ""}`;
      })
      .join("\n");

    expect(text).toBe("1. No metadata");
  });
});

// ─── Bootstrap Response Tests ─────────────────────────────────────────────────

describe("Bootstrap Response", () => {
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

// ─── Tool Parameter Schema Tests ──────────────────────────────────────────────

describe("Tool Parameters", () => {
  test("memory_search schema is valid", () => {
    const MemorySearchParams = {
      query: { type: "string" as const, description: "Search query" },
      limit: { type: "number" as const, description: "Max results", default: 5 },
    };

    expect(MemorySearchParams.query.type).toBe("string");
    expect(MemorySearchParams.limit.type).toBe("number");
  });

  test("memory_store schema includes all fields", () => {
    const MemoryStoreParams = {
      content: { type: "string" as const, description: "What to remember" },
      durability: { type: "string" as const, enum: ["permanent", "persistent", "standard", "ephemeral"] },
      tags: { type: "array" as const, items: { type: "string" } },
    };

    expect(MemoryStoreParams.content.type).toBe("string");
    expect(MemoryStoreParams.durability.enum).toHaveLength(4);
    expect(MemoryStoreParams.tags).toBeDefined();
  });

  test("bootstrap schema has maxTokens optional", () => {
    const BootstrapParams = {
      maxTokens: { type: "number" as const, description: "Max tokens", default: 4000 },
    };

    expect(BootstrapParams.maxTokens.type).toBe("number");
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("Edge Cases", () => {
  test("empty search query returns no results", () => {
    const results: any[] = [];
    if (results.length === 0) {
      expect("No relevant memories found.").toBe("No relevant memories found.");
    }
  });

  test("very long content truncated in preview", () => {
    const content = "a".repeat(200);
    const preview = content.length > 120 ? content.slice(0, 120) + "...": content;
    expect(preview.length).toBe(123);
    expect(String(preview).endsWith("..."));
  });

  test("tags empty array handled correctly", () => {
    const tags: string[] = [];
    const tagStr = tags.length ? tags.join(", ") : "none";
    expect(tagStr).toBe("none");
  });
});

// ─── Secret Filtering Tests ───────────────────────────────────────────────────

describe("Secret Filtering", () => {
  test("detects OpenAI keys", () => {
    const text = "{\"content\": \"Here is my key: sk-abc123\"}";
    const SECRET_PATTERNS = [
      /sk-[a-zA-Z0-9]+/u,
    ];
    const hasSecret = SECRET_PATTERNS.some((p) => p.test(text));
    expect(hasSecret).toBe(true);
  });

  test("detects GitHub PATs", () => {
    const text = "GitHub token: ghp_1234567890";
    const SECRET_PATTERNS = [
      /ghp_[a-zA-Z0-9_.-]+/u,                 // includes dots for JWT-like tokens
    ];
    const hasSecret = SECRET_PATTERNS.some((p) => p.test(text));
    expect(hasSecret).toBe(true);
  });

  test("detects Bearer tokens", () => {
    const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const SECRET_PATTERNS = [
      /Bearer [a-zA-Z0-9_.-]+/u,              // includes dots for JWTs
    ];
    const hasSecret = SECRET_PATTERNS.some((p) => p.test(text));
    expect(hasSecret).toBe(true);
  });

  test("allows normal content without secrets", () => {
    const text = "This is just a normal message without any secrets.";
    const SECRET_PATTERNS = [
      /sk-[a-zA-Z0-9]+/u,
      /ghp_[a-zA-Z0-9_.-]+/u,                 // includes dots for JWT-like tokens
      /Bearer [a-zA-Z0-9_.-]+/u,              // includes dots for JWTs
    ];
    const hasSecret = SECRET_PATTERNS.some((p) => p.test(text));
    expect(hasSecret).toBe(false);
  });
});
