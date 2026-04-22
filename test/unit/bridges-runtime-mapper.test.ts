import { describe, test, expect } from "bun:test";
import { applyMap, evaluate } from "../../src/bridges/runtime/mapper";

describe("mapper: evaluate", () => {
  test("$.field returns a root-level value", () => {
    expect(evaluate("$.name", { name: "alice" })).toBe("alice");
  });

  test("$.nested.field walks dotted paths", () => {
    expect(evaluate("$.a.b.c", { a: { b: { c: 42 } } })).toBe(42);
  });

  test("$.missing returns undefined", () => {
    expect(evaluate("$.missing", { present: 1 })).toBeUndefined();
  });

  test("$.a.b returns undefined when parent is not an object", () => {
    expect(evaluate("$.a.b", { a: 42 })).toBeUndefined();
  });

  test("$.arr[*] returns the whole array", () => {
    expect(evaluate("$.arr[*]", { arr: [1, 2, 3] })).toEqual([1, 2, 3]);
  });

  test("$.arr[1] returns a specific index", () => {
    expect(evaluate("$.arr[1]", { arr: ["a", "b", "c"] })).toBe("b");
  });

  test("$.arr[1].name supports path after index", () => {
    expect(evaluate("$.arr[1].name", { arr: [{ name: "a" }, { name: "b" }] })).toBe("b");
  });

  test("$ alone returns the whole record", () => {
    const r = { a: 1 };
    expect(evaluate("$", r)).toBe(r);
  });

  test("literal (no $ prefix) is returned as a constant string", () => {
    expect(evaluate("persistent", { a: 1 })).toBe("persistent");
  });

  test("malformed path fails gracefully (returns undefined)", () => {
    expect(evaluate("$.a[", { a: [1] })).toBeUndefined();
  });

  test("non-string expression returns undefined", () => {
    expect(evaluate(42 as any, { a: 1 })).toBeUndefined();
  });
});

describe("mapper: applyMap", () => {
  test("maps each field through its expression", () => {
    const out = applyMap(
      { content: "$.claim", subject: "$.topic", source: "agentic-stack/lessons" },
      { claim: "Always run tests", topic: "engineering", id: "x1" },
    );
    expect(out).toEqual({
      content: "Always run tests",
      subject: "engineering",
      source: "agentic-stack/lessons",
    });
  });

  test("drops entries whose expression resolves to undefined", () => {
    const out = applyMap(
      { content: "$.claim", subject: "$.topic" },
      { claim: "only content" },
    );
    expect(out).toEqual({ content: "only content" });
    expect(out.subject).toBeUndefined();
  });

  test("drops empty-string results", () => {
    const out = applyMap({ content: "$.c", subject: "$.s" }, { c: "x", s: "" });
    expect(out).toEqual({ content: "x" });
  });

  test("preserves array values", () => {
    const out = applyMap({ tags: "$.tags[*]" }, { tags: ["a", "b"] });
    expect(out.tags).toEqual(["a", "b"]);
  });
});
