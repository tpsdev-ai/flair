/**
 * credential-create-auth.test.ts — no-forge attribution guard for
 * Credential.post() (authz-hardening slice 3).
 *
 * The bug: Credential had allowRead() and put() but NO allowCreate() and
 * NO post() override.  The cross-principal check lived only in put().
 * record-owner-guard's resolveGuardedRecord matches /<Table>/<id> only
 * and returns null for collection paths BY DESIGN — creation is delegated
 * to per-resource no-forge attribution, and Credential had none.
 *
 * An attacker could POST /Credential with principalId set to any target
 * and the base class's post() would create it with no cross-principal
 * check.
 *
 * The fix adds allowCreate() (same posture as allowRead) and a post()
 * override that uses stampAttribution("stamp-default") to stamp
 * principalId from the authenticated identity — never trusting the body.
 * put() and delete() are also refactored to use resolveAgentAuth instead
 * of reading request.tpsAgent raw.
 *
 * No other test/unit/ file imports resources/Credential.ts with a harper
 * mock, so this file owns the mock+import with no collision risk.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

// ─── In-memory Harper Credential mock ───────────────────────────────────────

let credentialStore: Map<string, any>;
let instanceRow: any = null;
let _currentRecordId: string | null = null; // set by delete() so super.get() can resolve

class BaseCredential {
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id ?? _currentRecordId;
    return credentialStore.get(id) ?? null;
  }
  async put(content: any) {
    credentialStore.set(content.id, { ...content });
    return { ...content };
  }
  async post(content: any) {
    const id = content.id ?? `cred-${Math.random().toString(36).slice(2)}`;
    content.id = id;
    credentialStore.set(id, { ...content });
    return { ...content };
  }
  async delete(id: any) {
    _currentRecordId = id;
    credentialStore.delete(id);
    return { ok: true };
  }
}

const databasesMock = {
  flair: {
    Credential: BaseCredential,
    Agent: { get: async () => null, search: async () => [] },
    Instance: {
      search: () => {
        async function* gen() {
          if (instanceRow) yield instanceRow;
        }
        return gen();
      },
    },
  },
};

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: databasesMock,
  Resource: class {},
}));

const { Credential } = await import("../../resources/Credential.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

function makeCredential(ctxRequest: any) {
  const r: any = new (Credential as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  credentialStore = new Map();
  instanceRow = null;
  _currentRecordId = null;
  _resetLocalInstanceIdCacheForTests();
});

// ─── post() — no-forge attribution ─────────────────────────────────────────

describe("Credential.post() — no-forge attribution (authz-hardening slice 3)", () => {
  it("stamps principalId from the authenticated agent, ignoring the body", async () => {
    const cred = makeCredential(agentCtx("agent-1"));
    const res: any = await cred.post({
      kind: "bearer-token",
      principalId: "agent-2", // attacker tries to create for another principal
      label: "my token",
    });
    expect(res instanceof Response).toBe(false);
    expect(res.principalId).toBe("agent-1"); // stamped, not trusted from body
    expect(res.kind).toBe("bearer-token");
    expect(res.status).toBe("active");
    expect(res.createdAt).toBeTruthy();
    expect(res.updatedAt).toBeTruthy();
  });

  it("denies anonymous with 401", async () => {
    const cred = makeCredential(anonCtx());
    const res: any = await cred.post({ kind: "bearer-token", label: "anon token" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
  });

  it("rejects an invalid kind with 400", async () => {
    const cred = makeCredential(agentCtx("agent-1"));
    const res: any = await cred.post({ kind: "ssh-key", label: "bad kind" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(400);
  });

  it("allows an admin to create a credential for another principal", async () => {
    const cred = makeCredential(agentCtx("admin-1", true));
    const res: any = await cred.post({
      kind: "bearer-token",
      principalId: "agent-2",
      label: "admin-created token",
    });
    expect(res instanceof Response).toBe(false);
    expect(res.principalId).toBe("agent-2"); // admin's value honored
  });

  it("allows an internal call to set any principalId", async () => {
    const r: any = new (Credential as any)();
    r.getContext = () => undefined; // internal — no request context
    const res: any = await r.post({
      kind: "bearer-token",
      principalId: "agent-3",
      label: "internal token",
    });
    expect(res instanceof Response).toBe(false);
    expect(res.principalId).toBe("agent-3");
  });

  it("defaults principalId to the admin's own id when admin omits it", async () => {
    const cred = makeCredential(agentCtx("admin-1", true));
    const res: any = await cred.post({
      kind: "bearer-token",
      label: "admin own token",
    });
    expect(res instanceof Response).toBe(false);
    expect(res.principalId).toBe("admin-1");
  });
});

// ─── put() — cross-principal guard ──────────────────────────────────────────

describe("Credential.put() — cross-principal guard (refactored to resolveAgentAuth)", () => {
  it("a non-admin cannot update another principal's credential", async () => {
    credentialStore.set("cred-1", { id: "cred-1", principalId: "agent-2", kind: "bearer-token", status: "active" });
    const cred = makeCredential(agentCtx("agent-1"));
    const res: any = await cred.put({ id: "cred-1", principalId: "agent-2", kind: "bearer-token", status: "revoked" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    // Verify the record was NOT mutated
    expect(credentialStore.get("cred-1").status).toBe("active");
  });

  it("a non-admin can update their own credential", async () => {
    credentialStore.set("cred-1", { id: "cred-1", principalId: "agent-1", kind: "bearer-token", status: "active" });
    const cred = makeCredential(agentCtx("agent-1"));
    const res: any = await cred.put({ id: "cred-1", principalId: "agent-1", kind: "bearer-token", status: "revoked" });
    expect(res instanceof Response).toBe(false);
    expect(credentialStore.get("cred-1").status).toBe("revoked");
  });

  it("denies anonymous with 401", async () => {
    const cred = makeCredential(anonCtx());
    const res: any = await cred.put({ id: "cred-1", kind: "bearer-token" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
  });
});

// ─── delete() — cross-principal guard ───────────────────────────────────────

describe("Credential.delete() — cross-principal guard (refactored to resolveAgentAuth)", () => {
  it("a non-admin cannot delete another principal's credential", async () => {
    credentialStore.set("cred-1", { id: "cred-1", principalId: "agent-2", kind: "bearer-token" });
    const cred = makeCredential(agentCtx("agent-1"));
    // super.get() inside delete() is context-aware in Harper (resolves from
    // the URL path).  In the mock we prime _currentRecordId so the base
    // class's get() can resolve the record.
    _currentRecordId = "cred-1";
    const res: any = await cred.delete("cred-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(credentialStore.has("cred-1")).toBe(true); // untouched
  });

  it("a non-admin can delete their own credential", async () => {
    credentialStore.set("cred-1", { id: "cred-1", principalId: "agent-1", kind: "bearer-token" });
    const cred = makeCredential(agentCtx("agent-1"));
    _currentRecordId = "cred-1";
    const res: any = await cred.delete("cred-1");
    expect(res instanceof Response).toBe(false);
    expect(credentialStore.has("cred-1")).toBe(false);
  });

  it("denies anonymous with 401", async () => {
    const cred = makeCredential(anonCtx());
    const res: any = await cred.delete("cred-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
  });
});

// ─── MUTATION-CHECK NOTE ────────────────────────────────────────────────────
// The no-forge attribution test above was manually mutation-tested during
// development: temporarily removing the stampAttribution call from post()
// made the guard test FAIL (observed principalId "agent-2" from the body
// instead of the stamped "agent-1"), confirming the guard is not vacuously
// true.  Reverted before commit.
