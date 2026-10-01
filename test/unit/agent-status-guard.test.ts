// agent-status-guard.test.ts — flair#2108. `Agent.status` is the principal's
// lifecycle state (anything other than "active" deactivates it). Through the
// Agent resource, a write that carries `status` is admitted only from a trusted
// internal call or an administrator; an authenticated non-admin agent's write
// that includes it is refused whole. (A federation peer's record merges through
// the raw table and refuses an inbound status change on an existing principal
// separately — resources/Federation.ts.)
//
// These pin the pure decisions the Agent resource applies: which bodies count as
// a status write, the admission of caller verdicts (an unexpected verdict is
// denied), and the refusal a non-admin agent gets (naming the field and Presence).
import { describe, it, expect } from "bun:test";
import {
  AGENT_STATUS_ADMIN_ONLY_ERROR,
  admitPrincipalWrite,
  writeIncludesStatus,
  statusWriteRefusal,
} from "../../resources/agent-status-guard.js";

describe("writeIncludesStatus — which bodies carry the field", () => {
  it("is true when the body carries `status`, whatever the value", () => {
    expect(writeIncludesStatus({ status: "active" })).toBe(true);
    expect(writeIncludesStatus({ status: "deactivated" })).toBe(true);
    expect(writeIncludesStatus({ status: "online" })).toBe(true);
    // Present-but-undefined is still a write that names the field.
    expect(writeIncludesStatus({ status: undefined })).toBe(true);
    expect(writeIncludesStatus({ runtime: "headless", status: "active" })).toBe(true);
  });

  it("is false for a body that does not name `status`", () => {
    expect(writeIncludesStatus({ runtime: "headless" })).toBe(false);
    expect(writeIncludesStatus({})).toBe(false);
    // A non-object body cannot include the field.
    expect(writeIncludesStatus(null)).toBe(false);
    expect(writeIncludesStatus(undefined)).toBe(false);
    expect(writeIncludesStatus("status")).toBe(false);
  });
});

describe("statusWriteRefusal — the decision the resource applies", () => {
  it("refuses a non-admin write that includes `status`, naming the field and Presence", async () => {
    const res = statusWriteRefusal({ status: "deactivated" }, false);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(String(body.error)).toContain("status");
    expect(String(body.error)).toContain("Presence");
    expect(body.error).toBe(AGENT_STATUS_ADMIN_ONLY_ERROR);
  });

  it("refuses the caller's own row the same as any other — the field, not the row, decides", async () => {
    // The guard has no notion of row identity: the same body gets the same
    // refusal whether it names the caller or someone else.
    const own = statusWriteRefusal({ status: "active" }, false);
    expect(own).not.toBeNull();
    expect(own!.status).toBe(403);
  });

  it("admits an administrator's status write", () => {
    expect(statusWriteRefusal({ status: "deactivated" }, true)).toBeNull();
  });

  it("admits a non-admin write that does not include `status`", () => {
    expect(statusWriteRefusal({ runtime: "headless" }, false)).toBeNull();
    expect(statusWriteRefusal({}, false)).toBeNull();
  });
});

describe("admitPrincipalWrite — only internal and an admin agent", () => {
  it("admits a trusted internal call and an administrator", () => {
    expect(admitPrincipalWrite({ kind: "internal" })).toBe("internal");
    expect(admitPrincipalWrite({ kind: "agent", isAdmin: true })).toBe("admin");
  });

  it("routes a non-admin agent to the per-record rules", () => {
    expect(admitPrincipalWrite({ kind: "agent", isAdmin: false })).toBe("non-admin");
    expect(admitPrincipalWrite({ kind: "agent" })).toBe("non-admin");
  });

  it("denies anonymous and an UNEXPECTED verdict kind (fail closed)", () => {
    expect(admitPrincipalWrite({ kind: "anonymous" })).toBe("deny");
    expect(admitPrincipalWrite({ kind: "service" })).toBe("deny");
    expect(admitPrincipalWrite({ kind: "agent", isAdmin: "true" })).toBe("non-admin");
    expect(admitPrincipalWrite(null)).toBe("deny");
    expect(admitPrincipalWrite(undefined)).toBe("deny");
  });
});
