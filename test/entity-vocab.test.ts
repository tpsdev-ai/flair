import { describe, test, expect } from "bun:test";
import {
  ENTITY_TYPES,
  isEntityType,
  parseEntity,
  isValidEntity,
  validateEntities,
  invalidEntitiesResponse,
} from "../resources/entity-vocab";

describe("entity vocabulary — closed type set", () => {
  test("ENTITY_TYPES is exactly the documented six", () => {
    expect([...ENTITY_TYPES].sort()).toEqual(
      ["agent", "customer", "issue", "person", "repo", "subsystem"].sort(),
    );
  });

  test("isEntityType accepts known types", () => {
    for (const t of ENTITY_TYPES) expect(isEntityType(t)).toBe(true);
  });

  test("isEntityType rejects unknown / uppercase types", () => {
    expect(isEntityType("project")).toBe(false);
    expect(isEntityType("Repo")).toBe(false);
    expect(isEntityType("")).toBe(false);
  });
});

describe("parseEntity", () => {
  test("splits on the first colon", () => {
    expect(parseEntity("repo:tpsdev-ai/flair")).toEqual({ type: "repo", value: "tpsdev-ai/flair" });
  });

  test("splits on the FIRST colon only (value may not contain one, but parse doesn't over-split)", () => {
    expect(parseEntity("issue:tpsdev-ai/flair#504")).toEqual({ type: "issue", value: "tpsdev-ai/flair#504" });
  });

  test("returns null with no colon", () => {
    expect(parseEntity("repo-tpsdev-ai-flair")).toBeNull();
  });

  test("returns null with empty type (colon-first)", () => {
    expect(parseEntity(":acme")).toBeNull();
  });

  test("returns null with empty value", () => {
    expect(parseEntity("customer:")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseEntity("")).toBeNull();
  });
});

describe("isValidEntity — valid forms (one per type, per FLAIR-ATTENTION-PLANE.md)", () => {
  test("repo:<owner>/<name>", () => {
    expect(isValidEntity("repo:tpsdev-ai/flair")).toBe(true);
  });

  test("repo with dotted segment", () => {
    expect(isValidEntity("repo:harper.fast/harper")).toBe(true);
  });

  test("issue:<repo>#<n>", () => {
    expect(isValidEntity("issue:tpsdev-ai/flair#504")).toBe(true);
  });

  test("customer:<slug>", () => {
    expect(isValidEntity("customer:acme")).toBe(true);
  });

  test("customer:<multi-word-slug>", () => {
    expect(isValidEntity("customer:acme-corp")).toBe(true);
  });

  test("subsystem:<slug>", () => {
    expect(isValidEntity("subsystem:embeddings")).toBe(true);
  });

  test("agent:<agentId>", () => {
    expect(isValidEntity("agent:flint")).toBe(true);
  });

  test("person:<id>", () => {
    expect(isValidEntity("person:nathan")).toBe(true);
  });

  test("slug with underscore separator", () => {
    expect(isValidEntity("subsystem:memory_bootstrap")).toBe(true);
  });
});

describe("isValidEntity — invalid forms", () => {
  test("rejects empty string", () => {
    expect(isValidEntity("")).toBe(false);
  });

  test("rejects non-string input", () => {
    expect(isValidEntity(42)).toBe(false);
    expect(isValidEntity(null)).toBe(false);
    expect(isValidEntity(undefined)).toBe(false);
    expect(isValidEntity({ type: "repo", value: "a/b" })).toBe(false);
  });

  test("rejects unknown type", () => {
    expect(isValidEntity("project:flair")).toBe(false);
  });

  test("rejects uppercase type (closed set is lowercase-only)", () => {
    expect(isValidEntity("Repo:tpsdev-ai/flair")).toBe(false);
    expect(isValidEntity("CUSTOMER:acme")).toBe(false);
  });

  test("rejects malformed repo value (no slash)", () => {
    expect(isValidEntity("repo:flair")).toBe(false);
  });

  test("rejects malformed repo value (too many slashes)", () => {
    expect(isValidEntity("repo:tpsdev-ai/flair/extra")).toBe(false);
  });

  test("rejects repo value with uppercase segment", () => {
    expect(isValidEntity("repo:Tpsdev-Ai/Flair")).toBe(false);
  });

  test("rejects issue value missing the #n suffix", () => {
    expect(isValidEntity("issue:tpsdev-ai/flair")).toBe(false);
  });

  test("rejects issue value with non-numeric suffix", () => {
    expect(isValidEntity("issue:tpsdev-ai/flair#abc")).toBe(false);
  });

  test("rejects issue value with leading-zero number", () => {
    expect(isValidEntity("issue:tpsdev-ai/flair#0504")).toBe(false);
  });

  test("rejects issue value with zero as the number", () => {
    expect(isValidEntity("issue:tpsdev-ai/flair#0")).toBe(false);
  });

  test("rejects slug with uppercase", () => {
    expect(isValidEntity("customer:Acme")).toBe(false);
  });

  test("rejects slug with spaces", () => {
    expect(isValidEntity("customer:acme corp")).toBe(false);
  });

  test("rejects slug with leading separator", () => {
    expect(isValidEntity("subsystem:-embeddings")).toBe(false);
  });

  test("rejects slug with trailing separator", () => {
    expect(isValidEntity("subsystem:embeddings-")).toBe(false);
  });

  test("rejects slug with doubled separator", () => {
    expect(isValidEntity("subsystem:embed--dings")).toBe(false);
  });

  test("rejects empty value after colon", () => {
    expect(isValidEntity("repo:")).toBe(false);
  });

  test("rejects bare type with no colon", () => {
    expect(isValidEntity("repo")).toBe(false);
  });

  test("rejects trailing whitespace", () => {
    expect(isValidEntity("repo:tpsdev-ai/flair ")).toBe(false);
  });

  test("rejects leading whitespace", () => {
    expect(isValidEntity(" repo:tpsdev-ai/flair")).toBe(false);
  });

  test("a distinct, well-formed repo value is its own valid entity (not a prefix of another)", () => {
    // Guards against accidentally implementing prefix matching: this is a
    // DIFFERENT, independently valid repo — grammar validity, not a substring
    // relationship to "repo:tpsdev-ai/flair".
    expect(isValidEntity("repo:tpsdev-ai/flair-mcp")).toBe(true);
  });
});

describe("validateEntities — array validation", () => {
  test("undefined is valid (additive/optional field, absent)", () => {
    expect(validateEntities(undefined)).toEqual({ valid: true, invalid: [] });
  });

  test("null is valid (additive/optional field, absent)", () => {
    expect(validateEntities(null)).toEqual({ valid: true, invalid: [] });
  });

  test("empty array is valid", () => {
    expect(validateEntities([])).toEqual({ valid: true, invalid: [] });
  });

  test("array of valid entities is valid", () => {
    const entities = ["repo:tpsdev-ai/flair", "issue:tpsdev-ai/flair#675", "agent:flint"];
    expect(validateEntities(entities)).toEqual({ valid: true, invalid: [] });
  });

  test("array with one invalid entity reports it", () => {
    const result = validateEntities(["repo:tpsdev-ai/flair", "project:bogus"]);
    expect(result.valid).toBe(false);
    expect(result.invalid).toEqual(["project:bogus"]);
  });

  test("array with multiple invalid entities reports all of them", () => {
    const result = validateEntities(["not-an-entity", "Customer:Acme", "repo:tpsdev-ai/flair"]);
    expect(result.valid).toBe(false);
    expect(result.invalid).toEqual(["not-an-entity", "Customer:Acme"]);
  });

  test("non-array, non-null value is invalid", () => {
    const result = validateEntities("repo:tpsdev-ai/flair");
    expect(result.valid).toBe(false);
  });

  test("non-string array elements are reported invalid", () => {
    const result = validateEntities([123, "repo:tpsdev-ai/flair"]);
    expect(result.valid).toBe(false);
    expect(result.invalid).toEqual(["123"]);
  });
});

describe("invalidEntitiesResponse — write-path helper", () => {
  test("returns null when entities is absent", async () => {
    expect(invalidEntitiesResponse(undefined)).toBeNull();
    expect(invalidEntitiesResponse(null)).toBeNull();
  });

  test("returns null when entities are all valid", async () => {
    expect(invalidEntitiesResponse(["repo:tpsdev-ai/flair", "agent:flint"])).toBeNull();
  });

  test("returns a 400 Response with the invalid entries when invalid", async () => {
    const res = invalidEntitiesResponse(["repo:tpsdev-ai/flair", "bogus"]);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("invalid_entities");
    expect(body.invalid).toEqual(["bogus"]);
  });
});
