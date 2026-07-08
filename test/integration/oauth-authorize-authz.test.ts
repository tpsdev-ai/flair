// oauth-authorize-authz.test.ts — Integration tests for flair#604 (the
// authorizeLocal escalation class), OAuthAuthorize.post() half.
//
// Harper's `authorizeLocal` (config.yaml: true) injects request.user =
// super_user for ANY credential-less LOOPBACK request (only suppressed when a
// real Authorization header is present). /OAuthAuthorize sits on
// auth-middleware.ts's public early-return passthrough (any method), so a
// bare local POST never gets OUR middleware's tpsAgent/tpsAnonymous
// annotation either — resolveAgentAuth() used to fall straight through to
// Harper's raw `context.user`, which authorizeLocal had already forged with
// NO signature and NO password, and mint a REAL admin authorization code —
// full local privilege escalation with zero credentials, exchangeable at
// /OAuthToken for a Bearer token.
//
// This is a REAL Harper spawn (config.yaml's authorizeLocal: true applies,
// same as every other integration test in this repo) — a mocked unit test
// cannot reproduce the ambient-elevation path at all (that's the #601
// lesson referenced throughout this PR).
//
// MODEL: test/integration/presence-api.test.ts + auth-middleware-e2e.test.ts.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";

// ─── Crypto / header helpers (same pattern as auth-middleware-e2e.test.ts) ───

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  const sigB64 = Buffer.from(sig).toString("base64");
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${sigB64}`;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

function codeFromRedirect(location: string | null): string | null {
  if (!location) return null;
  const url = new URL(location);
  return url.searchParams.get("code");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let harper: HarperInstance;
const agent = mkAgent("oauth-authz-e2e-agent");
let clientId: string;

describe("OAuthAuthorize.post() authz (flair#604 authorizeLocal escalation)", () => {
  beforeAll(async () => {
    harper = await startHarper();

    const agentRes = await adminOp(harper, {
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{
        id: agent.id,
        name: agent.id,
        role: "agent",
        publicKey: agent.publicKey,
        createdAt: new Date().toISOString(),
      }],
    });
    expect(agentRes.status).toBe(200);

    clientId = `flair_cl_test_${randomUUID()}`;
    const clientRes = await adminOp(harper, {
      operation: "insert",
      database: "flair",
      table: "OAuthClient",
      records: [{
        id: clientId,
        name: "604 test client",
        redirectUris: [ALLOWED_REDIRECT_URI],
        grantTypes: ["authorization_code", "refresh_token"],
        scope: "memory:read",
        registeredBy: "test",
        createdAt: new Date().toISOString(),
      }],
    });
    expect(clientRes.status).toBe(200);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  // ── THE ESCALATION: credential-less loopback POST must NOT mint a code ────

  test("#604: credential-less loopback POST /OAuthAuthorize (approve) → 401, mints NO code", async () => {
    const { challenge } = pkcePair();
    const state = randomUUID();

    const res = await fetch(`${harper.httpURL}/OAuthAuthorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        client_id: clientId,
        redirect_uri: ALLOWED_REDIRECT_URI,
        scope: "memory:read",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });

    // Must NOT be a 302 redirect carrying a minted code — that would be the
    // ambient-super_user escalation. Must be a 401 auth rejection instead.
    expect(res.status).toBe(401);
    const body: any = await res.json().catch(() => ({}));
    expect(body.error).toBe("authentication required");

    // Belt-and-suspenders: confirm no OAuthAuthCode record exists for this
    // client at all (nothing was minted under the hood).
    const search = await adminOp(harper, {
      operation: "search_by_value",
      database: "flair",
      table: "OAuthAuthCode",
      search_attribute: "clientId",
      search_value: clientId,
      get_attributes: ["id", "principalId"],
    });
    expect(search.status).toBe(200);
    const rows: any[] = await search.json();
    expect(rows.length).toBe(0);
  }, 30_000);

  test("#604: credential-less loopback POST /OAuthAuthorize (deny) is unaffected — still redirects with access_denied", async () => {
    // Deny never mints anything, so it's fine for it to remain
    // unauthenticated (nothing sensitive happens on this path) — this pins
    // that the fix didn't accidentally block deny too.
    const state = randomUUID();
    const res = await fetch(`${harper.httpURL}/OAuthAuthorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "manual",
      body: JSON.stringify({
        action: "deny",
        client_id: clientId,
        redirect_uri: ALLOWED_REDIRECT_URI,
        state,
      }),
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("error=access_denied");
  }, 30_000);

  // ── LEGITIMATE FLOWS: must still work ──────────────────────────────────────

  test("genuine Basic admin approval still mints a real code, exchangeable for a token", async () => {
    const { verifier, challenge } = pkcePair();
    const state = randomUUID();

    const approveRes = await fetch(`${harper.httpURL}/OAuthAuthorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
      },
      redirect: "manual",
      body: JSON.stringify({
        action: "approve",
        client_id: clientId,
        redirect_uri: ALLOWED_REDIRECT_URI,
        scope: "memory:read",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    expect(approveRes.status).toBe(302);
    const code = codeFromRedirect(approveRes.headers.get("location"));
    expect(code).toBeTruthy();

    // Exchange the code — proves the full genuine flow, not just the mint.
    const tokenRes = await fetch(`${harper.httpURL}/OAuthToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: ALLOWED_REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody: any = await tokenRes.json();
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.token_type).toBe("Bearer");
  }, 30_000);

  test("genuine Ed25519-signed agent approval still mints a code for that agent", async () => {
    const { challenge } = pkcePair();
    const state = randomUUID();
    const path = "/OAuthAuthorize";

    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: ed25519Header(agent, "POST", path),
      },
      redirect: "manual",
      body: JSON.stringify({
        action: "approve",
        client_id: clientId,
        redirect_uri: ALLOWED_REDIRECT_URI,
        scope: "memory:read",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    expect(res.status).toBe(302);
    const code = codeFromRedirect(res.headers.get("location"));
    expect(code).toBeTruthy();

    // Confirm the minted code's principalId is the SIGNING agent, not admin —
    // proves the approver identity, not just "something" got minted.
    const search = await adminOp(harper, {
      operation: "search_by_value",
      database: "flair",
      table: "OAuthAuthCode",
      search_attribute: "id",
      search_value: code,
      get_attributes: ["id", "principalId", "clientId"],
    });
    expect(search.status).toBe(200);
    const rows: any[] = await search.json();
    expect(rows.length).toBe(1);
    expect(rows[0].principalId).toBe(agent.id);
  }, 30_000);

  test("wrong-password Basic auth on POST /OAuthAuthorize → 401, mints NO code", async () => {
    const { challenge } = pkcePair();
    const state = randomUUID();
    const res = await fetch(`${harper.httpURL}/OAuthAuthorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${harper.admin.username}:wrong-password-entirely`),
      },
      body: JSON.stringify({
        action: "approve",
        client_id: clientId,
        redirect_uri: ALLOWED_REDIRECT_URI,
        scope: "memory:read",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    expect(res.status).toBe(401);
  }, 30_000);
});
