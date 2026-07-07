// issuetokens-authgate.test.ts — Integration test for the IssueTokens.ts
// removal (authorizeLocal escalation class, same shape as #604/#609).
//
// IssueTokens.ts had NO allowRead/allowCreate and its get() called Harper's
// `create_authentication_tokens` operation with no username/password, using
// only the ambient request context. Auto-routed to /IssueTokens via
// config.yaml's `jsResource: dist/resources/*.js`. Under `authorizeLocal:
// true` (config.yaml), Harper forges `request.user = super_user` for ANY
// credential-less LOOPBACK request — the exact #604/#609 class — so a bare
// `GET /IssueTokens` with zero credentials would mint a REAL admin JWT +
// refresh token (create_authentication_tokens's operation_token/refresh_token
// pair): a portable bearer credential, worse than the OAuthAuthorize code
// this pattern already burned twice.
//
// INVESTIGATED (repo-wide grep across src/, resources/, test/, docs/,
// config.yaml, and the built cli): zero callers of /IssueTokens or the
// IssueTokens class anywhere — not the CLI, not flair-client.mjs, not docs,
// not tests. Introduced in the original "Harper-native rewrite" commit
// (5edd7c4) alongside the Ed25519 auth middleware but never wired into any
// client path; the production credential-exchange surfaces are the
// TPS-Ed25519 header (agent-auth.ts) and the OAuth code/token flow
// (OAuthAuthorize.ts / OAuthToken.ts, see oauth-authorize-authz.test.ts).
// Dead scaffolding — DELETED rather than gated (cleaner: no reason to keep
// an unused, undocumented admin-token-mint endpoint around at all, gated or
// not). This test pins that the route is gone and mints nothing.
//
// MODEL: test/integration/oauth-authorize-authz.test.ts (the #604 fix's
// test, same authorizeLocal escalation class).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

let harper: HarperInstance;

describe("IssueTokens removal (authorizeLocal escalation class)", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("credential-less loopback GET /IssueTokens mints NO token (route removed)", async () => {
    const res = await fetch(`${harper.httpURL}/IssueTokens`);
    const text = await res.text();

    // Must NOT be a 200 carrying a minted jwt/refreshToken — that would be
    // the ambient-super_user escalation this resource used to allow. The
    // resource no longer exists at all, so Harper returns a non-200 (404 in
    // practice) rather than routing to a handler.
    expect(res.status, `GET /IssueTokens returned ${res.status}: ${text.slice(0, 200)}`).not.toBe(200);
    expect(text).not.toContain("operation_token");
    expect(text).not.toContain("refresh_token");
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* non-JSON 404 body is fine */ }
    if (body) {
      expect(body.jwt).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
    }
  }, 30_000);

  test("credential-less loopback POST /IssueTokens (no username/password) mints NO token (route removed)", async () => {
    const res = await fetch(`${harper.httpURL}/IssueTokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const text = await res.text();
    expect(res.status, `POST /IssueTokens returned ${res.status}: ${text.slice(0, 200)}`).not.toBe(200);
    expect(text).not.toContain("operation_token");
    expect(text).not.toContain("refresh_token");
  }, 30_000);

  test("POST /IssueTokens with explicit admin username/password ALSO mints nothing (whole resource gone, not just the credential-less get())", async () => {
    // Confirms the fix removed the entire dead resource rather than leaving
    // a half-wired post() around — there were zero callers of this path
    // either (repo-wide grep), and the real login surfaces (Basic auth via
    // Harper's own auth, TPS-Ed25519, and the OAuth code/token exchange) are
    // exercised elsewhere (oauth-authorize-authz.test.ts, ed25519-auth-hnsw.
    // test.ts) and are unaffected by this deletion.
    const res = await fetch(`${harper.httpURL}/IssueTokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: harper.admin.username, password: harper.admin.password }),
    });
    const text = await res.text();
    expect(res.status, `POST /IssueTokens (admin creds) returned ${res.status}: ${text.slice(0, 200)}`).not.toBe(200);
    expect(text).not.toContain("operation_token");
  }, 30_000);
});
