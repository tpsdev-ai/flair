// flair#2665 — the pure Agent field rules the federation merge applies
// (resources/federation-classify.ts). The real-Harper end to end is
// test/integration/federation-agent-field-scope-2665.test.ts.
import { describe, expect, test } from "bun:test";
import { configuredAdminAgentIds } from "../../resources/agent-admin.ts";
import {
  agentAdminIdCreateRefusal,
  agentIdentityRefusal,
  inboundChangesAgentIdentity,
  keepReceiverAgentAuthority,
  senderIsAgentHome,
  type SyncRecord,
} from "../../resources/federation-classify.ts";

const HOME = "instance-home";
const OTHER = "instance-other";

const rec = (data: Record<string, unknown>, table = "Agent"): SyncRecord => ({
  table,
  id: "agent-a",
  data: { id: "agent-a", ...data },
  updatedAt: "2026-10-18T00:00:00.000Z",
  originatorInstanceId: OTHER,
});

const stored = (fields: Record<string, unknown> = {}) => ({
  id: "agent-a", publicKey: "key-1", role: "agent", admin: false, originatorInstanceId: HOME, ...fields,
});

describe("flair#2665 senderIsAgentHome", () => {
  test("matches only a non-empty stored home equal to the sender", () => {
    expect(senderIsAgentHome(stored(), HOME)).toBe(true);
    expect(senderIsAgentHome(stored(), OTHER)).toBe(false);
    for (const home of [null, undefined, ""]) {
      expect(senderIsAgentHome(stored({ originatorInstanceId: home }), "")).toBe(false);
      expect(senderIsAgentHome(stored({ originatorInstanceId: home }), OTHER)).toBe(false);
    }
    expect(senderIsAgentHome(null, HOME)).toBe(false);
  });
});

describe("flair#2665 agentIdentityRefusal", () => {
  test("a key or home change from a sender that is not the stored home is refused", () => {
    expect(agentIdentityRefusal(rec({ publicKey: "key-2" }), stored(), OTHER)).toBe("agent_identity_not_from_home");
    expect(agentIdentityRefusal(rec({ originatorInstanceId: OTHER }), stored(), OTHER)).toBe("agent_identity_not_from_home");
    expect(agentIdentityRefusal(rec({ originatorInstanceId: null }), stored(), OTHER)).toBe("agent_identity_not_from_home");
  });

  test("the same change from the stored home is not refused", () => {
    expect(agentIdentityRefusal(rec({ publicKey: "key-2" }), stored(), HOME)).toBeNull();
    expect(agentIdentityRefusal(rec({ originatorInstanceId: OTHER }), stored(), HOME)).toBeNull();
  });

  test("a row with no recorded home takes a key change, or a non-empty home, from no sender", () => {
    for (const home of [null, undefined, ""]) {
      const row = stored({ originatorInstanceId: home });
      expect(agentIdentityRefusal(rec({ publicKey: "key-2" }), row, OTHER)).toBe("agent_identity_not_from_home");
      expect(agentIdentityRefusal(rec({ originatorInstanceId: OTHER }), row, OTHER)).toBe("agent_identity_not_from_home");
    }
  });

  test("unchanged identity fields (missing, null and empty homes compare equal), a new row and other tables are not refused", () => {
    expect(agentIdentityRefusal(rec({ publicKey: "key-1", originatorInstanceId: HOME, name: "x" }), stored(), OTHER)).toBeNull();
    expect(agentIdentityRefusal(rec({ name: "x" }), stored(), OTHER)).toBeNull();
    expect(agentIdentityRefusal(rec({ originatorInstanceId: "" }), stored({ originatorInstanceId: null }), OTHER)).toBeNull();
    expect(agentIdentityRefusal(rec({ publicKey: "key-2" }), null, OTHER)).toBeNull();
    expect(inboundChangesAgentIdentity(rec({ publicKey: "key-2" }, "Soul"), stored())).toBe(false);
  });
});

describe("flair#2665 keepReceiverAgentAuthority", () => {
  test("a new row is written without the admin fields", () => {
    const merged = keepReceiverAgentAuthority({ id: "agent-a", role: "admin", admin: true }, null);
    expect("role" in merged).toBe(false);
    expect(merged.admin).toBe(false);
    expect(keepReceiverAgentAuthority({ id: "agent-a", role: "researcher" }, null).role).toBe("researcher");
  });

  test("an existing row keeps its stored admin fields in both directions", () => {
    const up = keepReceiverAgentAuthority({ ...stored(), role: "admin", admin: true }, stored());
    expect(up.role).toBe("agent");
    expect(up.admin).toBe(false);
    const down = keepReceiverAgentAuthority({ ...stored(), role: "agent", admin: false }, stored({ role: "admin", admin: true }));
    expect(down.role).toBe("admin");
    expect(down.admin).toBe(true);
    const mirrorOnly = keepReceiverAgentAuthority({ ...stored(), admin: true }, stored());
    expect(mirrorOnly.admin).toBe(false);
    const absent = keepReceiverAgentAuthority({ id: "agent-a", role: "admin", admin: true }, { id: "agent-a" });
    expect("role" in absent).toBe(false);
    expect("admin" in absent).toBe(false);
  });

  test("a role label follows the merge when the stored and incoming roles are both non-admin", () => {
    expect(keepReceiverAgentAuthority({ ...stored(), role: "researcher" }, stored()).role).toBe("researcher");
  });
});

describe("flair#2665 agentAdminIdCreateRefusal", () => {
  const configured = configuredAdminAgentIds({ FLAIR_ADMIN_AGENTS: " agent-a , ,agent-b" });

  test("the configured set is the comma-separated, trimmed, non-empty ids", () => {
    expect([...configured].sort()).toEqual(["agent-a", "agent-b"]);
    expect(configuredAdminAgentIds({}).size).toBe(0);
  });

  test("creating a row for a configured id is refused; an existing row and other ids are not", () => {
    expect(agentAdminIdCreateRefusal(rec({ name: "x" }), null, configured)).toBe("agent_admin_id_not_federated");
    expect(agentAdminIdCreateRefusal(rec({ name: "x" }), stored(), configured)).toBeNull();
    expect(agentAdminIdCreateRefusal({ ...rec({}), id: "agent-c", data: { id: "agent-c" } }, null, configured)).toBeNull();
    expect(agentAdminIdCreateRefusal(rec({}, "Soul"), null, configured)).toBeNull();
  });
});
