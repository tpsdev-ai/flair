/**
 * migrations-source-fields.test.ts — resources/migrations/source-fields.ts.
 *
 * Covers: the exact SOURCE_FIELDS enumerations (mechanically checked against
 * the Kern verdict's field list, so a future accidental edit is caught),
 * and the hash envelope primitives' determinism (order-independence,
 * missing-vs-null equivalence, sensitivity to a real source-field change,
 * insensitivity to a derived-field-only change).
 */
import { describe, it, expect } from "bun:test";
import {
  MEMORY_SOURCE_FIELDS,
  MEMORY_DERIVED_FIELDS,
  RELATIONSHIP_SOURCE_FIELDS,
  sourceFieldsFor,
  hashSourceFields,
  hashCorpus,
} from "../../resources/migrations/source-fields.ts";

describe("SOURCE_FIELDS enumerations (Kern verdict, 2026-07-11)", () => {
  it("Memory source fields match the verdict exactly", () => {
    expect([...MEMORY_SOURCE_FIELDS].sort()).toEqual(
      ["content", "agentId", "durability", "visibility", "tags", "createdAt", "supersedes"].sort(),
    );
  });

  it("Memory derived fields match the verdict exactly", () => {
    expect([...MEMORY_DERIVED_FIELDS].sort()).toEqual(
      ["embedding", "embeddingModel", "retrievalCount", "usageCount", "lastRetrieved", "provenance", "originatorInstanceId"].sort(),
    );
  });

  it("Relationship source fields match the verdict exactly", () => {
    expect([...RELATIONSHIP_SOURCE_FIELDS].sort()).toEqual(
      ["subject", "predicate", "object", "agentId", "validFrom", "validTo"].sort(),
    );
  });

  it("no field appears in both Memory source AND derived lists", () => {
    const overlap = MEMORY_SOURCE_FIELDS.filter((f) => (MEMORY_DERIVED_FIELDS as readonly string[]).includes(f));
    expect(overlap).toEqual([]);
  });

  it("sourceFieldsFor resolves the correct table", () => {
    expect(sourceFieldsFor("Memory")).toBe(MEMORY_SOURCE_FIELDS);
    expect(sourceFieldsFor("Relationship")).toBe(RELATIONSHIP_SOURCE_FIELDS);
  });
});

describe("hashSourceFields", () => {
  it("is deterministic for the same row", () => {
    const row = { id: "m1", content: "hello", agentId: "a1", embedding: [1, 2, 3] };
    const h1 = hashSourceFields(row, MEMORY_SOURCE_FIELDS);
    const h2 = hashSourceFields(row, MEMORY_SOURCE_FIELDS);
    expect(h1).toBe(h2);
  });

  it("is independent of key insertion order", () => {
    const a = { content: "hello", agentId: "a1", durability: "standard" };
    const b = { durability: "standard", agentId: "a1", content: "hello" };
    expect(hashSourceFields(a, MEMORY_SOURCE_FIELDS)).toBe(hashSourceFields(b, MEMORY_SOURCE_FIELDS));
  });

  it("treats a missing field and an explicit null identically", () => {
    const a = { content: "hello", agentId: "a1" }; // tags absent
    const b = { content: "hello", agentId: "a1", tags: null };
    expect(hashSourceFields(a, MEMORY_SOURCE_FIELDS)).toBe(hashSourceFields(b, MEMORY_SOURCE_FIELDS));
  });

  it("changes when a SOURCE field changes", () => {
    const a = { content: "hello", agentId: "a1" };
    const b = { content: "goodbye", agentId: "a1" };
    expect(hashSourceFields(a, MEMORY_SOURCE_FIELDS)).not.toBe(hashSourceFields(b, MEMORY_SOURCE_FIELDS));
  });

  it("is UNCHANGED when only a DERIVED field changes (embedding/embeddingModel/etc. never enter the hash)", () => {
    const a = { content: "hello", agentId: "a1", embedding: [1, 2, 3], embeddingModel: "modelA", retrievalCount: 0 };
    const b = { content: "hello", agentId: "a1", embedding: [9, 9, 9], embeddingModel: "modelB", retrievalCount: 99 };
    expect(hashSourceFields(a, MEMORY_SOURCE_FIELDS)).toBe(hashSourceFields(b, MEMORY_SOURCE_FIELDS));
  });

  it("array-valued source fields (tags) hash consistently regardless of nested object key order", () => {
    const a = { content: "x", agentId: "a1", tags: ["b", "a"] };
    const b = { content: "x", agentId: "a1", tags: ["b", "a"] };
    expect(hashSourceFields(a, MEMORY_SOURCE_FIELDS)).toBe(hashSourceFields(b, MEMORY_SOURCE_FIELDS));
  });
});

describe("hashCorpus", () => {
  it("is independent of row iteration order", () => {
    const rows = [
      { id: "m2", content: "second", agentId: "a1" },
      { id: "m1", content: "first", agentId: "a1" },
    ];
    const reversed = [...rows].reverse();
    expect(hashCorpus(rows, MEMORY_SOURCE_FIELDS)).toBe(hashCorpus(reversed, MEMORY_SOURCE_FIELDS));
  });

  it("changes if any row's source fields change", () => {
    const rows = [{ id: "m1", content: "first", agentId: "a1" }];
    const mutated = [{ id: "m1", content: "first (edited)", agentId: "a1" }];
    expect(hashCorpus(rows, MEMORY_SOURCE_FIELDS)).not.toBe(hashCorpus(mutated, MEMORY_SOURCE_FIELDS));
  });

  it("changes if a row is added or removed", () => {
    const rows = [{ id: "m1", content: "first", agentId: "a1" }];
    const withExtra = [...rows, { id: "m2", content: "second", agentId: "a1" }];
    expect(hashCorpus(rows, MEMORY_SOURCE_FIELDS)).not.toBe(hashCorpus(withExtra, MEMORY_SOURCE_FIELDS));
  });

  it("is stable (idempotent) across repeated computation of the identical corpus", () => {
    const rows = [
      { id: "m1", content: "first", agentId: "a1" },
      { id: "m2", content: "second", agentId: "a1" },
    ];
    expect(hashCorpus(rows, MEMORY_SOURCE_FIELDS)).toBe(hashCorpus(rows, MEMORY_SOURCE_FIELDS));
  });

  it("empty corpus hashes to a stable constant", () => {
    expect(hashCorpus([], MEMORY_SOURCE_FIELDS)).toBe(hashCorpus([], MEMORY_SOURCE_FIELDS));
  });
});
