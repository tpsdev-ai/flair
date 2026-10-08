/**
 * agent-id-rule.test.ts — flair#2359. Unit tests for the ONE shared agent-ID
 * rule (src/lib/agent-id-rule.ts) that every Agent create/rename path uses.
 */
import { describe, it, expect } from "bun:test";
import {
  AGENT_ID_ERROR,
  AGENT_ID_PATTERN,
  AGENT_ID_RULE,
  invalidAgentIdMessage,
  isValidAgentId,
} from "../../src/lib/agent-id-rule.js";

describe("flair#2359 — isValidAgentId accepts exactly ^[a-zA-Z0-9_-]{1,64}$", () => {
  it("accepts letters, digits, underscore and hyphen", () => {
    for (const id of ["a", "A9", "agent-1", "a_b", "x".repeat(64)]) {
      expect(isValidAgentId(id), id).toBe(true);
    }
  });

  it("rejects a dot, space, colon, slash, and the empty string", () => {
    for (const id of ["bad.id", "with space", "a:b", "a/b", "", "  "]) {
      expect(isValidAgentId(id), id).toBe(false);
    }
  });

  it("rejects a 65-character id", () => {
    expect(isValidAgentId("a".repeat(65))).toBe(false);
    expect(isValidAgentId("a".repeat(64))).toBe(true);
  });

  it("rejects a non-string, non-number value — null/undefined never become \"null\"/\"undefined\"", () => {
    for (const id of [null, undefined, {}, [], true]) {
      expect(isValidAgentId(id), String(id)).toBe(false);
    }
  });

  it("the exported pattern and rule text agree", () => {
    expect(AGENT_ID_PATTERN.test("agent-1")).toBe(true);
    expect(AGENT_ID_RULE).toBe("^[a-zA-Z0-9_-]{1,64}$");
  });

  it("the refusal message names the rule and the value", () => {
    const message = invalidAgentIdMessage("bad.id");
    expect(message).toContain(AGENT_ID_RULE);
    expect(message).toContain("bad.id");
  });

  it("the named error constant is stable", () => {
    expect(AGENT_ID_ERROR).toBe("invalid_agent_id");
  });
});
