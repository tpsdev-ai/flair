import { describe, expect, test } from "bun:test";
import { mcpServerSpec } from "../../src/cli.js";

// The MCP server spec is what gets written into a user's client config and
// re-resolved by npx on every agent session. An unpinned spec means any future
// publish reaches every wired user silently — the postmark-mcp shape. These
// tests pin that property, not the formatting.
describe("mcpServerSpec — the wired MCP server reference", () => {
  test("pins to the given version so a later publish cannot silently propagate", () => {
    expect(mcpServerSpec("0.28.0")).toBe("@tpsdev-ai/flair-mcp@0.28.0");
  });

  test("is never the bare unpinned package when a version is known", () => {
    // The regression that matters: reverting to `@tpsdev-ai/flair-mcp` with no
    // version restores silent auto-update for everyone already wired.
    expect(mcpServerSpec("1.2.3")).not.toBe("@tpsdev-ai/flair-mcp");
    expect(mcpServerSpec("1.2.3")).toContain("@1.2.3");
  });

  test("falls back to unpinned only when the version is unreadable", () => {
    // Same condition under which `--version` reports "unknown" — a broken
    // install, where a working wiring beats a precise pin.
    expect(mcpServerSpec("unknown")).toBe("@tpsdev-ai/flair-mcp");
    expect(mcpServerSpec("")).toBe("@tpsdev-ai/flair-mcp");
  });
});
