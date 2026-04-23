import { describe, test, expect } from "bun:test";
import { evaluatePredicate } from "../../src/bridges/runtime/predicate";

describe("predicate: in", () => {
  test("matches a string in a list of bare identifiers", () => {
    expect(evaluatePredicate("durability in [persistent, permanent]", { durability: "persistent" })).toBe("match");
    expect(evaluatePredicate("durability in [persistent, permanent]", { durability: "ephemeral" })).toBe("no-match");
  });

  test("matches with single-quoted strings (agentic-stack form)", () => {
    expect(evaluatePredicate("durability in ['persistent', 'permanent']", { durability: "persistent" })).toBe("match");
    expect(evaluatePredicate("durability in ['persistent', 'permanent']", { durability: "ephemeral" })).toBe("no-match");
  });

  test("matches with double-quoted strings", () => {
    expect(evaluatePredicate(`tag in ["a", "b"]`, { tag: "b" })).toBe("match");
  });

  test("missing field is no-match", () => {
    expect(evaluatePredicate("durability in [persistent]", {})).toBe("no-match");
  });

  test("empty list is no-match for any value", () => {
    expect(evaluatePredicate("durability in []", { durability: "persistent" })).toBe("no-match");
  });
});

describe("predicate: == and !=", () => {
  test("== with string literal", () => {
    expect(evaluatePredicate(`durability == 'persistent'`, { durability: "persistent" })).toBe("match");
    expect(evaluatePredicate(`durability == 'persistent'`, { durability: "ephemeral" })).toBe("no-match");
  });

  test("!= inverts ==", () => {
    expect(evaluatePredicate(`durability != 'persistent'`, { durability: "ephemeral" })).toBe("match");
    expect(evaluatePredicate(`durability != 'persistent'`, { durability: "persistent" })).toBe("no-match");
  });

  test("== with bare identifier (treated as string)", () => {
    expect(evaluatePredicate("durability == persistent", { durability: "persistent" })).toBe("match");
  });

  test("== with number literal", () => {
    expect(evaluatePredicate("retrievalCount == 0", { retrievalCount: 0 })).toBe("match");
    expect(evaluatePredicate("retrievalCount == 1", { retrievalCount: 0 })).toBe("no-match");
  });
});

describe("predicate: empty + unparsable", () => {
  test("empty expression matches (always-export)", () => {
    expect(evaluatePredicate("", { durability: "persistent" })).toBe("match");
    expect(evaluatePredicate("   ", { durability: "persistent" })).toBe("match");
  });

  test("unsupported operators return unparsable", () => {
    expect(evaluatePredicate("durability && permanent", { durability: "persistent" })).toBe("unparsable");
    expect(evaluatePredicate("(durability == persistent)", { durability: "persistent" })).toBe("unparsable");
  });

  test("malformed list returns unparsable", () => {
    expect(evaluatePredicate("durability in [persistent", { durability: "persistent" })).toBe("unparsable");
  });
});
