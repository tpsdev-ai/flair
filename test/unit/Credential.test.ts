/**
 * Credential.ts unit tests
 *
 * The Credential class extends Harper's DB class and all methods call
 * `super.put/get/search` — it cannot be instantiated without a running Harper
 * instance. This file tests the pure validation and normalization logic
 * extracted from Credential.ts:
 *
 *   - Valid `kind` values
 *   - Invalid kind rejection
 *   - Ownership guards (principalId !== authAgent)
 *   - tokenHash stripping from GET responses
 *   - Status / timestamp defaults
 *   - Admin vs non-admin access rules (as data-driven logic)
 *
 * Coverage gaps:
 *   - Credential.put(), .get(), .search(), .delete() cannot be tested directly
 *     because they require a Harper DB instance.
 */

import { describe, test, expect } from "bun:test";

// ─── Constants mirrored from Credential.ts ───────────────────────────────────

const VALID_KINDS = ["webauthn", "bearer-token", "ed25519", "idp"] as const;
type CredentialKind = typeof VALID_KINDS[number];

// ─── Kind validation ──────────────────────────────────────────────────────────

function validateKind(kind: any): { valid: boolean; error?: string } {
  if (!kind || !VALID_KINDS.includes(kind)) {
    return { valid: false, error: `kind must be one of: ${VALID_KINDS.join(", ")}` };
  }
  return { valid: true };
}

describe("credential kind validation", () => {
  test("webauthn is valid", () => {
    expect(validateKind("webauthn").valid).toBe(true);
  });

  test("bearer-token is valid", () => {
    expect(validateKind("bearer-token").valid).toBe(true);
  });

  test("ed25519 is valid", () => {
    expect(validateKind("ed25519").valid).toBe(true);
  });

  test("idp is valid", () => {
    expect(validateKind("idp").valid).toBe(true);
  });

  test("unknown kind is rejected", () => {
    const result = validateKind("oauth-token");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("kind must be one of");
  });

  test("empty string kind is rejected", () => {
    const result = validateKind("");
    expect(result.valid).toBe(false);
  });

  test("undefined kind is rejected", () => {
    const result = validateKind(undefined);
    expect(result.valid).toBe(false);
  });

  test("null kind is rejected", () => {
    const result = validateKind(null);
    expect(result.valid).toBe(false);
  });

  test("numeric kind is rejected", () => {
    const result = validateKind(42);
    expect(result.valid).toBe(false);
  });

  test("error message lists all valid kinds", () => {
    const result = validateKind("bad");
    for (const k of VALID_KINDS) {
      expect(result.error).toContain(k);
    }
  });
});

// ─── Ownership guard ──────────────────────────────────────────────────────────

/**
 * Mirrors the ownership check in Credential.put():
 *   if (!isAdminAgent && content.principalId && content.principalId !== authAgent)
 */
function canPutCredential(
  authAgent: string,
  isAdminAgent: boolean,
  contentPrincipalId: string | undefined,
): { allowed: boolean; error?: string } {
  if (!authAgent) {
    return { allowed: false, error: "authentication required" };
  }
  if (!isAdminAgent && contentPrincipalId && contentPrincipalId !== authAgent) {
    return {
      allowed: false,
      error: "only admin principals can manage other principals' credentials",
    };
  }
  return { allowed: true };
}

describe("credential ownership guard (put)", () => {
  test("admin can create credential for another principal", () => {
    const result = canPutCredential("admin", true, "other-agent");
    expect(result.allowed).toBe(true);
  });

  test("non-admin can create credential for themselves", () => {
    const result = canPutCredential("flint", false, "flint");
    expect(result.allowed).toBe(true);
  });

  test("non-admin cannot create credential for another principal", () => {
    const result = canPutCredential("flint", false, "anvil");
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("only admin");
  });

  test("unauthenticated request is rejected", () => {
    const result = canPutCredential("", false, undefined);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("authentication required");
  });

  test("non-admin with no principalId in body defaults to self (allowed)", () => {
    // principalId is undefined → no cross-owner check applies
    const result = canPutCredential("flint", false, undefined);
    expect(result.allowed).toBe(true);
  });
});

// ─── GET response: tokenHash stripping ───────────────────────────────────────

/**
 * Mirrors the tokenHash stripping in Credential.get():
 *   const { tokenHash, ...safe } = result;
 */
function stripTokenHash(record: Record<string, any>): Record<string, any> {
  const { tokenHash, ...safe } = record;
  return safe;
}

describe("tokenHash stripping", () => {
  test("tokenHash is removed from GET response", () => {
    const record = {
      id: "cred-1",
      principalId: "flint",
      kind: "bearer-token",
      tokenHash: "sha256-of-secret-token",
      status: "active",
    };
    const safe = stripTokenHash(record);
    expect(safe).not.toHaveProperty("tokenHash");
  });

  test("other fields are preserved", () => {
    const record = {
      id: "cred-1",
      principalId: "flint",
      kind: "bearer-token",
      tokenHash: "sha256-of-secret-token",
      status: "active",
      label: "My token",
    };
    const safe = stripTokenHash(record);
    expect(safe.id).toBe("cred-1");
    expect(safe.principalId).toBe("flint");
    expect(safe.status).toBe("active");
    expect(safe.label).toBe("My token");
  });

  test("record without tokenHash is returned unchanged (minus undefined key)", () => {
    const record = { id: "cred-2", kind: "ed25519", status: "active" };
    const safe = stripTokenHash(record);
    expect(safe).toEqual({ id: "cred-2", kind: "ed25519", status: "active" });
  });
});

// ─── PUT defaults ─────────────────────────────────────────────────────────────

/**
 * Mirrors the default-setting logic in Credential.put():
 */
function applyCredentialDefaults(
  content: Record<string, any>,
  authAgent: string,
): Record<string, any> {
  const now = new Date().toISOString();
  return {
    ...content,
    principalId: content.principalId || authAgent,
    status: content.status || "active",
    createdAt: content.createdAt || now,
    updatedAt: now,
  };
}

describe("credential PUT defaults", () => {
  test("principalId defaults to authAgent when absent", () => {
    const result = applyCredentialDefaults({ kind: "ed25519" }, "flint");
    expect(result.principalId).toBe("flint");
  });

  test("explicit principalId is preserved", () => {
    const result = applyCredentialDefaults({ kind: "ed25519", principalId: "anvil" }, "flint");
    expect(result.principalId).toBe("anvil");
  });

  test("status defaults to active", () => {
    const result = applyCredentialDefaults({ kind: "ed25519" }, "flint");
    expect(result.status).toBe("active");
  });

  test("explicit status is preserved", () => {
    const result = applyCredentialDefaults({ kind: "ed25519", status: "revoked" }, "flint");
    expect(result.status).toBe("revoked");
  });

  test("createdAt is set when absent", () => {
    const result = applyCredentialDefaults({ kind: "ed25519" }, "flint");
    expect(result.createdAt).toBeTruthy();
    expect(new Date(result.createdAt).getTime()).toBeGreaterThan(0);
  });

  test("existing createdAt is preserved", () => {
    const existingTs = "2025-01-01T00:00:00.000Z";
    const result = applyCredentialDefaults({ kind: "ed25519", createdAt: existingTs }, "flint");
    expect(result.createdAt).toBe(existingTs);
  });

  test("updatedAt is always refreshed", () => {
    const before = Date.now();
    const result = applyCredentialDefaults({ kind: "ed25519" }, "flint");
    const updated = new Date(result.updatedAt).getTime();
    expect(updated).toBeGreaterThanOrEqual(before);
  });
});

// ─── Non-admin read scoping ───────────────────────────────────────────────────

/**
 * Mirrors the scoping condition added in Credential.search() for non-admins.
 */
function buildNonAdminSearchCondition(authAgent: string) {
  return { attribute: "principalId", comparator: "equals", value: authAgent };
}

describe("non-admin search scoping", () => {
  test("produces a principalId equals condition for the auth agent", () => {
    const condition = buildNonAdminSearchCondition("flint");
    expect(condition.attribute).toBe("principalId");
    expect(condition.comparator).toBe("equals");
    expect(condition.value).toBe("flint");
  });

  test("condition value matches the authenticated agent", () => {
    const condition = buildNonAdminSearchCondition("anvil");
    expect(condition.value).toBe("anvil");
  });
});

// ─── DELETE ownership check ───────────────────────────────────────────────────

function canDeleteCredential(
  authAgent: string,
  isAdminAgent: boolean,
  existingPrincipalId: string | undefined,
): { allowed: boolean; error?: string } {
  if (!authAgent) return { allowed: false, error: "authentication required" };
  if (!isAdminAgent && existingPrincipalId && existingPrincipalId !== authAgent) {
    return {
      allowed: false,
      error: "only admin principals can revoke other principals' credentials",
    };
  }
  return { allowed: true };
}

describe("credential DELETE ownership", () => {
  test("admin can delete any credential", () => {
    expect(canDeleteCredential("admin", true, "other").allowed).toBe(true);
  });

  test("non-admin can delete own credential", () => {
    expect(canDeleteCredential("flint", false, "flint").allowed).toBe(true);
  });

  test("non-admin cannot delete another agent's credential", () => {
    const result = canDeleteCredential("flint", false, "anvil");
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("only admin");
  });

  test("unauthenticated request is rejected", () => {
    const result = canDeleteCredential("", false, undefined);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("authentication required");
  });
});
