// oauth-pkce-required.test.ts — the authorization endpoints and the
// authorization-code exchange require S256 PKCE (RFC 7636); the discovery
// metadata lists S256 as the supported method (`code_challenge_methods_supported: ["S256"]`).
//
// After the earlier request, scope and client checks pass, GET /OAuthAuthorize
// (the consent page) and POST /OAuthAuthorize (its Approve) refuse a request
// whose code_challenge is absent, empty, not a string, or not 43-128 base64url
// characters, or whose code_challenge_method is not exactly "S256", with 400
// invalid_request and the same body: GET before rendering the form, POST before
// authentication and before any authorization code is stored. The order on both
// is scope, then client, then PKCE. A deny is answered before all three and
// needs no PKCE fields.
//
// The authorization-code exchange (POST /OAuthToken, grant_type
// authorization_code) requires the stored code row to carry an S256 challenge
// (invalid_grant otherwise). For an otherwise valid, unused code carrying an
// S256 challenge, it requires a code_verifier (invalid_request when it is
// missing, empty or not a string) whose S256 hash equals the stored challenge
// (invalid_grant otherwise). These refusals come before the code's single-use
// claim and its `used` write, and record no claim. After a verifier refusal of
// an otherwise valid, unused code, the same code still exchanges once with the
// matching verifier; a code stored without an S256 challenge is refused at
// every exchange.
//
// This exercises real Harper over HTTP (a Harper the harness spawns, as CI
// runs it, or an existing one when HARPER_HTTP_URL is set). The OAuthAuthCode
// and OAuthSingleUse tables are read back through the operations API.
// Assertions are on shape: no code, token or verifier value is compared in a
// way that prints it.
//
// MODEL: test/integration/oauth-consent-post-client.test.ts.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

let harper: HarperInstance;

function basicAdmin(): string {
  return "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
}

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAdmin() },
    body: JSON.stringify(op),
  });
}

async function registerClient(id: string, name: string): Promise<void> {
  const res = await adminOp({
    operation: "insert",
    database: "flair",
    table: "OAuthClient",
    records: [{
      id,
      name,
      redirectUris: [ALLOWED_REDIRECT_URI],
      grantTypes: ["authorization_code", "refresh_token"],
      scope: "memory:read",
      registeredBy: "test",
      createdAt: new Date().toISOString(),
    }],
  });
  expect(res.status).toBe(200);
}

/** How many OAuthAuthCode rows the table holds, read back through the operations API. */
async function authCodeCount(): Promise<number> {
  const res = await adminOp({ operation: "sql", sql: "SELECT id FROM flair.OAuthAuthCode" });
  expect(res.status).toBe(200);
  return ((await res.json()) as any[]).length;
}

/** The OAuthAuthCode rows stored for `clientId`. */
async function authCodeRowsFor(clientId: string): Promise<any[]> {
  const res = await adminOp({
    operation: "search_by_value",
    database: "flair",
    table: "OAuthAuthCode",
    search_attribute: "clientId",
    search_value: clientId,
    get_attributes: ["*"],
  });
  expect(res.status).toBe(200);
  return res.json();
}

/** The OAuthAuthCode row stored under `code` (an array of zero or one row). */
async function authCodeRow(code: string): Promise<any[]> {
  const res = await adminOp({
    operation: "search_by_value",
    database: "flair",
    table: "OAuthAuthCode",
    search_attribute: "id",
    search_value: code,
    get_attributes: ["*"],
  });
  expect(res.status).toBe(200);
  return res.json();
}

/** How many single-use claims (OAuthSingleUse `c:<sha256(code)>`) are recorded for `code`: 0 or 1. */
async function redemptionClaims(code: string): Promise<number> {
  const res = await adminOp({
    operation: "search_by_value",
    database: "flair",
    table: "OAuthSingleUse",
    search_attribute: "id",
    search_value: `c:${createHash("sha256").update(code).digest("hex")}`,
    get_attributes: ["id"],
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as any[]).length;
}

/** Insert an OAuthAuthCode row directly, with `over` merged over a complete row (`undefined` removes a field). */
async function seedCode(clientId: string, over: Record<string, any>): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const row: Record<string, any> = {
    id: code,
    clientId,
    principalId: harper.admin.username,
    redirectUri: ALLOWED_REDIRECT_URI,
    scope: "memory:read",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    used: false,
    createdAt: new Date().toISOString(),
    ...over,
  };
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  const res = await adminOp({ operation: "insert", database: "flair", table: "OAuthAuthCode", records: [row] });
  expect(res.status).toBe(200);
  return code;
}

/** POST the consent form as JSON; authenticated as the Harper admin unless `auth` is false. */
function postConsent(body: Record<string, any>, auth = true): Promise<Response> {
  return fetch(`${harper.httpURL}/OAuthAuthorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: basicAdmin() } : {}),
    },
    redirect: "manual",
    body: JSON.stringify(body),
  });
}

/** GET the consent page with `response_type=code` plus `params` (an `undefined` value is left out). */
function getConsent(params: Record<string, string | undefined>): Promise<Response> {
  const q = new URLSearchParams({ response_type: "code" });
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  return fetch(`${harper.httpURL}/OAuthAuthorize?${q}`, { redirect: "manual" });
}

function exchange(body: Record<string, any>): Promise<Response> {
  return fetch(`${harper.httpURL}/OAuthToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", ...body }),
  });
}

/** The code a 302 to the pinned callback carries; asserts the redirect's target and `state`. */
function codeFromApproval(res: Response, state: string): string {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(ALLOWED_REDIRECT_URI);
  expect(location.searchParams.get("state")).toBe(state);
  const code = location.searchParams.get("code");
  expect(typeof code).toBe("string");
  expect(code!.length).toBeGreaterThan(0);
  return code!;
}

/** Reverse of resources/admin-layout.ts `esc`, for reading attribute values back. */
function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#96;/g, "`")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The hidden fields of the rendered consent form, in page order. */
function formFields(html: string): Array<[string, string]> {
  const form = html.match(/<form method="POST" action="\/OAuthAuthorize"[^>]*>([\s\S]*?)<\/form>/);
  expect(form).not.toBeNull();
  const fields: Array<[string, string]> = [];
  for (const m of form![1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields.push([m[1], unescapeAttr(m[2])]);
  }
  return fields;
}

/** Render the consent page for `clientId` with an S256 challenge and return its form's hidden fields. */
async function renderConsentForm(clientId: string, challenge: string, state: string): Promise<Array<[string, string]>> {
  const page = await getConsent({
    client_id: clientId,
    redirect_uri: ALLOWED_REDIRECT_URI,
    scope: "memory:read memory:write",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  expect(page.status).toBe(200);
  const fields = formFields(await page.text());
  expect(fields.map(([name]) => name)).toEqual([
    "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method",
  ]);
  return fields;
}

/** Submit consent form fields the way a browser does: the fields plus the clicked button, URL-encoded. */
function submitConsentForm(fields: Array<[string, string]>, action: "approve" | "deny"): Promise<Response> {
  const body = new URLSearchParams([...fields, ["action", action]]);
  return fetch(`${harper.httpURL}/OAuthAuthorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAdmin() },
    redirect: "manual",
    body: body.toString(),
  });
}

/** Expect a 400 invalid_request PKCE refusal naming `field`; returns the parsed body. */
async function expectPkceRefusal(res: Response, field: "code_challenge" | "code_challenge_method"): Promise<any> {
  expect(res.status).toBe(400);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("content-type")).toBe("application/json");
  const text = await res.text();
  expect(text).not.toContain("<form");
  expect(text).not.toContain("code=");
  const json = JSON.parse(text);
  expect(json.error).toBe("invalid_request");
  expect(json).not.toHaveProperty("code");
  expect(typeof json.error_description).toBe("string");
  expect(json.error_description.startsWith("PKCE is required: ")).toBe(true);
  expect(json.error_description).toContain(`${field} must be`);
  return json;
}

// Registered; named only by requests the PKCE check refuses (and by denials).
const pkceClient = `flair_cl_test_pkce_${randomUUID()}`;
// Registered; named by the flows that issue and exchange codes.
const flowClient = `flair_cl_test_pkce_flow_${randomUUID()}`;
// Never registered.
const unknownClient = `flair_cl_unregistered_${randomUUID()}`;

const savedEnv: Record<string, string | undefined> = {};

describe("S256 PKCE is required at the authorization endpoints and the token exchange", () => {
  beforeAll(async () => {
    // This file sends more than the default 30 OAuth requests a minute from one
    // caller; the budget is raised so every answer comes from the handler.
    for (const k of ["FLAIR_OAUTH_RATE_LIMIT", "FLAIR_RATE_LIMIT"]) savedEnv[k] = process.env[k];
    process.env.FLAIR_OAUTH_RATE_LIMIT = "1000";
    delete process.env.FLAIR_RATE_LIMIT;

    harper = await startHarper();
    await registerClient(pkceClient, "PKCE refusal test client");
    await registerClient(flowClient, "PKCE flow test client");
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, HARPER_STOP_BUDGET_MS);

  // ── (a) The authorization endpoints refuse a request without S256 PKCE ────

  interface PkceRefusal {
    name: string;
    /** PKCE fields merged over a valid S256 pair (`undefined` removes the field). */
    pkce: (challenge: string) => Record<string, any>;
    /** The field the error_description names. */
    field: "code_challenge" | "code_challenge_method";
    /** False when the value cannot be expressed as a query parameter (GET is then not sent). */
    query: boolean;
  }

  const refusals: PkceRefusal[] = [
    { name: "no code_challenge", pkce: () => ({ code_challenge: undefined }), field: "code_challenge", query: true },
    { name: "an empty code_challenge", pkce: () => ({ code_challenge: "" }), field: "code_challenge", query: true },
    { name: "a code_challenge of 42 base64url characters", pkce: (c) => ({ code_challenge: c.slice(0, 42) }), field: "code_challenge", query: true },
    { name: "a code_challenge of 129 base64url characters", pkce: () => ({ code_challenge: "A".repeat(129) }), field: "code_challenge", query: true },
    { name: "a code_challenge with a '+' (outside the base64url alphabet)", pkce: (c) => ({ code_challenge: `${c.slice(0, 42)}+` }), field: "code_challenge", query: true },
    { name: "a code_challenge with '=' padding", pkce: (c) => ({ code_challenge: `${c.slice(0, 42)}=` }), field: "code_challenge", query: true },
    { name: "a code_challenge with a trailing newline", pkce: (c) => ({ code_challenge: `${c}\n` }), field: "code_challenge", query: true },
    { name: "a code_challenge that is not a string", pkce: (c) => ({ code_challenge: [c] }), field: "code_challenge", query: false },
    { name: "a null code_challenge", pkce: () => ({ code_challenge: null }), field: "code_challenge", query: false },
    { name: "code_challenge_method plain", pkce: () => ({ code_challenge_method: "plain" }), field: "code_challenge_method", query: true },
    { name: "no code_challenge_method", pkce: () => ({ code_challenge_method: undefined }), field: "code_challenge_method", query: true },
    { name: "an empty code_challenge_method", pkce: () => ({ code_challenge_method: "" }), field: "code_challenge_method", query: true },
    { name: "code_challenge_method s256 (lower case)", pkce: () => ({ code_challenge_method: "s256" }), field: "code_challenge_method", query: true },
  ];

  /** A complete consent request for `pkceClient` with a valid S256 pair, then `r`'s PKCE fields. */
  function refusedRequest(r: PkceRefusal, state: string): Record<string, any> {
    const { challenge } = pkcePair();
    return {
      client_id: pkceClient,
      redirect_uri: ALLOWED_REDIRECT_URI,
      scope: "memory:read",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...r.pkce(challenge),
    };
  }

  for (const r of refusals.filter((x) => x.query)) {
    test(`GET /OAuthAuthorize naming ${r.name} answers 400 invalid_request and renders no consent form`, async () => {
      const page = await getConsent(refusedRequest(r, randomUUID()));
      await expectPkceRefusal(page, r.field);
    }, 30_000);
  }

  for (const r of refusals) {
    test(`POST /OAuthAuthorize (approve) naming ${r.name} answers 400 invalid_request, authenticated or not, and stores no authorization code`, async () => {
      const request = refusedRequest(r, randomUUID());
      const before = await authCodeCount();
      const clientRowsBefore = (await authCodeRowsFor(pkceClient)).length;

      const authed = await expectPkceRefusal(await postConsent({ action: "approve", ...request }), r.field);
      // The PKCE check runs before authentication: an unauthenticated approve
      // gets the same refusal, not 401.
      const anon = await expectPkceRefusal(await postConsent({ action: "approve", ...request }, false), r.field);
      expect(anon).toEqual(authed);

      // Nothing was stored.
      expect(await authCodeCount()).toBe(before);
      expect((await authCodeRowsFor(pkceClient)).length).toBe(clientRowsBefore);
    }, 30_000);
  }

  test("GET and POST /OAuthAuthorize answer each PKCE refusal a query can express with the same 400 body", async () => {
    for (const r of refusals.filter((x) => x.query)) {
      const request = refusedRequest(r, randomUUID());
      const page = await getConsent(request);
      const res = await postConsent({ action: "approve", ...request });
      expect(page.status, r.name).toBe(400);
      expect(res.status, r.name).toBe(400);
      expect(await res.json(), r.name).toEqual(await page.json());
    }
  }, 30_000);

  test("the scope and client checks run before the PKCE check, on GET and POST alike", async () => {
    const before = await authCodeCount();
    const cases: Array<{ fields: Record<string, any>; error: string }> = [
      { fields: { client_id: unknownClient, scope: "memory:read" }, error: "invalid_client" },
      { fields: { client_id: pkceClient, scope: "memory:read flair:unsupported" }, error: "invalid_scope" },
    ];
    for (const c of cases) {
      const request = { redirect_uri: ALLOWED_REDIRECT_URI, state: randomUUID(), ...c.fields };
      const page = await getConsent(request);
      expect(page.status).toBe(400);
      const pageBody = await page.json();
      expect(pageBody.error).toBe(c.error);

      const res = await postConsent({ action: "approve", ...request });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(pageBody);
    }
    expect(await authCodeCount()).toBe(before);
  }, 30_000);

  test("a code_challenge of 128 base64url characters (the RFC 7636 maximum) is accepted: the page renders it and the approve stores it", async () => {
    const challenge = randomBytes(96).toString("base64url");
    expect(challenge.length).toBe(128);
    const state = randomUUID();
    const page = await getConsent({
      client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI, scope: "memory:read",
      state, code_challenge: challenge, code_challenge_method: "S256",
    });
    expect(page.status).toBe(200);
    const fields = new Map(formFields(await page.text()));
    expect(fields.get("code_challenge") === challenge).toBe(true);
    expect(fields.get("code_challenge_method")).toBe("S256");

    const res = await postConsent({
      action: "approve", client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI, scope: "memory:read",
      state, code_challenge: challenge, code_challenge_method: "S256",
    });
    const code = codeFromApproval(res, state);
    const rows = await authCodeRow(code);
    expect(rows.length).toBe(1);
    expect(rows[0].codeChallenge === challenge).toBe(true);
    expect(rows[0].codeChallengeMethod).toBe("S256");
  }, 30_000);

  // ── Deny: answered before the PKCE check, with no PKCE fields needed ──────

  const denials: Array<{ name: string; pkce: Record<string, any>; auth: boolean }> = [
    { name: "no PKCE fields (unauthenticated)", pkce: {}, auth: false },
    { name: "no PKCE fields (authenticated)", pkce: {}, auth: true },
    { name: "code_challenge_method plain and no code_challenge (authenticated)", pkce: { code_challenge_method: "plain" }, auth: true },
  ];

  for (const d of denials) {
    test(`a deny with ${d.name} answers the access_denied redirect and stores no authorization code`, async () => {
      const state = randomUUID();
      const before = await authCodeCount();
      const res = await postConsent({
        action: "deny", client_id: pkceClient, redirect_uri: ALLOWED_REDIRECT_URI,
        scope: "memory:read", state, ...d.pkce,
      }, d.auth);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(ALLOWED_REDIRECT_URI);
      expect(location.searchParams.get("error")).toBe("access_denied");
      expect(location.searchParams.get("state")).toBe(state);
      expect(location.searchParams.has("code")).toBe(false);
      expect(await authCodeCount()).toBe(before);
    }, 30_000);
  }

  // ── (b) A valid S256 flow, end to end ─────────────────────────────────────

  test("a valid S256 flow: the page renders the challenge, the approve stores it, and the code exchanges once with the matching verifier", async () => {
    const { verifier, challenge } = pkcePair();
    const state = randomUUID();

    const page = await getConsent({
      client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI, scope: "memory:read memory:write",
      state, code_challenge: challenge, code_challenge_method: "S256",
    });
    expect(page.status).toBe(200);
    const fields = new Map(formFields(await page.text()));
    expect(fields.get("code_challenge") === challenge).toBe(true);
    expect(fields.get("code_challenge_method")).toBe("S256");

    const before = await authCodeCount();
    const code = codeFromApproval(await postConsent({
      action: "approve", client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI,
      scope: "memory:read memory:write", state, code_challenge: challenge, code_challenge_method: "S256",
    }), state);
    expect(await authCodeCount()).toBe(before + 1);

    let rows = await authCodeRow(code);
    expect(rows.length).toBe(1);
    expect(rows[0].clientId).toBe(flowClient);
    expect(rows[0].principalId).toBe(harper.admin.username);
    expect(rows[0].codeChallenge === challenge).toBe(true);
    expect(rows[0].codeChallengeMethod).toBe("S256");
    expect(rows[0].used).toBe(false);
    expect(await redemptionClaims(code)).toBe(0);

    const tokenRes = await exchange({ code, client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI, code_verifier: verifier });
    expect(tokenRes.status).toBe(200);
    const tokenBody: any = await tokenRes.json();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(typeof tokenBody.access_token).toBe("string");
    expect(tokenBody.access_token.startsWith("flair_at_")).toBe(true);
    expect(tokenBody.scope).toBe("memory:read memory:write");

    rows = await authCodeRow(code);
    expect(rows[0].used).toBe(true);
    expect(await redemptionClaims(code)).toBe(1);

    // Single use: the matching verifier does not redeem it twice.
    const again = await exchange({ code, client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI, code_verifier: verifier });
    expect(again.status).toBe(400);
    const againBody: any = await again.json();
    expect(againBody).toEqual({ error: "invalid_grant", error_description: "code already used" });
  }, 30_000);

  test("a wrong, missing, empty or non-string verifier is refused; each refusal leaves the code unredeemed, and it then exchanges with the matching verifier", async () => {
    const { verifier, challenge } = pkcePair();
    const state = randomUUID();
    const code = codeFromApproval(await postConsent({
      action: "approve", client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI,
      scope: "memory:read", state, code_challenge: challenge, code_challenge_method: "S256",
    }), state);

    const refused: Array<{ name: string; verifier: () => any; body: Record<string, string> }> = [
      { name: "another pair's verifier", verifier: () => pkcePair().verifier, body: { error: "invalid_grant", error_description: "PKCE verification failed" } },
      { name: "the challenge itself (the plain method)", verifier: () => challenge, body: { error: "invalid_grant", error_description: "PKCE verification failed" } },
      { name: "no verifier", verifier: () => undefined, body: { error: "invalid_request", error_description: "code_verifier required" } },
      { name: "an empty verifier", verifier: () => "", body: { error: "invalid_request", error_description: "code_verifier required" } },
      { name: "a verifier that is not a string", verifier: () => [verifier], body: { error: "invalid_request", error_description: "code_verifier required" } },
    ];
    for (const r of refused) {
      const res = await exchange({ code, client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI, code_verifier: r.verifier() });
      expect(res.status, r.name).toBe(400);
      const body: any = await res.json();
      expect(body, r.name).toEqual(r.body);
      // Not redeemed: no claim recorded, the row still unused.
      const rows = await authCodeRow(code);
      expect(rows.length).toBe(1);
      expect(rows[0].used, r.name).toBe(false);
      expect(await redemptionClaims(code), r.name).toBe(0);
    }

    const tokenRes = await exchange({ code, client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI, code_verifier: verifier });
    expect(tokenRes.status).toBe(200);
    const tokenBody: any = await tokenRes.json();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.access_token.startsWith("flair_at_")).toBe(true);
    expect((await authCodeRow(code))[0].used).toBe(true);
    expect(await redemptionClaims(code)).toBe(1);
  }, 30_000);

  // ── (c) A stored code without an S256 challenge is refused at exchange ────

  const unchallengedRows: Array<{ name: string; over: (challenge: string) => Record<string, any> }> = [
    { name: "no codeChallenge and no codeChallengeMethod", over: () => ({ codeChallenge: undefined, codeChallengeMethod: undefined }) },
    { name: "no codeChallenge (method S256)", over: () => ({ codeChallenge: undefined, codeChallengeMethod: "S256" }) },
    { name: "an empty codeChallenge (method S256)", over: () => ({ codeChallenge: "", codeChallengeMethod: "S256" }) },
    { name: "an S256 challenge stored with method plain", over: (c) => ({ codeChallenge: c, codeChallengeMethod: "plain" }) },
    { name: "an S256 challenge stored with no method", over: (c) => ({ codeChallenge: c, codeChallengeMethod: undefined }) },
  ];

  for (const u of unchallengedRows) {
    test(`a code row stored with ${u.name} is refused at exchange with invalid_grant, with or without a verifier, and stays unredeemed`, async () => {
      const { verifier, challenge } = pkcePair();
      const code = await seedCode(flowClient, u.over(challenge));
      const refusal = { error: "invalid_grant", error_description: "authorization code has no S256 code_challenge" };

      for (const v of [verifier, undefined]) {
        const res = await exchange({ code, client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI, code_verifier: v });
        expect(res.status).toBe(400);
        const body: any = await res.json();
        expect(body).toEqual(refusal);
      }

      const rows = await authCodeRow(code);
      expect(rows.length).toBe(1);
      expect(rows[0].used).toBe(false);
      expect(await redemptionClaims(code)).toBe(0);
    }, 30_000);
  }

  test("CONTROL: a seeded code row with an S256 challenge exchanges with its verifier", async () => {
    const { verifier, challenge } = pkcePair();
    const code = await seedCode(flowClient, { codeChallenge: challenge, codeChallengeMethod: "S256" });
    const res = await exchange({ code, client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI, code_verifier: verifier });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token.startsWith("flair_at_")).toBe(true);
  }, 30_000);

  // ── (d) The rendered consent form, submitted URL-encoded ──────────────────

  test("the rendered consent form carries the S256 fields; submitted URL-encoded with Approve it issues a code that exchanges with the matching verifier", async () => {
    const { verifier, challenge } = pkcePair();
    const state = randomUUID();
    const fields = await renderConsentForm(flowClient, challenge, state);
    const named = new Map(fields);
    expect(named.get("code_challenge") === challenge).toBe(true);
    expect(named.get("code_challenge_method")).toBe("S256");
    const before = await authCodeCount();

    const code = codeFromApproval(await submitConsentForm(fields, "approve"), state);
    expect(await authCodeCount()).toBe(before + 1);
    const rows = await authCodeRow(code);
    expect(rows.length).toBe(1);
    expect(rows[0].clientId).toBe(flowClient);
    expect(rows[0].scope).toBe("memory:read memory:write");
    expect(rows[0].codeChallenge === challenge).toBe(true);
    expect(rows[0].codeChallengeMethod).toBe("S256");

    const tokenRes = await exchange({ code, client_id: flowClient, redirect_uri: ALLOWED_REDIRECT_URI, code_verifier: verifier });
    expect(tokenRes.status).toBe(200);
    expect((await tokenRes.json()).token_type).toBe("Bearer");
  }, 30_000);

  const formEdits: Array<{ name: string; field: "code_challenge" | "code_challenge_method"; edit: (fields: Array<[string, string]>) => Array<[string, string]> }> = [
    { name: "its code_challenge emptied", field: "code_challenge", edit: (f) => f.map(([k, v]) => [k, k === "code_challenge" ? "" : v]) },
    { name: "its code_challenge removed", field: "code_challenge", edit: (f) => f.filter(([k]) => k !== "code_challenge") },
    { name: "its code_challenge_method changed to plain", field: "code_challenge_method", edit: (f) => f.map(([k, v]) => [k, k === "code_challenge_method" ? "plain" : v]) },
  ];

  for (const e of formEdits) {
    test(`the rendered consent form submitted URL-encoded with ${e.name} answers 400 invalid_request and stores no code`, async () => {
      const formClient = `flair_cl_test_pkce_form_${randomUUID()}`;
      await registerClient(formClient, "PKCE consent form client");
      const fields = e.edit(await renderConsentForm(formClient, pkcePair().challenge, randomUUID()));
      const before = await authCodeCount();

      await expectPkceRefusal(await submitConsentForm(fields, "approve"), e.field);
      expect(await authCodeCount()).toBe(before);
      expect((await authCodeRowsFor(formClient)).length).toBe(0);
    }, 30_000);
  }

  test("no authorization code was ever stored for the client named only by refused requests and denials", async () => {
    expect((await authCodeRowsFor(pkceClient)).length).toBe(0);
    expect((await authCodeRowsFor(unknownClient)).length).toBe(0);
  }, 30_000);
});
