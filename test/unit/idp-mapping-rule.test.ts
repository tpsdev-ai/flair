/**
 * idp-mapping-rule.test.ts — the pure decision behind "an IdP identity mapping
 * is created and changed only by an administrator or the server"
 * (src/lib/idp-mapping-rule.ts). The Credential resource applies it to a
 * non-admin agent's writes (test/unit/credential-create-auth.test.ts); the
 * real-Harper paths are test/integration/credential-idp-mapping-writes.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  IDP_MAPPING_ADMIN_ONLY,
  IDP_MAPPING_IDENTITY_FIELDS,
  IDP_MAPPING_REFUSAL_MESSAGE,
  isIdpMappingChange,
  namesIdpKind,
} from "../../src/lib/idp-mapping-rule";

const idpRow = Object.freeze({
  id: "cred-1",
  principalId: "agent-1",
  kind: "idp",
  idpProvider: "github",
  idpSubject: "alice",
  status: "active",
  label: "laptop",
});

describe("namesIdpKind", () => {
  it("is true for \"idp\" and for a multi-valued kind that includes it, false otherwise", () => {
    expect(namesIdpKind("idp")).toBe(true);
    expect(namesIdpKind(["bearer-token", "idp"])).toBe(true);
    for (const k of ["IDP", " idp", "bearer-token", "", null, undefined, ["bearer-token"], { kind: "idp" }]) {
      expect(namesIdpKind(k)).toBe(false);
    }
  });
});

describe("isIdpMappingChange", () => {
  it("leaves rows that are not mappings on either side alone", () => {
    expect(isIdpMappingChange(null, { kind: "bearer-token", principalId: "agent-1" })).toBe(false);
    expect(isIdpMappingChange({ kind: "webauthn" }, { kind: "ed25519", idpSubject: "alice" })).toBe(false);
  });

  it("refuses creating a mapping", () => {
    expect(isIdpMappingChange(null, { ...idpRow })).toBe(true);
    expect(isIdpMappingChange(undefined, { kind: "idp" })).toBe(true);
    expect(isIdpMappingChange(null, { kind: ["idp"], idpSubject: "alice" })).toBe(true);
  });

  it("refuses changing kind to idp, even when the identity fields are already present", () => {
    const stored = { ...idpRow, kind: "bearer-token" };
    expect(isIdpMappingChange(stored, { ...stored, kind: "idp" })).toBe(true);
  });

  it("refuses changing kind away from idp", () => {
    expect(isIdpMappingChange(idpRow, { ...idpRow, kind: "bearer-token" })).toBe(true);
  });

  it("refuses changing each identity field, including clearing it", () => {
    expect([...IDP_MAPPING_IDENTITY_FIELDS].sort()).toEqual(["idpProvider", "idpSubject", "principalId"]);
    for (const field of IDP_MAPPING_IDENTITY_FIELDS) {
      expect(isIdpMappingChange(idpRow, { ...idpRow, [field]: "other" })).toBe(true);
      const cleared: Record<string, unknown> = { ...idpRow };
      delete cleared[field];
      expect(isIdpMappingChange(idpRow, cleared)).toBe(true);
    }
  });

  it("refuses an identity value of a different type", () => {
    expect(isIdpMappingChange(idpRow, { ...idpRow, idpSubject: ["alice", "bob"] })).toBe(true);
  });

  it("allows revoking, refuses any other status change", () => {
    expect(isIdpMappingChange(idpRow, { ...idpRow, status: "revoked" })).toBe(false);
    const revoked = { ...idpRow, status: "revoked" };
    expect(isIdpMappingChange(revoked, { ...revoked, status: "active" })).toBe(true);
    expect(isIdpMappingChange(revoked, { ...revoked, status: "suspended" })).toBe(true);
    const legacy = { ...idpRow, status: undefined };
    expect(isIdpMappingChange(legacy, { ...legacy, status: "active" })).toBe(true);
  });

  it("allows a write that leaves the mapping as it is", () => {
    expect(isIdpMappingChange(idpRow, { ...idpRow })).toBe(false);
    expect(isIdpMappingChange(idpRow, { ...idpRow, label: "desktop", updatedAt: "2026-10-13T00:00:00Z" })).toBe(false);
    // An absent and a null value are the same stored state.
    const noProvider = { ...idpRow, idpProvider: undefined };
    expect(isIdpMappingChange(noProvider, { ...noProvider, idpProvider: null })).toBe(false);
  });
});

describe("the refusal", () => {
  it("is named and carries no request value", () => {
    expect(IDP_MAPPING_ADMIN_ONLY).toBe("idp_mapping_admin_only");
    expect(IDP_MAPPING_REFUSAL_MESSAGE).toContain("administrator");
    expect(IDP_MAPPING_REFUSAL_MESSAGE).not.toContain("${");
  });
});
