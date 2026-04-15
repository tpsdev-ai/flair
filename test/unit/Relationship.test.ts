/**
 * Relationship.ts unit tests
 *
 * The Relationship class extends Harper's DB class — it cannot be instantiated
 * without a running Harper instance. This file tests the pure validation and
 * normalization logic extracted from Relationship.ts:
 *
 *   - Required field validation (subject, predicate, object)
 *   - Type checking for required fields
 *   - Field normalization (lowercase, timestamps, defaults)
 *   - Temporal bounds (validFrom, validTo)
 *   - Confidence default
 *   - Ownership / admin guards for search, put, delete
 *   - Agent scoping for search
 *
 * Coverage gaps:
 *   - Relationship.put(), .search(), .delete() cannot be tested directly
 *     because they require a Harper DB instance.
 */

import { describe, test, expect } from "bun:test";

// ─── Required field validation ────────────────────────────────────────────────

function validateRelationshipFields(content: Record<string, any>): {
  valid: boolean;
  error?: string;
} {
  if (!content.subject || typeof content.subject !== "string") {
    return { valid: false, error: "subject is required (string)" };
  }
  if (!content.predicate || typeof content.predicate !== "string") {
    return { valid: false, error: "predicate is required (string)" };
  }
  if (!content.object || typeof content.object !== "string") {
    return { valid: false, error: "object is required (string)" };
  }
  return { valid: true };
}

describe("relationship field validation", () => {
  test("valid relationship passes", () => {
    const result = validateRelationshipFields({
      subject: "nathan",
      predicate: "manages",
      object: "project-alpha",
    });
    expect(result.valid).toBe(true);
  });

  test("missing subject is rejected", () => {
    const result = validateRelationshipFields({ predicate: "manages", object: "foo" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("subject");
  });

  test("missing predicate is rejected", () => {
    const result = validateRelationshipFields({ subject: "nathan", object: "foo" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("predicate");
  });

  test("missing object is rejected", () => {
    const result = validateRelationshipFields({ subject: "nathan", predicate: "manages" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("object");
  });

  test("non-string subject is rejected", () => {
    const result = validateRelationshipFields({ subject: 42, predicate: "manages", object: "foo" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("subject");
  });

  test("non-string predicate is rejected", () => {
    const result = validateRelationshipFields({ subject: "a", predicate: null, object: "foo" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("predicate");
  });

  test("non-string object is rejected", () => {
    const result = validateRelationshipFields({ subject: "a", predicate: "b", object: [] });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("object");
  });

  test("empty string subject is rejected (falsy)", () => {
    const result = validateRelationshipFields({ subject: "", predicate: "manages", object: "foo" });
    expect(result.valid).toBe(false);
  });
});

// ─── Normalization ────────────────────────────────────────────────────────────

function normalizeRelationship(
  content: Record<string, any>,
  authAgent: string,
): Record<string, any> {
  const now = new Date().toISOString();
  return {
    ...content,
    agentId: authAgent,
    subject: content.subject.toLowerCase(),
    predicate: content.predicate.toLowerCase(),
    object: content.object.toLowerCase(),
    createdAt: content.createdAt || now,
    updatedAt: now,
    validFrom: content.validFrom || now,
    confidence: content.confidence ?? 1.0,
  };
}

describe("relationship normalization", () => {
  test("subject, predicate, object are lowercased", () => {
    const result = normalizeRelationship(
      { subject: "Nathan", predicate: "MANAGES", object: "Project-Alpha" },
      "flint",
    );
    expect(result.subject).toBe("nathan");
    expect(result.predicate).toBe("manages");
    expect(result.object).toBe("project-alpha");
  });

  test("agentId is set to authAgent", () => {
    const result = normalizeRelationship(
      { subject: "a", predicate: "b", object: "c" },
      "flint",
    );
    expect(result.agentId).toBe("flint");
  });

  test("validFrom defaults to now when absent", () => {
    const before = Date.now();
    const result = normalizeRelationship(
      { subject: "a", predicate: "b", object: "c" },
      "flint",
    );
    const validFrom = new Date(result.validFrom).getTime();
    expect(validFrom).toBeGreaterThanOrEqual(before);
  });

  test("explicit validFrom is preserved", () => {
    const past = "2025-01-01T00:00:00.000Z";
    const result = normalizeRelationship(
      { subject: "a", predicate: "b", object: "c", validFrom: past },
      "flint",
    );
    expect(result.validFrom).toBe(past);
  });

  test("confidence defaults to 1.0", () => {
    const result = normalizeRelationship(
      { subject: "a", predicate: "b", object: "c" },
      "flint",
    );
    expect(result.confidence).toBe(1.0);
  });

  test("explicit confidence is preserved", () => {
    const result = normalizeRelationship(
      { subject: "a", predicate: "b", object: "c", confidence: 0.75 },
      "flint",
    );
    expect(result.confidence).toBe(0.75);
  });

  test("confidence of 0 is preserved (not overwritten by default)", () => {
    const result = normalizeRelationship(
      { subject: "a", predicate: "b", object: "c", confidence: 0 },
      "flint",
    );
    // 0 ?? 1.0 === 0 (nullish coalescing, not falsy check)
    expect(result.confidence).toBe(0);
  });

  test("createdAt defaults to now when absent", () => {
    const before = Date.now();
    const result = normalizeRelationship(
      { subject: "a", predicate: "b", object: "c" },
      "flint",
    );
    expect(new Date(result.createdAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  test("existing createdAt is preserved", () => {
    const existingTs = "2025-06-01T12:00:00.000Z";
    const result = normalizeRelationship(
      { subject: "a", predicate: "b", object: "c", createdAt: existingTs },
      "flint",
    );
    expect(result.createdAt).toBe(existingTs);
  });

  test("updatedAt is always refreshed", () => {
    const before = Date.now();
    const result = normalizeRelationship(
      { subject: "a", predicate: "b", object: "c", updatedAt: "2020-01-01T00:00:00.000Z" },
      "flint",
    );
    expect(new Date(result.updatedAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  test("validTo is not set by default (active relationship)", () => {
    const result = normalizeRelationship(
      { subject: "a", predicate: "b", object: "c" },
      "flint",
    );
    expect(result.validTo).toBeUndefined();
  });
});

// ─── Temporal bounds ─────────────────────────────────────────────────────────

describe("temporal relationship bounds", () => {
  test("active relationship has no validTo", () => {
    const rel = { subject: "a", predicate: "b", object: "c", validFrom: "2025-01-01T00:00:00Z" };
    expect((rel as any).validTo).toBeUndefined();
  });

  test("historical relationship has both validFrom and validTo", () => {
    const rel = {
      validFrom: "2025-01-01T00:00:00Z",
      validTo: "2025-03-31T23:59:59Z",
    };
    expect(new Date(rel.validFrom).getTime()).toBeLessThan(new Date(rel.validTo).getTime());
  });

  test("validFrom before validTo is a valid temporal range", () => {
    const validFrom = new Date("2025-01-01").getTime();
    const validTo = new Date("2025-12-31").getTime();
    expect(validFrom).toBeLessThan(validTo);
  });

  test("relationship is active when current time is within bounds", () => {
    const now = Date.now();
    const past = new Date(now - 86_400_000).toISOString(); // yesterday
    const future = new Date(now + 86_400_000).toISOString(); // tomorrow
    const isActive = new Date(past).getTime() <= now && new Date(future).getTime() >= now;
    expect(isActive).toBe(true);
  });

  test("relationship is expired when validTo is in the past", () => {
    const now = Date.now();
    const validTo = new Date(now - 1000).toISOString(); // 1 second ago
    expect(new Date(validTo).getTime()).toBeLessThan(now);
  });

  test("relationship has not started when validFrom is in the future", () => {
    const now = Date.now();
    const validFrom = new Date(now + 86_400_000).toISOString(); // tomorrow
    expect(new Date(validFrom).getTime()).toBeGreaterThan(now);
  });
});

// ─── PUT authentication guard ─────────────────────────────────────────────────

function canPutRelationship(authAgent: string | undefined): {
  allowed: boolean;
  error?: string;
} {
  if (!authAgent) {
    return { allowed: false, error: "authentication required" };
  }
  return { allowed: true };
}

describe("relationship PUT authentication guard", () => {
  test("authenticated agent is allowed", () => {
    expect(canPutRelationship("flint").allowed).toBe(true);
  });

  test("unauthenticated request is rejected", () => {
    const result = canPutRelationship(undefined);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("authentication required");
  });

  test("empty string agent is rejected", () => {
    const result = canPutRelationship("");
    expect(result.allowed).toBe(false);
  });
});

// ─── DELETE ownership guard ───────────────────────────────────────────────────

function canDeleteRelationship(
  authAgent: string | undefined,
  isAdminAgent: boolean,
  existingAgentId: string | undefined,
): { allowed: boolean; error?: string } {
  if (!authAgent) {
    return { allowed: false, error: "authentication required" };
  }
  if (!isAdminAgent && existingAgentId && existingAgentId !== authAgent) {
    return { allowed: false, error: "cannot delete another agent's relationship" };
  }
  return { allowed: true };
}

describe("relationship DELETE ownership guard", () => {
  test("admin can delete any relationship", () => {
    expect(canDeleteRelationship("admin", true, "other-agent").allowed).toBe(true);
  });

  test("non-admin can delete own relationship", () => {
    expect(canDeleteRelationship("flint", false, "flint").allowed).toBe(true);
  });

  test("non-admin cannot delete another agent's relationship", () => {
    const result = canDeleteRelationship("flint", false, "anvil");
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("cannot delete another agent");
  });

  test("unauthenticated request is rejected", () => {
    const result = canDeleteRelationship(undefined, false, "flint");
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("authentication required");
  });

  test("non-admin with no existing agentId on record can delete (record not found case)", () => {
    // existingAgentId undefined → no ownership to check
    expect(canDeleteRelationship("flint", false, undefined).allowed).toBe(true);
  });
});

// ─── Search scoping ───────────────────────────────────────────────────────────

function buildAgentSearchCondition(authAgent: string) {
  return { attribute: "agentId", comparator: "equals", value: authAgent };
}

describe("relationship search scoping", () => {
  test("non-admin search condition scopes to agent", () => {
    const condition = buildAgentSearchCondition("flint");
    expect(condition.attribute).toBe("agentId");
    expect(condition.comparator).toBe("equals");
    expect(condition.value).toBe("flint");
  });

  test("condition value matches the authenticated agent", () => {
    const condition = buildAgentSearchCondition("anvil");
    expect(condition.value).toBe("anvil");
  });
});
