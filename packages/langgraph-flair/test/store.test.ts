import { describe, it, expect } from "bun:test";
import { parseStoredId, hasNamespacePrefix } from "../src/index";

describe("langgraph-flair: parseStoredId", () => {
  it("parses a basic id", () => {
    const result = parseStoredId("lg:agent1:users/profiles:user123", "agent1");
    expect(result).toEqual({ namespace: ["users", "profiles"], key: "user123" });
  });

  it("parses an id with single-segment namespace", () => {
    const result = parseStoredId("lg:agent1:docs:report1", "agent1");
    expect(result).toEqual({ namespace: ["docs"], key: "report1" });
  });

  it("parses an id with empty namespace", () => {
    const result = parseStoredId("lg:agent1::orphan", "agent1");
    expect(result).toEqual({ namespace: [], key: "orphan" });
  });

  it("returns null for ids that don't match the lg: prefix", () => {
    expect(parseStoredId("flint-1234", "agent1")).toBeNull();
    expect(parseStoredId("lg:other-agent:users:u1", "agent1")).toBeNull();
  });

  it("preserves slashes inside the key portion correctly", () => {
    // The split is on the LAST colon — keys cannot contain colons but can
    // contain slashes (which we don't interpret).
    const result = parseStoredId("lg:agent1:a/b/c:my/key/with/slashes", "agent1");
    expect(result).toEqual({
      namespace: ["a", "b", "c"],
      key: "my/key/with/slashes",
    });
  });

  it("handles deep namespaces", () => {
    const result = parseStoredId("lg:agent1:a/b/c/d/e:k", "agent1");
    expect(result?.namespace).toEqual(["a", "b", "c", "d", "e"]);
    expect(result?.key).toBe("k");
  });
});

describe("langgraph-flair: hasNamespacePrefix", () => {
  it("matches an exact namespace", () => {
    expect(hasNamespacePrefix(["users", "profiles"], ["users", "profiles"])).toBe(true);
  });

  it("matches a shorter prefix", () => {
    expect(hasNamespacePrefix(["users", "profiles", "u123"], ["users"])).toBe(true);
    expect(hasNamespacePrefix(["users", "profiles", "u123"], ["users", "profiles"])).toBe(true);
  });

  it("rejects a longer prefix", () => {
    expect(hasNamespacePrefix(["users"], ["users", "profiles"])).toBe(false);
  });

  it("rejects mismatched labels", () => {
    expect(hasNamespacePrefix(["users", "profiles"], ["docs"])).toBe(false);
    expect(hasNamespacePrefix(["users", "profiles"], ["users", "docs"])).toBe(false);
  });

  it("matches empty prefix against any namespace (search-all semantics)", () => {
    expect(hasNamespacePrefix(["users", "profiles"], [])).toBe(true);
    expect(hasNamespacePrefix([], [])).toBe(true);
  });

  it("rejects empty namespace against a non-empty prefix", () => {
    expect(hasNamespacePrefix([], ["users"])).toBe(false);
  });
});
