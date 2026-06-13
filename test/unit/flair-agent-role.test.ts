import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { ensureFlairAgentRole } from "../../src/cli";

// Mirrors the federation-pair-role.test.ts pattern: a sequenced global-fetch mock
// that captures the ops-API bodies ensureFlairAgentRole sends.

const OPS_URL = "http://localhost:9925";
const ADMIN = "admin";
const PASS = "secret";
const ROLE_NAME = "flair_agent";

let capturedBodies: Array<Record<string, any>> = [];
const origFetch = globalThis.fetch;

beforeEach(() => { capturedBodies = []; });
afterEach(() => { globalThis.fetch = origFetch; });

function installFetch(responses: Array<{ ok: boolean; body: unknown }>) {
  capturedBodies = []; // each install starts a fresh capture window
  let idx = 0;
  globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    capturedBodies.push(body);
    const resp = responses[idx++];
    if (!resp) throw new Error(`Unexpected fetch call #${idx}`);
    return {
      ok: resp.ok,
      status: resp.ok ? 200 : 500,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    } as unknown as Response;
  }) as any;
}

describe("ensureFlairAgentRole — idempotency", () => {
  it("calls add_role when flair_agent does not exist", async () => {
    installFetch([
      { ok: true, body: [] },          // list_roles → empty
      { ok: true, body: { ok: true } }, // add_role
    ]);
    await ensureFlairAgentRole(OPS_URL, ADMIN, PASS);
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0].operation).toBe("list_roles");
    expect(capturedBodies[1].operation).toBe("add_role");
    expect(capturedBodies[1].role).toBe(ROLE_NAME);
  });

  it("is a no-op when the role already matches the canonical spec", async () => {
    // First call to capture the canonical permission the impl sends...
    installFetch([{ ok: true, body: [] }, { ok: true, body: { ok: true } }]);
    await ensureFlairAgentRole(OPS_URL, ADMIN, PASS);
    const canonical = capturedBodies[1].permission;

    // ...then prove an existing role with that exact spec is left untouched.
    installFetch([{ ok: true, body: [{ role: ROLE_NAME, permission: canonical }] }]);
    await ensureFlairAgentRole(OPS_URL, ADMIN, PASS);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].operation).toBe("list_roles");
  });

  it("calls alter_role when an existing role has different permissions", async () => {
    installFetch([
      { ok: true, body: [{ role: ROLE_NAME, permission: { super_user: true } }] },
      { ok: true, body: { ok: true } },
    ]);
    await ensureFlairAgentRole(OPS_URL, ADMIN, PASS);
    expect(capturedBodies[1].operation).toBe("alter_role");
    expect(capturedBodies[1].role).toBe(ROLE_NAME);
  });
});

describe("ensureFlairAgentRole — security invariants of the grant spec", () => {
  async function captureSpec(): Promise<any> {
    installFetch([{ ok: true, body: [] }, { ok: true, body: { ok: true } }]);
    await ensureFlairAgentRole(OPS_URL, ADMIN, PASS);
    return capturedBodies[1].permission;
  }

  it("never grants super_user/structure_user, and omits cluster_user (Harper misreads it as a db)", async () => {
    const perm = await captureSpec();
    expect(perm.super_user).toBe(false);
    expect(perm.structure_user).toBe(false);
    // cluster_user must NOT be present — Harper reads unknown top-level keys as
    // database names and rejects add_role ("database 'cluster_user' does not exist").
    expect(perm.cluster_user).toBeUndefined();
  });

  it("every table grant carries an attribute_permissions array (add_role requires it)", async () => {
    const tables = (await captureSpec()).flair.tables;
    for (const [name, t] of Object.entries<any>(tables)) {
      expect(Array.isArray(t.attribute_permissions), `${name} missing attribute_permissions array`).toBe(true);
    }
  });

  it("carries no operations grant → /sql and /graphql stay natively 403 for agents", async () => {
    const perm = await captureSpec();
    // No top-level operation/operations permission of any kind.
    expect(perm.operation).toBeUndefined();
    expect(perm.operations).toBeUndefined();
  });

  it("keys grants on real @table names, not the pair-initiator shorthand", async () => {
    const perm = await captureSpec();
    const tables = perm.flair.tables;
    // Real names present...
    for (const t of ["Memory", "OrgEvent", "WorkspaceState", "OAuthClient", "Soul"]) {
      expect(tables[t]).toBeDefined();
    }
    // ...and the misleading shorthand the all-false pair role used is absent.
    for (const t of ["Event", "Workspace", "OAuth"]) {
      expect(tables[t]).toBeUndefined();
    }
  });

  it("lets agents CRUD their own core data but locks federation/oauth/idp internals", async () => {
    const tables = (await captureSpec()).flair.tables;
    // Agent-owned data: writable (row-ownership is enforced in allow*, not here).
    expect(tables.Memory).toEqual({ read: true, insert: true, update: true, delete: true, attribute_permissions: [] });
    expect(tables.OrgEvent.insert).toBe(true);
    expect(tables.WorkspaceState.update).toBe(true);
    // System/admin-only tables: no access at all.
    for (const t of ["Peer", "PairingToken", "SyncLog", "OAuthClient", "OAuthToken", "IdpConfig", "IdJagReplay"]) {
      expect(tables[t]).toEqual({ read: false, insert: false, update: false, delete: false, attribute_permissions: [] });
    }
  });
});
