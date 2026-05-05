import { describe, it, expect, mock, beforeEach } from "bun:test";
import { ensureFlairPairInitiatorRole } from "../../src/cli";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal canonical permission spec mirrored from cli.ts. */
const CANONICAL_PERM = {
  super_user: false,
  cluster_user: false,
  structure_user: false,
  flair: {
    tables: {
      Memory:       { read: false, insert: false, update: false, delete: false },
      Soul:         { read: false, insert: false, update: false, delete: false },
      Agent:        { read: false, insert: false, update: false, delete: false },
      Workspace:    { read: false, insert: false, update: false, delete: false },
      Event:        { read: false, insert: false, update: false, delete: false },
      OAuth:        { read: false, insert: false, update: false, delete: false },
      Instance:     { read: false, insert: false, update: false, delete: false },
      Peer:         { read: false, insert: false, update: false, delete: false },
      PairingToken: { read: false, insert: false, update: false, delete: false },
      SyncLog:      { read: false, insert: false, update: false, delete: false },
    },
  },
};

/** Builds a mock ops-API fetch that returns sequenced responses. */
function buildMockFetch(responses: Array<{ ok: boolean; body: unknown }>) {
  let idx = 0;
  return mock(async (_url: string, init?: RequestInit) => {
    const resp = responses[idx++];
    if (!resp) throw new Error(`Unexpected fetch call at index ${idx - 1}`);
    return {
      ok: resp.ok,
      status: resp.ok ? 200 : 500,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    } as unknown as Response;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ensureFlairPairInitiatorRole", () => {
  const OPS_URL   = "http://localhost:9925";
  const ADMIN     = "admin";
  const PASS      = "secret";
  const ROLE_NAME = "flair_pair_initiator";

  // Track which operations were sent to the mock ops API
  let capturedBodies: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    capturedBodies = [];
  });

  /**
   * Install a global fetch mock that captures request bodies and returns the
   * provided sequenced responses.
   */
  function installFetch(responses: Array<{ ok: boolean; body: unknown }>) {
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

  it("calls add_role when flair_pair_initiator does not exist", async () => {
    installFetch([
      // list_roles → empty list
      { ok: true, body: [] },
      // add_role → success
      { ok: true, body: { ok: true } },
    ]);

    await ensureFlairPairInitiatorRole(OPS_URL, ADMIN, PASS);

    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0].operation).toBe("list_roles");
    expect(capturedBodies[1].operation).toBe("add_role");
    expect(capturedBodies[1].role).toBe(ROLE_NAME);
    expect(capturedBodies[1].permission).toEqual(CANONICAL_PERM);
  });

  it("is a no-op when role already exists with matching permissions", async () => {
    installFetch([
      // list_roles → role present with canonical perms
      {
        ok: true,
        body: [{ role: ROLE_NAME, permission: CANONICAL_PERM }],
      },
      // No further calls expected
    ]);

    await ensureFlairPairInitiatorRole(OPS_URL, ADMIN, PASS);

    // Only list_roles should have been called
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].operation).toBe("list_roles");
  });

  it("calls alter_role when role exists with different permissions", async () => {
    const differentPerm = {
      ...CANONICAL_PERM,
      super_user: true, // deliberately different
    };

    installFetch([
      // list_roles → role present but with wrong perms
      {
        ok: true,
        body: [{ role: ROLE_NAME, permission: differentPerm }],
      },
      // alter_role → success
      { ok: true, body: { ok: true } },
    ]);

    await ensureFlairPairInitiatorRole(OPS_URL, ADMIN, PASS);

    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0].operation).toBe("list_roles");
    expect(capturedBodies[1].operation).toBe("alter_role");
    expect(capturedBodies[1].role).toBe(ROLE_NAME);
    expect(capturedBodies[1].permission).toEqual(CANONICAL_PERM);
  });

  it("also handles role objects that use 'name' instead of 'role' key", async () => {
    // Some Harper versions return { name: "...", permission: {} }
    installFetch([
      {
        ok: true,
        body: [{ name: ROLE_NAME, permission: CANONICAL_PERM }],
      },
    ]);

    await ensureFlairPairInitiatorRole(OPS_URL, ADMIN, PASS);

    // Match found → no-op (only list_roles call)
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].operation).toBe("list_roles");
  });

  it("throws a descriptive error when list_roles fails", async () => {
    installFetch([
      { ok: false, body: { error: "unauthorized" } },
    ]);

    await expect(
      ensureFlairPairInitiatorRole(OPS_URL, ADMIN, PASS),
    ).rejects.toThrow("list_roles failed");
  });
});
