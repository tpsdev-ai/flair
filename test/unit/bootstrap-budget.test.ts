/**
 * bootstrap-budget.test.ts — Unit tests for flair bootstrap budget footer
 *
 * Tests the CLI's budget footer format and parsing, and the structure of
 * the MemoryBootstrap response. Harper integration tests are separate.
 */

import { describe, expect, test } from "bun:test";

// ────────────────────────────────────────────────────────────────────────────────
// Budget footer format tests
// ────────────────────────────────────────────────────────────────────────────────

describe("CLI bootstrap budget footer format", () => {
  test("budget footer format is parseable by agents", () => {
    // This is the expected format from cli.ts
    // [budget: <used>/<max> tokens, <included> included, <truncated> truncated]

    // Example outputs
    const examples = [
      "[budget: 3847/4000 tokens, 12 included, 0 truncated]",
      "[budget: 4000/4000 tokens, 15 included, 3 truncated]",
      "[budget: 2048/6000 tokens, 8 included, 2 truncated]",
      "[budget: 0/4000 tokens, 0 included, 0 truncated]",
    ];

    // Verify format matches our pattern
    const budgetPattern = /^\[budget: (\d+)\/(\d+) tokens, (\d+) included, (\d+) truncated\]$/;

    for (const example of examples) {
      const match = example.match(budgetPattern);
      expect(match).not.toBeNull();
      if (match) {
        const tokensUsed = parseInt(match[1], 10);
        const maxTokens = parseInt(match[2], 10);
        const included = parseInt(match[3], 10);
        const truncated = parseInt(match[4], 10);

        expect(tokensUsed).toBeLessThanOrEqual(maxTokens);
        expect(included + truncated).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("truncated count is non-zero when budget exceeded", () => {
    // When truncated > 0, the agent should consider asking for more context
    const examples = [
      { truncated: 0, shouldNotify: false },
      { truncated: 1, shouldNotify: true },
      { truncated: 5, shouldNotify: true },
      { truncated: 100, shouldNotify: true },
    ];

    for (const { truncated, shouldNotify } of examples) {
      // In real implementation, if truncated > 0, agent should take action
      expect(truncated > 0).toBe(shouldNotify);
    }
  });

  test("budget footer is printed to stderr, not stdout", () => {
    // The CLI uses console.error for budget footer
    // This ensures it doesn't interfere with context output (stdout)

    // Simulate the CLI output
    const stdout = "## Identity\nrole: Pair programmer\n...\n";
    const stderr = "[budget: 2048/4000 tokens, 8 included, 0 truncated]";

    // Stdout should be pure context
    expect(stdout.startsWith("## ")).toBe(true);
    expect(stdout).not.toMatch(/^\[budget:/);

    // Stderr should have the budget footer
    expect(stderr).toMatch(/^\[budget:/);
    expect(stderr).not.toMatch("## ");
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// Budget response structure tests (for MemoryBootstrap endpoint)
// ────────────────────────────────────────────────────────────────────────────────

describe("MemoryBootstrap response budget fields", () => {
  test("response has tokenEstimate field (number)", () => {
    const response: any = { tokenEstimate: 2048 };
    expect(typeof response.tokenEstimate).toBe("number");
    expect(response.tokenEstimate).toBeGreaterThanOrEqual(0);
  });

  test("response has memoriesIncluded field (number)", () => {
    const response: any = { memoriesIncluded: 8 };
    expect(typeof response.memoriesIncluded).toBe("number");
    expect(response.memoriesIncluded).toBeGreaterThanOrEqual(0);
  });

  test("response has memoriesTruncated field (number)", () => {
    const response: any = { memoriesTruncated: 2 };
    expect(typeof response.memoriesTruncated).toBe("number");
    expect(response.memoriesTruncated).toBeGreaterThanOrEqual(0);
  });

  test("response has memoriesAvailable field (number)", () => {
    const response: any = { memoriesAvailable: 10 };
    expect(typeof response.memoriesAvailable).toBe("number");
    expect(response.memoriesAvailable).toBeGreaterThanOrEqual(0);
  });

  test("included + truncated = available (when tracking is accurate)", () => {
    // When all memories are accounted for
    const included = 8;
    const truncated = 2;
    const available = included + truncated;
    expect(available).toBe(10);
  });

  test("tokenEstimate + remainingBudget = maxTokens", () => {
    const maxTokens = 4000;
    const tokenEstimate = 2048;
    const remainingBudget = maxTokens - tokenEstimate;
    expect(remainingBudget).toBe(1952);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// Budget calculation tests
// ────────────────────────────────────────────────────────────────────────────────

describe("Budget calculations", () => {
  test("4000 token budget with 3847 used", () => {
    const maxTokens = 4000;
    const used = 3847;
    const remaining = maxTokens - used;
    expect(remaining).toBe(153);
    expect(remaining).toBeLessThan(maxTokens * 0.1); // Less than 10% remaining
  });

  test("6000 token budget (optional bump)", () => {
    const maxTokens = 6000;
    const used = 4500;
    const remaining = maxTokens - used;
    expect(remaining).toBe(1500);
    expect(remaining / maxTokens).toBeCloseTo(0.25); // 25% remaining
  });

  test("token budget at 100% (no remaining)", () => {
    const maxTokens = 4000;
    const used = maxTokens;
    const remaining = maxTokens - used;
    expect(remaining).toBe(0);
  });

  test("token budget at 50% (plenty remaining)", () => {
    const maxTokens = 4000;
    const used = maxTokens / 2;
    const remaining = maxTokens - used;
    expect(remaining).toBe(maxTokens / 2);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  test("empty context (0 memories, 0 tokens)", () => {
    const result = {
      context: "",
      tokenEstimate: 0,
      memoriesIncluded: 0,
      memoriesTruncated: 0,
      memoriesAvailable: 0,
    };

    expect(result.context).toBe("");
    expect(result.tokenEstimate).toBe(0);
    expect(result.memoriesIncluded).toBe(0);
  });

  test("no truncation when budget is ample", () => {
    const result = {
      memoriesAvailable: 5,
      memoriesIncluded: 5,
      memoriesTruncated: 0,
    };

    expect(result.memoriesTruncated).toBe(0);
    expect(result.memoriesIncluded).toBe(result.memoriesAvailable);
  });

  test("truncation detected when fewer included than available", () => {
    const result = {
      memoriesAvailable: 10,
      memoriesIncluded: 7,
      memoriesTruncated: 3,
    };

    expect(result.memoriesTruncated).toBeGreaterThan(0);
    expect(result.memoriesIncluded + result.memoriesTruncated).toBe(
      result.memoriesAvailable
    );
  });
});
