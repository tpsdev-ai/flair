// auth-middleware e2e — real-Harper integration tests (ops-ketv).
//
// Replaces the simulator-based unit tests (simulateAuthMiddleware + super_user/
// getUser mock blocks) with real HTTP requests against a live Harper instance.
// Two K&S-approved PRs shipped real auth bugs past the mirror-function tests;
// this file closes that gap by exercising every auth path against the real
// auth-middleware + Harper's actual getUser / role resolution.
//
// MODEL: test/integration/ed25519-auth-hnsw.test.ts — boots Harper via
// startHarper(), seeds data via the ops API, sends real HTTP requests with
// TPS-Ed25519 / Basic headers, asserts HTTP status codes.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID, randomBytes } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairPairInitiatorRole } from "../../src/cli";

// ─── Crypto / header helpers (same pattern as ed25519-auth-hnsw.test.ts) ─────

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return {
    id,
    publicKey: Buffer.from(kp.publicKey).toString("base64"),
    secretKey: kp.secretKey,
  };
}

/**
 * Build a TPS-Ed25519 Authorization header.
 *
 * GOTCHA: the server verifies the signature over `url.pathname + url.search`,
 * so the `path` argument MUST include the query string for GET requests
 * (e.g. `/Memory/?agentId=X`).
 *
 * GOTCHA: authentication() caches by Authorization header including negatives;
 * every TPS request must use a fresh nonce (randomUUID() per call).
 */
function ed25519Header(
  agent: TestAgent,
  method: string,
  path: string,
  opts: { tamper?: boolean } = {},
): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(
    new TextEncoder().encode(payload),
    agent.secretKey,
  );
  let sigB64 = Buffer.from(sig).toString("base64");
  if (opts.tamper) {
    sigB64 =
      sigB64.slice(0, -4) + (sigB64.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
  }
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${sigB64}`;
}

// ─── Ops API helper ──────────────────────────────────────────────────────────

async function adminOp(
  harper: HarperInstance,
  op: Record<string, any>,
): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

let harper: HarperInstance;
const agent = mkAgent("auth-e2e-agent");

const PAIR_BOOTSTRAP_USER = "pair-bootstrap-test1234";
const PAIR_BOOTSTRAP_PASS = "bootstrap-pass-123";

const PAIR_BOOTSTRAP_DISABLED = "pair-bootstrap-disabled0";
const PAIR_BOOTSTRAP_DISABLED_PASS = "disabled-pass-123";

const NON_SUPER_USER = "regular-user-e2e";
const NON_SUPER_PASS = "regular-pass-123";

// ─── beforeAll: provision Harper with all needed records ─────────────────────

describe("auth-middleware e2e (real Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();

    // 1. Provision flair_pair_initiator role (canonical spec).
    await ensureFlairPairInitiatorRole(
      harper.opsURL,
      harper.admin.username,
      harper.admin.password,
    );

    // 2. Create Agent record with a known Ed25519 public key.
    const agentRes = await adminOp(harper, {
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [
        {
          id: agent.id,
          name: agent.id,
          role: "agent",
          publicKey: agent.publicKey,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(agentRes.status).toBe(200);

    // 3. Create pair-bootstrap user with flair_pair_initiator role + active:true.
    //    This makes getUser return the REAL object-shaped role
    //    ({ role: { role: "flair_pair_initiator", permission: {...} }, active: true }),
    //    the only way to catch Bug 1 (role.role vs role regression).
    const pairUserRes = await adminOp(harper, {
      operation: "add_user",
      username: PAIR_BOOTSTRAP_USER,
      password: PAIR_BOOTSTRAP_PASS,
      role: "flair_pair_initiator",
      active: true,
    });
    // 200 = created; 409 = already exists (idempotent re-run).
    expect([200, 409]).toContain(pairUserRes.status);

    // 4. Create a disabled pair-bootstrap user (active:false) for the
    //    active:false → 401 negative case.
    const disabledRes = await adminOp(harper, {
      operation: "add_user",
      username: PAIR_BOOTSTRAP_DISABLED,
      password: PAIR_BOOTSTRAP_DISABLED_PASS,
      role: "flair_pair_initiator",
      active: false,
    });
    expect([200, 409]).toContain(disabledRes.status);

    // 5. Create a non-super_user role + user (no super_user permission).
    const nonSuperRole = "e2e_non_super";
    const addRoleRes = await adminOp(harper, {
      operation: "add_role",
      role: nonSuperRole,
      permission: { super_user: false, structure_user: false },
    });
    // 200 = created; 409 = already exists.
    expect([200, 409]).toContain(addRoleRes.status);

    const nonSuperRes = await adminOp(harper, {
      operation: "add_user",
      username: NON_SUPER_USER,
      password: NON_SUPER_PASS,
      role: nonSuperRole,
      active: true,
    });
    expect([200, 409]).toContain(nonSuperRes.status);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTH INVARIANTS: no Authorization header → auth rejection on guarded paths.
  //
  // GOTCHA: authorizeLocal (dev mode + localhost) can auto-authorize as
  // super_user. EVERY new auth test MUST include a no-Authorization-header
  // invariant, or it can pass while proving nothing.
  //
  // NOTE: /FederationPair and /FederationSync are in the public allowlist
  // (auth-middleware.ts lines 112-116) — they pass through without auth and
  // return resource-level errors (400 for missing body), not 401.
  // /Soul GET does not enforce auth (only POST does). These endpoints are
  // excluded from the no-auth invariant.
  // ═══════════════════════════════════════════════════════════════════════════

  test("AUTH INVARIANT: no Authorization header on /Memory → 401", async () => {
    const res = await fetch(
      `${harper.httpURL}/Memory/?agentId=${agent.id}`,
    );
    expect(res.status).toBe(401);
  }, 30_000);

  test("AUTH INVARIANT: no Authorization header on /Agent → 403 (Harper default denies anonymous table access)", async () => {
    const res = await fetch(`${harper.httpURL}/Agent`);
    // Harper's built-in auth returns 403 for unauthenticated table access
    // (the custom middleware's 401 for missing auth header runs first, but
    // Harper's table-level gate also fires).
    expect(res.status).toBe(403);
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // Bug 1 — Basic / Path 3: flair_pair_initiator (pair-bootstrap-XXXX)
  //
  // Regression guard: the auth middleware at auth-middleware.ts:210 checks
  // pairUser?.role?.role === "flair_pair_initiator". If anyone regresses this
  // back to pairUser?.role === "flair_pair_initiator" (flat-string check),
  // the real object-shaped role from getUser won't match and pair-bootstrap
  // users will 401 on /FederationPair. The old simulator tests used hand-
  // written mock data that could be shaped either way — only a real Harper
  // getUser call returns the true object shape.
  // ═══════════════════════════════════════════════════════════════════════════

  test("Bug 1 guard: pair-bootstrap Basic on /FederationPair → NOT 401 (reaches resource)", async () => {
    const res = await fetch(`${harper.httpURL}/FederationPair`, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + btoa(`${PAIR_BOOTSTRAP_USER}:${PAIR_BOOTSTRAP_PASS}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    // Must NOT be 401 — the auth middleware should pass this through.
    // The resource handler returns its own error (e.g. 400 for missing
    // instanceId/publicKey), but NOT a generic Login-failed 401.
    const text = await res.text();
    expect(res.status, `POST /FederationPair returned ${res.status}: ${text.slice(0, 200)}`).not.toBe(401);
    const body = JSON.parse(text);
    expect(body.error).not.toBe("Login failed");
  }, 30_000);

  test("Bug 1 guard: pair-bootstrap Basic on /Memory → 403 (Harper built-in denies table access before custom middleware)", async () => {
    // With the non-rejecting gate, the custom middleware would annotate this
    // as anonymous and pass through. However, Harper's built-in auth runs
    // FIRST, sees valid Basic creds for a user with no table permissions,
    // and returns 403 before the custom middleware gets a chance to run.
    const res = await fetch(
      `${harper.httpURL}/Memory/?agentId=${agent.id}`,
      {
        headers: {
          Authorization:
            "Basic " + btoa(`${PAIR_BOOTSTRAP_USER}:${PAIR_BOOTSTRAP_PASS}`),
        },
      },
    );
    expect(res.status).toBe(403);
  }, 30_000);

  test("Bug 1 guard: pair-bootstrap Basic on /Soul → 403 (Harper built-in denies table access)", async () => {
    const res = await fetch(`${harper.httpURL}/Soul`, {
      headers: {
        Authorization:
          "Basic " + btoa(`${PAIR_BOOTSTRAP_USER}:${PAIR_BOOTSTRAP_PASS}`),
      },
    });
    expect(res.status).toBe(403);
  }, 30_000);

  test("Bug 1 guard: pair-bootstrap Basic on /Agent → 403 (Harper built-in denies table access)", async () => {
    const res = await fetch(`${harper.httpURL}/Agent`, {
      headers: {
        Authorization:
          "Basic " + btoa(`${PAIR_BOOTSTRAP_USER}:${PAIR_BOOTSTRAP_PASS}`),
      },
    });
    expect(res.status).toBe(403);
  }, 30_000);

  test("Bug 1 guard: pair-bootstrap Basic on /FederationSync → 400 (public allowlist, resource-level error)", async () => {
    // /FederationSync is in the public allowlist — passes through without
    // auth. The resource returns 400 for missing body fields.
    const res = await fetch(`${harper.httpURL}/FederationSync`, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + btoa(`${PAIR_BOOTSTRAP_USER}:${PAIR_BOOTSTRAP_PASS}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  }, 30_000);

  test("Bug 1 negative: wrong password for pair-bootstrap → 401", async () => {
    const res = await fetch(`${harper.httpURL}/FederationPair`, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + btoa(`${PAIR_BOOTSTRAP_USER}:wrong-password`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  }, 30_000);

  test("Bug 1 negative: active:false pair-bootstrap user → 401", async () => {
    const res = await fetch(`${harper.httpURL}/FederationPair`, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          btoa(`${PAIR_BOOTSTRAP_DISABLED}:${PAIR_BOOTSTRAP_DISABLED_PASS}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // Bug 2 — TPS-Ed25519 / Path 5: agent signature auth
  //
  // Regression guard: the old "swap header to Basic admin" trick was silently
  // ignored by Harper 5.0.9+ (which resolves request.user BEFORE custom
  // middleware runs), causing EVERY Ed25519-authenticated request to 401 with
  // "Login failed". The simulator tests never sent real HTTP requests, so they
  // couldn't catch this. These cases send real TPS-Ed25519 headers to real
  // Harper and assert on HTTP status codes.
  // ═══════════════════════════════════════════════════════════════════════════

  test("Bug 2 guard: valid TPS-Ed25519 on /FederationSync → NOT auth-rejected (downstream status, not 401 Login-failed)", async () => {
    const path = "/FederationSync";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: {
        Authorization: ed25519Header(agent, "POST", path),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    // Must NOT be 401 Login-failed. The resource handler returns its own
    // error (e.g. 400 for missing instanceId, or a signature error), not a
    // generic auth rejection.
    const text = await res.text();
    expect(
      res.status,
      `POST /FederationSync returned ${res.status}: ${text.slice(0, 200)}`,
    ).not.toBe(401);
    const body = JSON.parse(text);
    expect(body.error).not.toBe("Login failed");
  }, 30_000);

  test("Bug 2 guard: TPS-Ed25519 on GET /Memory/?agentId=X → 200", async () => {
    // GOTCHA: the Ed25519 signed payload is url.pathname + url.search.
    // When testing GET /Memory/?agentId=X, sign the full path INCLUDING
    // the query string.
    const path = `/Memory/?agentId=${agent.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(agent, "GET", path) },
    });
    const text = await res.text();
    expect(
      res.status,
      `GET /Memory returned ${res.status}: ${text.slice(0, 200)}`,
    ).toBe(200);
    expect(text).not.toContain("Login failed");
  }, 30_000);

  test("Bug 2 negative: no TPS-Ed25519 header on /FederationSync → 400 (public allowlist, resource-level error)", async () => {
    // /FederationSync is in the public allowlist — passes through without
    // auth. The resource returns 400 for missing body fields.
    const res = await fetch(`${harper.httpURL}/FederationSync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  }, 30_000);

  test("Bug 2 negative: tampered signature → 401 invalid_signature", async () => {
    const path = `/Memory/?agentId=${agent.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: {
        Authorization: ed25519Header(agent, "GET", path, { tamper: true }),
      },
    });
    expect(res.status).toBe(401);
    const body: any = await res.json().catch(() => ({}));
    expect(body.error).toBe("invalid_signature");
  }, 30_000);

  test("Bug 2 negative: unknown agent → 401 unknown_agent", async () => {
    const unknownAgent = mkAgent("unknown-e2e-agent");
    const path = `/Memory/?agentId=${unknownAgent.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: {
        Authorization: ed25519Header(unknownAgent, "GET", path),
      },
    });
    expect(res.status).toBe(401);
    const body: any = await res.json().catch(() => ({}));
    expect(body.error).toBe("unknown_agent");
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // Bug 1 — Basic / Path 2: super_user
  //
  // The old simulator tests used a mock getUser that returned hand-written
  // objects. Only real Harper getUser returns the true permission shape.
  // ═══════════════════════════════════════════════════════════════════════════

  test("Bug 1 guard: real super_user (admin) via Basic → 200", async () => {
    const res = await fetch(
      `${harper.httpURL}/Memory/?agentId=${agent.id}`,
      {
        headers: {
          Authorization:
            "Basic " +
            btoa(`${harper.admin.username}:${harper.admin.password}`),
        },
      },
    );
    expect(res.status).toBe(200);
  }, 30_000);

  test("Bug 1 guard: real non-super_user via Basic → 403 (Harper built-in denies table access)", async () => {
    // Non-super_user Basic: Harper's built-in auth authenticates the user
    // but denies table access (403) before the custom middleware's
    // non-rejecting gate can annotate as anonymous.
    const res = await fetch(
      `${harper.httpURL}/Memory/?agentId=${agent.id}`,
      {
        headers: {
          Authorization:
            "Basic " + btoa(`${NON_SUPER_USER}:${NON_SUPER_PASS}`),
        },
      },
    );
    expect(res.status).toBe(403);
  }, 30_000);
});
