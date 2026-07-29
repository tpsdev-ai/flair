// agent-admin.test.ts — flair#941. The shared admin predicate and the write
// reconciliation that makes a contradictory Agent record unrepresentable
// through any flair write path.
//
// These are the assertions that matter for a field-truth fix:
//   - ONE predicate, so no two surfaces can answer "is this an admin?"
//     differently for the same record;
//   - the predicate does NOT widen — a record carrying only the `admin` mirror
//     is not an administrator, exactly as before;
//   - reconciliation is idempotent and total, so a write cannot store a
//     disagreement whichever field the caller used.
import { describe, it, expect } from "bun:test";
import {
  ADMIN_ROLE,
  adminFieldsDisagree,
  agentRecordIsAdmin,
  reconcileAdminFields,
} from "../../resources/agent-admin.js";

describe("agentRecordIsAdmin — the one predicate", () => {
  it("role:\"admin\" is an administrator", () => {
    expect(agentRecordIsAdmin({ role: "admin" })).toBe(true);
    expect(agentRecordIsAdmin({ role: ADMIN_ROLE, admin: true })).toBe(true);
    // The authority stands on its own — a stale mirror does not revoke.
    expect(agentRecordIsAdmin({ role: "admin", admin: false })).toBe(true);
  });

  it("the `admin` mirror ALONE does not grant — this is the no-widening property", () => {
    // The record `flair principal add --admin` used to produce. It has never
    // been an administrator at the gate, and this fix must not make it one.
    expect(agentRecordIsAdmin({ admin: true })).toBe(false);
    expect(agentRecordIsAdmin({ admin: true, role: "agent" })).toBe(false);
    expect(agentRecordIsAdmin({ admin: true, role: "researcher" })).toBe(false);
  });

  it("ordinary and absent records are not administrators", () => {
    expect(agentRecordIsAdmin({ role: "agent", admin: false })).toBe(false);
    expect(agentRecordIsAdmin({})).toBe(false);
    expect(agentRecordIsAdmin(null)).toBe(false);
    expect(agentRecordIsAdmin(undefined)).toBe(false);
  });

  it("the admin sentinel is exact — no trimming, no case folding, no prefix match", () => {
    // `role` is free text on a public roster; a near-miss must not grant.
    for (const role of ["Admin", "ADMIN", " admin", "admin ", "administrator", "admins", "superadmin"]) {
      expect(agentRecordIsAdmin({ role })).toBe(false);
    }
  });

  it("is not fooled by a non-string role that coerces", () => {
    expect(agentRecordIsAdmin({ role: true })).toBe(false);
    expect(agentRecordIsAdmin({ role: 1 })).toBe(false);
    expect(agentRecordIsAdmin({ role: ["admin"] })).toBe(false);
    expect(agentRecordIsAdmin({ role: { toString: () => "admin" } })).toBe(false);
  });
});

describe("reconcileAdminFields — a write cannot store a disagreement", () => {
  it("role:\"admin\" carries the mirror with it", () => {
    const out = reconcileAdminFields({ id: "a", role: "admin" });
    expect(out.role).toBe("admin");
    expect(out.admin).toBe(true);
    expect(adminFieldsDisagree(out)).toBe(false);
  });

  it("admin:true carries the AUTHORITY with it — this is what makes --admin work", () => {
    const out = reconcileAdminFields({ id: "a", admin: true });
    expect(out.role).toBe("admin");
    expect(out.admin).toBe(true);
    expect(agentRecordIsAdmin(out)).toBe(true);
  });

  it("repairs a record that arrived contradictory, in both directions", () => {
    expect(adminFieldsDisagree(reconcileAdminFields({ role: "admin", admin: false }))).toBe(false);
    expect(adminFieldsDisagree(reconcileAdminFields({ role: "agent", admin: true }))).toBe(false);
  });

  it("an ordinary write comes out non-admin with its free-text role intact", () => {
    const out = reconcileAdminFields({ id: "a", role: "researcher" });
    expect(out.role).toBe("researcher");
    expect(out.admin).toBe(false);
    expect(agentRecordIsAdmin(out)).toBe(false);
  });

  it("defaults the mirror when neither field was supplied", () => {
    const out = reconcileAdminFields({ id: "a", name: "a" });
    expect(out.admin).toBe(false);
    expect(agentRecordIsAdmin(out)).toBe(false);
  });

  it("admin:false does NOT demote an explicit admin role — the authority wins", () => {
    const out = reconcileAdminFields({ role: "admin", admin: false });
    expect(out.admin).toBe(true);
    expect(agentRecordIsAdmin(out)).toBe(true);
  });

  it("is idempotent", () => {
    for (const input of [{ role: "admin" }, { admin: true }, { role: "x" }, {}]) {
      const once = reconcileAdminFields({ ...input });
      const twice = reconcileAdminFields({ ...once });
      expect(twice).toEqual(once);
    }
  });

  it("only truthy-BOOLEAN admin requests admin — a truthy non-boolean does not escalate", () => {
    // Guards against a JSON body sending admin:"false" or admin:1 and being
    // read as a grant.
    for (const admin of ["true", "false", 1, "yes", {}] as any[]) {
      const out = reconcileAdminFields({ id: "a", admin });
      expect(agentRecordIsAdmin(out)).toBe(false);
      expect(out.admin).toBe(false);
    }
  });
});

describe("adminFieldsDisagree — reporting only", () => {
  it("flags exactly the records a raw write can leave inconsistent", () => {
    expect(adminFieldsDisagree({ role: "admin", admin: true })).toBe(false);
    expect(adminFieldsDisagree({ role: "agent", admin: false })).toBe(false);
    expect(adminFieldsDisagree({ role: "admin", admin: false })).toBe(true);
    expect(adminFieldsDisagree({ role: "agent", admin: true })).toBe(true);
    // absent mirror on an admin record is still a disagreement worth surfacing
    expect(adminFieldsDisagree({ role: "admin" })).toBe(true);
  });

  it("does not flag ordinary records with no admin fields at all", () => {
    expect(adminFieldsDisagree({ id: "a" })).toBe(false);
    expect(adminFieldsDisagree(null)).toBe(false);
  });
});
