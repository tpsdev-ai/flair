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
    return true;
  }
  // PATCH merges into the row Harper loaded for the request (_currentRecordId).
  async patch(content: any) {
    const id = _currentRecordId;
    if (id == null) throw new Error("mock: no loaded record for PATCH");
    credentialStore.set(id, { ...(credentialStore.get(id) ?? {}), ...content });
    return undefined;
  }
  // Harper's table is static-callable (`databases.flair.Credential.get/delete`),
  // which is how the owner-delete confirmation reaches it (flair#2355).
  static get(target?: any) { return new BaseCredential().get(target); }
  static delete(id: any) { return new BaseCredential().delete(id); }
}

// Harper assigns `transaction` onto the global at load; the owner-delete
// confirmation (resources/owner-delete-recheck.ts) creates one when the caller
// has none. This mock's delete is not staged, so the stand-in just runs the cb.
(globalThis as any).transaction = (_ctx: any, cb: () => any) => cb();

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

// ─── IdP identity mappings: creation, identity changes, reactivation ───────
//
// A non-admin agent's POST/PUT/PATCH may not create a kind:"idp" row, change a
// row's kind to or from "idp", or change an idp row's principalId, idpProvider,
// idpSubject, or status (beyond revoking it); it may relabel and revoke its own.
// For a non-admin caller, put() writes only rows it owns, as every
// owner-scoped resource does.
// _currentRecordId stands in for the row Harper loads for the request, which a
// no-argument super.get() returns.

const IDP_SUB = "subject-from-request";

async function refusalOf(call: () => Promise<any>): Promise<{ status: number; body: any; thrown: boolean }> {
  let res: any;
  let thrown = false;
  try {
    res = await call();
  } catch (err) {
    res = err;
    thrown = true;
  }
  expect(res instanceof Response, `expected a Response, got ${String(res)}`).toBe(true);
  const text = await (res as Response).text();
  return { status: (res as Response).status, body: JSON.parse(text), thrown };
}

function seed(row: any) {
  credentialStore.set(row.id, { ...row });
  _currentRecordId = row.id;
}

const ownIdp = () => ({ id: "cred-idp", principalId: "agent-1", kind: "idp", idpProvider: "github", idpSubject: "alice", status: "active", label: "laptop" });

describe("Credential — a non-admin agent cannot create an IdP identity mapping", () => {
  it("post() refuses kind:idp with the named 403, stores nothing and does not echo the subject", async () => {
    const r = await refusalOf(() => makeCredential(agentCtx("agent-1")).post({ kind: "idp", idpProvider: "github", idpSubject: IDP_SUB }));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("idp_mapping_admin_only");
    expect(JSON.stringify(r.body)).not.toContain(IDP_SUB);
    expect(credentialStore.size).toBe(0);
  });

  it("put() refuses creating an idp mapping (thrown 403, idp_mapping_admin_only)", async () => {
    const r = await refusalOf(() => makeCredential(agentCtx("agent-1")).put({ id: "cred-new", kind: "idp", idpSubject: IDP_SUB }));
    expect(r.status).toBe(403);
    expect(r.thrown).toBe(true);
    expect(r.body.error).toBe("idp_mapping_admin_only");
    expect(credentialStore.has("cred-new")).toBe(false);
  });

  it("admins and internal callers still create idp rows; non-admins still create the other kinds", async () => {
    const admin: any = await makeCredential(agentCtx("admin-1", true)).post({ kind: "idp", principalId: "agent-2", idpSubject: "bob" });
    expect(admin instanceof Response).toBe(false);
    expect(admin.principalId).toBe("agent-2");
    const internal: any = new (Credential as any)();
    internal.getContext = () => undefined;
    expect((await internal.put({ id: "cred-int", principalId: "agent-3", kind: "idp", idpSubject: "carol" })) instanceof Response).toBe(false);
    for (const kind of ["webauthn", "bearer-token", "ed25519"]) {
      const own: any = await makeCredential(agentCtx("agent-1")).post({ kind });
      expect(own instanceof Response, kind).toBe(false);
      expect(own.principalId).toBe("agent-1");
    }
  });
});

describe("Credential — a non-admin write that changes a credential's kind to idp is refused", () => {
  it("put() refuses kind bearer-token → idp; the row is unchanged", async () => {
    seed({ id: "cred-b", principalId: "agent-1", kind: "bearer-token", status: "active" });
    const r = await refusalOf(() => makeCredential(agentCtx("agent-1")).put({ id: "cred-b", kind: "idp", idpSubject: IDP_SUB }));
    expect(r.status).toBe(403);
    expect(credentialStore.get("cred-b").kind).toBe("bearer-token");
  });

  it("patch() refuses kind → idp on a row that already carries idp fields; the row is unchanged", async () => {
    seed({ id: "cred-b", principalId: "agent-1", kind: "bearer-token", idpProvider: "github", idpSubject: IDP_SUB, status: "active" });
    const r = await refusalOf(() => makeCredential(agentCtx("agent-1")).patch({ kind: "idp" }));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("idp_mapping_admin_only");
    expect(credentialStore.get("cred-b").kind).toBe("bearer-token");
  });

  it("patch() refuses a body that is not one record object", async () => {
    seed({ id: "cred-b", principalId: "agent-1", kind: "bearer-token", status: "active" });
    const r = await refusalOf(() => makeCredential(agentCtx("agent-1")).patch([{ id: "cred-b", kind: "idp" }]));
    expect(r.status).toBe(400);
    expect(credentialStore.get("cred-b").kind).toBe("bearer-token");
  });
});

describe("Credential — a non-admin write that changes an idp mapping is refused", () => {
  for (const [what, change] of [
    ["idpSubject", { idpSubject: IDP_SUB }],
    ["idpProvider", { idpProvider: "other-idp" }],
    ["kind away from idp", { kind: "bearer-token" }],
    ["status revoked → active", { status: "active" }],
  ] as const) {
    it(`patch() refuses ${what}`, async () => {
      const row = ownIdp();
      if (what.startsWith("status")) row.status = "revoked";
      seed(row);
      const r = await refusalOf(() => makeCredential(agentCtx("agent-1")).patch({ ...change }));
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("idp_mapping_admin_only");
      expect(credentialStore.get("cred-idp")).toEqual(row);
    });
  }

  it("put() refuses an idpSubject change", async () => {
    seed(ownIdp());
    const r = await refusalOf(() => makeCredential(agentCtx("agent-1")).put({ ...ownIdp(), idpSubject: IDP_SUB }));
    expect(r.status).toBe(403);
    expect(credentialStore.get("cred-idp").idpSubject).toBe("alice");
  });

  it("put() reactivating a revoked row (status omitted defaults to active) is refused", async () => {
    seed({ ...ownIdp(), status: "revoked" });
    const { status: _omit, ...body } = ownIdp();
    const r = await refusalOf(() => makeCredential(agentCtx("agent-1")).put(body));
    expect(r.status).toBe(403);
    expect(credentialStore.get("cred-idp").status).toBe("revoked");
  });

  it("relabelling and revoking its own idp row still succeed", async () => {
    seed(ownIdp());
    expect(await makeCredential(agentCtx("agent-1")).patch({ label: "desktop" })).toBeUndefined();
    expect(await makeCredential(agentCtx("agent-1")).patch({ status: "revoked" })).toBeUndefined();
    const after = credentialStore.get("cred-idp");
    expect(after.label).toBe("desktop");
    expect(after.status).toBe("revoked");
    seed(ownIdp());
    const put: any = await makeCredential(agentCtx("agent-1")).put({ ...ownIdp(), label: "tablet" });
    expect(put instanceof Response).toBe(false);
    expect(credentialStore.get("cred-idp").label).toBe("tablet");
  });

  it("an admin may change an idp row's subject", async () => {
    seed(ownIdp());
    expect(await makeCredential(agentCtx("admin-1", true)).patch({ idpSubject: "dave" })).toBeUndefined();
    expect(credentialStore.get("cred-idp").idpSubject).toBe("dave");
  });
});

describe("Credential.put() — a non-admin writes only rows it owns", () => {
  it("refuses a write to a row stored under another principal", async () => {
    const theirs = { id: "cred-v", principalId: "agent-2", kind: "bearer-token", label: "theirs", status: "active" };
    seed(theirs);
    const r = await refusalOf(() => makeCredential(agentCtx("agent-1")).put({ id: "cred-v", kind: "bearer-token", label: "mine now" }));
    expect(r.status).toBe(403);
    expect(r.thrown).toBe(true);
    expect(r.body.error).toContain("owned by another principal");
    expect(credentialStore.get("cred-v")).toEqual(theirs);
  });

  it("refuses a row stored with no owner", async () => {
    seed({ id: "cred-x", kind: "bearer-token", status: "active" });
    const r = await refusalOf(() => makeCredential(agentCtx("agent-1")).put({ id: "cred-x", kind: "bearer-token" }));
    expect(r.status).toBe(403);
  });
});

// ─── MUTATION-CHECK NOTE ────────────────────────────────────────────────────
// The no-forge attribution test above was manually mutation-tested during
// development: temporarily removing the stampAttribution call from post()
// made the guard test FAIL (observed principalId "agent-2" from the body
// instead of the stamped "agent-1"), confirming the guard is not vacuously
// true.  Reverted before commit.
