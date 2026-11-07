/**
 * agent-id-rule.test.ts — flair#2359. Unit tests for the ONE shared agent-ID
 * rule (src/lib/agent-id-rule.ts) that the Agent create paths use.
 */
import { describe, it, expect } from "bun:test";
import {
  AGENT_ID_ERROR,
  AGENT_ID_PATTERN,
  AGENT_ID_RULE,
  AGENT_ID_STRING_REMEDY,
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

  it("gives an integral number outside the safe range the string remedy", () => {
    const rounded = Number("9007199254740993"); // 9007199254740992, not round-trippable
    expect(Number.isSafeInteger(rounded)).toBe(false);
    expect(isValidAgentId(rounded)).toBe(false);
    expect(invalidAgentIdMessage(rounded)).toBe(AGENT_ID_STRING_REMEDY);
    expect(invalidAgentIdMessage(2 ** 53)).toBe(AGENT_ID_STRING_REMEDY);
    expect(invalidAgentIdMessage(9007199254740993n)).toBe(AGENT_ID_STRING_REMEDY);
  });

  it("gives a fractional number the ordinary rule refusal, not the string remedy", () => {
    expect(isValidAgentId(1.5)).toBe(false);
    const message = invalidAgentIdMessage(1.5);
    expect(message).not.toBe(AGENT_ID_STRING_REMEDY);
    expect(message).toContain(AGENT_ID_RULE);
    expect(message).toContain("1.5");
  });

  it("shows a non-finite number as-is, not null", () => {
    for (const id of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const message = invalidAgentIdMessage(id);
      expect(isValidAgentId(id), String(id)).toBe(false);
      expect(message, String(id)).toContain(String(id));
      expect(message, String(id)).not.toContain("null");
    }
  });

  it("reports a circular or throwing-toJSON object by type, with no string remedy", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const throwing = {
      toJSON() {
        throw new Error("not serializable");
      },
    };
    for (const id of [circular, throwing]) {
      const message = invalidAgentIdMessage(id);
      expect(message).toContain("an object that cannot be serialized");
      expect(message).toContain(AGENT_ID_RULE);
      expect(message).not.toContain(AGENT_ID_STRING_REMEDY);
    }
  });

  it("names a function or a toJSON returning undefined by type, not undefined", () => {
    const func = () => "x";
    const nullingToJSON = { toJSON: () => undefined };
    const funcMessage = invalidAgentIdMessage(func);
    expect(funcMessage).toContain("a function that cannot be serialized");
    expect(funcMessage).not.toContain("undefined");
    const objectMessage = invalidAgentIdMessage(nullingToJSON);
    expect(objectMessage).toContain("an object that cannot be serialized");
    expect(objectMessage).not.toContain("undefined");
  });

  it("shows a Symbol as String(id), not undefined", () => {
    const id = Symbol("x");
    const message = invalidAgentIdMessage(id);
    expect(isValidAgentId(id)).toBe(false);
    expect(message).toContain("Symbol(x)");
    expect(message).not.toContain("undefined");
  });

  it("shows a JSON value through JSON.stringify", () => {
    expect(invalidAgentIdMessage("with space")).toContain(JSON.stringify("with space"));
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
