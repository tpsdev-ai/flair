// agent-status-guard.test.ts — flair#2108. `Agent.status` is the principal's
// lifecycle state (anything other than "active" deactivates it), so a write
// that carries `status` is administrator-only; a non-admin write that includes
// it is refused whole.
//
// These pin the pure decision the Agent resource applies on both mutation
// verbs: which bodies count as a status write, and the refusal a non-admin gets
// (naming the field and pointing at Presence).
import { describe, it, expect } from "bun:test";
import {
  AGENT_STATUS_ADMIN_ONLY_ERROR,
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
