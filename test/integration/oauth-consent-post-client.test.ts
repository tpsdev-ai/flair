// oauth-consent-post-client.test.ts — the consent form's POST /OAuthAuthorize
// applies the consent page's (GET /OAuthAuthorize) scope and client checks, in
// the same order and with the same 400 bodies, before an authorization code is
// issued or stored.
//
// Order on POST: redirect_uri, then a non-approve action answers the
// access_denied redirect (no code, no write), then the scope check, then the
// OAuthClient record check, then authentication, then the code is issued.
//
// This is a REAL Harper spawn: each consent POST is sent over HTTP, as JSON or
// as the rendered form's URL-encoded fields, and the OAuthAuthCode table is
// read back through the operations API after it.
//
// MODEL: test/integration/oauth-authorize-authz.test.ts.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";
const AUTH_CODE_TTL_MS = 600_000;

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

/** Every OAuthAuthCode id in the table, read back through the operations API. */
async function authCodeIds(): Promise<string[]> {
  const res = await adminOp({ operation: "sql", sql: "SELECT id FROM flair.OAuthAuthCode" });
  expect(res.status).toBe(200);
  const rows: any[] = await res.json();
  return rows.map((r) => String(r.id)).sort();
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

/** GET the consent page with `response_type=code` plus `params`. */
function getConsent(params: Record<string, string>): Promise<Response> {
  const q = new URLSearchParams({ response_type: "code", ...params });
  return fetch(`${harper.httpURL}/OAuthAuthorize?${q}`, { redirect: "manual" });
}

function exchange(body: Record<string, any>): Promise<Response> {
  return fetch(`${harper.httpURL}/OAuthToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", ...body }),
  });
}

function hiddenValue(html: string, name: string): string | null {
  const m = html.match(new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`));
  return m ? m[1] : null;
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

/** Render the consent page for `clientId` and return its form's hidden fields. */
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

/** Submit the consent form the way a browser does: its fields plus the clicked button, URL-encoded. */
function submitConsentForm(fields: Array<[string, string]>, action: "approve" | "deny"): Promise<Response> {
  const body = new URLSearchParams([...fields, ["action", action]]);
  return fetch(`${harper.httpURL}/OAuthAuthorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAdmin() },
    redirect: "manual",
    body: body.toString(),
  });
}

const registeredClient = `flair_cl_test_${randomUUID()}`;
// Registered, and named only by requests the scope check refuses or that deny.
const scopeClient = `flair_cl_test_scope_${randomUUID()}`;
// Never registered.
const unknownClient = `flair_cl_unregistered_${randomUUID()}`;

const savedEnv: Record<string, string | undefined> = {};

describe("POST /OAuthAuthorize applies the consent page's scope and client checks", () => {
  beforeAll(async () => {
    // This file sends more than the default 30 OAuth requests a minute from one
    // caller; the budget is raised so every answer comes from the handler.
    for (const k of ["FLAIR_OAUTH_RATE_LIMIT", "FLAIR_RATE_LIMIT"]) savedEnv[k] = process.env[k];
    process.env.FLAIR_OAUTH_RATE_LIMIT = "1000";
    delete process.env.FLAIR_RATE_LIMIT;

    harper = await startHarper();
    await registerClient(registeredClient, "consent POST test client");
    await registerClient(scopeClient, "consent POST scope test client");
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, HARPER_STOP_BUDGET_MS);

  // ── Refusals: no code is issued or stored ──────────────────────────────────

  interface Refusal {
    name: string;
    /** Fields merged over a complete approve body (`undefined` removes the field). */
    body: () => Record<string, any>;
    error: "invalid_client" | "invalid_scope";
    /** The same request as consent-page query params, when it can be expressed as one. */
    page?: () => Record<string, string>;
    /** The client a token exchange names, and the refusal it gets. */
    exchangeClient: () => any;
    exchangeError: "invalid_grant" | "invalid_request";
  }

  const refusals: Refusal[] = [
    {
      name: "a client_id with no OAuthClient record",
      body: () => ({ client_id: unknownClient }),
      error: "invalid_client",
      page: () => ({ client_id: unknownClient }),
      exchangeClient: () => unknownClient,
      exchangeError: "invalid_grant",
    },
    {
      name: "an empty client_id",
      body: () => ({ client_id: "" }),
      error: "invalid_client",
      page: () => ({ client_id: "" }),
      exchangeClient: () => "",
      exchangeError: "invalid_request",
    },
    {
      name: "no client_id",
      body: () => ({ client_id: undefined }),
      error: "invalid_client",
      page: () => ({}),
      exchangeClient: () => undefined,
      exchangeError: "invalid_request",
    },
    {
      name: "a null client_id",
      body: () => ({ client_id: null }),
      error: "invalid_client",
      exchangeClient: () => null,
      exchangeError: "invalid_request",
    },
    {
      name: "a client_id that is not a string",
      body: () => ({ client_id: [registeredClient] }),
      error: "invalid_client",
      exchangeClient: () => [registeredClient],
      exchangeError: "invalid_grant",
    },
    {
      name: "a scope the server does not support",
      body: () => ({ client_id: scopeClient, scope: "memory:read flair:unsupported" }),
      error: "invalid_scope",
      page: () => ({ client_id: scopeClient, scope: "memory:read flair:unsupported" }),
      exchangeClient: () => scopeClient,
      exchangeError: "invalid_grant",
    },
    {
      name: "a null scope",
      body: () => ({ client_id: scopeClient, scope: null }),
      error: "invalid_scope",
      exchangeClient: () => scopeClient,
      exchangeError: "invalid_grant",
    },
    {
      name: "a scope that is not a string",
      body: () => ({ client_id: scopeClient, scope: ["memory:read"] }),
      error: "invalid_scope",
      exchangeClient: () => scopeClient,
      exchangeError: "invalid_grant",
    },
    {
      name: "a scope the server does not support, for a client with no OAuthClient record (scope is checked first, as on the consent page)",
      body: () => ({ client_id: unknownClient, scope: "flair:unsupported" }),
      error: "invalid_scope",
      page: () => ({ client_id: unknownClient, scope: "flair:unsupported" }),
      exchangeClient: () => unknownClient,
      exchangeError: "invalid_grant",
    },
  ];

  for (const r of refusals) {
    test(`an authenticated approve naming ${r.name} answers 400 ${r.error}, stores no authorization code and carries no code`, async () => {
      const { verifier, challenge } = pkcePair();
      const state = randomUUID();
      const before = await authCodeIds();

      const body: Record<string, any> = {
        action: "approve",
        client_id: registeredClient,
        redirect_uri: ALLOWED_REDIRECT_URI,
        scope: "memory:read",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...r.body(),
      };
      const res = await postConsent(body);
      const text = await res.text();

      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      const json = JSON.parse(text);
      expect(json.error).toBe(r.error);
      expect(json).not.toHaveProperty("code");
      expect(text).not.toContain("code=");

      // The consent page answers the same request with the same status and body.
      if (r.page) {
        const page = await getConsent({ redirect_uri: ALLOWED_REDIRECT_URI, state, ...r.page() });
        expect(page.status).toBe(400);
        expect(await page.json()).toEqual(json);
      }

      // Nothing was stored: the table holds exactly the codes it held before.
      expect(await authCodeIds()).toEqual(before);
      const named = body.client_id;
      if (typeof named === "string" && named !== "") {
        expect((await authCodeRowsFor(named)).length).toBe(0);
      }

      // No code value exchanges for a token for this client.
      const tokenRes = await exchange({
        code: randomBytes(32).toString("base64url"),
        client_id: r.exchangeClient(),
        redirect_uri: ALLOWED_REDIRECT_URI,
        code_verifier: verifier,
      });
      expect(tokenRes.status).toBe(400);
      const tokenBody: any = await tokenRes.json();
      expect(tokenBody.error).toBe(r.exchangeError);
      expect(tokenBody).not.toHaveProperty("access_token");
    }, 30_000);
  }

  test("an unauthenticated approve naming a client_id with no OAuthClient record answers 400 invalid_client: the client check runs before authentication, as on the consent page", async () => {
    const { challenge } = pkcePair();
    const before = await authCodeIds();
    const res = await postConsent({
      action: "approve",
      client_id: unknownClient,
      redirect_uri: ALLOWED_REDIRECT_URI,
      scope: "memory:read",
      state: randomUUID(),
      code_challenge: challenge,
      code_challenge_method: "S256",
    }, false);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect((await res.json()).error).toBe("invalid_client");
    expect(await authCodeIds()).toEqual(before);
  }, 30_000);

  // ── Positive control: a registered client still gets its code ──────────────

  test("an authenticated approve naming a registered client issues a code; the stored row carries the request's fields and exchanges once", async () => {
    const { verifier, challenge } = pkcePair();
    const state = randomUUID();
    const before = await authCodeIds();
    const sentAt = Date.now();

    const res = await postConsent({
      action: "approve",
      client_id: registeredClient,
      redirect_uri: ALLOWED_REDIRECT_URI,
      scope: "memory:read memory:write",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(ALLOWED_REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe(state);
    const code = location.searchParams.get("code");
    expect(typeof code).toBe("string");
    expect(code!.length).toBeGreaterThan(0);

    const after = await authCodeIds();
    expect(after.length).toBe(before.length + 1);
    expect(after).toContain(code!);

    const rows = await authCodeRow(code!);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.clientId).toBe(registeredClient);
    expect(row.principalId).toBe(harper.admin.username);
    expect(row.redirectUri).toBe(ALLOWED_REDIRECT_URI);
    expect(row.scope).toBe("memory:read memory:write");
    expect(row.codeChallenge).toBe(challenge);
    expect(row.codeChallengeMethod).toBe("S256");
    expect(row.used).toBe(false);
    const expiresAt = Date.parse(row.expiresAt);
    expect(expiresAt).toBeGreaterThan(sentAt);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + AUTH_CODE_TTL_MS);

    const tokenRes = await exchange({
      code,
      client_id: registeredClient,
      redirect_uri: ALLOWED_REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody: any = await tokenRes.json();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(typeof tokenBody.access_token).toBe("string");
    expect(tokenBody.access_token.startsWith("flair_at_")).toBe(true);
    expect(tokenBody.scope).toBe("memory:read memory:write");
  }, 30_000);

  test("an approve with a blank scope stores the scope the consent page renders for a blank scope (memory:read)", async () => {
    const page = await getConsent({ client_id: registeredClient, scope: "  ", redirect_uri: ALLOWED_REDIRECT_URI });
    expect(page.status).toBe(200);
    expect(hiddenValue(await page.text(), "scope")).toBe("memory:read");

    const { challenge } = pkcePair();
    const res = await postConsent({
      action: "approve",
      client_id: registeredClient,
      redirect_uri: ALLOWED_REDIRECT_URI,
      scope: "  ",
      state: randomUUID(),
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(res.status).toBe(302);
    const code = new URL(res.headers.get("location") ?? "").searchParams.get("code");
    expect(typeof code).toBe("string");
    const rows = await authCodeRow(code!);
    expect(rows.length).toBe(1);
    expect(rows[0].scope).toBe("memory:read");
  }, 30_000);

  // ── Deny: answered before the scope and client checks, never with a code ───

  const denials: Array<{ name: string; body: () => Record<string, any>; auth: boolean }> = [
    { name: "a registered client (authenticated)", body: () => ({ client_id: registeredClient }), auth: true },
    { name: "a client_id with no OAuthClient record (authenticated)", body: () => ({ client_id: unknownClient }), auth: true },
    { name: "a client_id with no OAuthClient record (unauthenticated)", body: () => ({ client_id: unknownClient }), auth: false },
    { name: "a scope the server does not support (authenticated)", body: () => ({ client_id: scopeClient, scope: "flair:unsupported" }), auth: true },
  ];

  for (const d of denials) {
    test(`a deny naming ${d.name} answers the access_denied redirect and stores no authorization code`, async () => {
      const state = randomUUID();
      const before = await authCodeIds();
      const res = await postConsent({
        action: "deny",
        redirect_uri: ALLOWED_REDIRECT_URI,
        scope: "memory:read",
        state,
        ...d.body(),
      }, d.auth);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(ALLOWED_REDIRECT_URI);
      expect(location.searchParams.get("error")).toBe("access_denied");
      expect(location.searchParams.get("state")).toBe(state);
      expect(location.searchParams.has("code")).toBe(false);
      expect(await authCodeIds()).toEqual(before);
    }, 30_000);
  }

  // ── The rendered form, submitted URL-encoded (the browser's path) ─────────

  test("the rendered consent form submitted URL-encoded with Approve issues a code for a registered client", async () => {
    const { verifier, challenge } = pkcePair();
    const state = randomUUID();
    const fields = await renderConsentForm(registeredClient, challenge, state);
    const before = await authCodeIds();

    const res = await submitConsentForm(fields, "approve");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(ALLOWED_REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe(state);
    const code = location.searchParams.get("code");
    expect(typeof code).toBe("string");

    const after = await authCodeIds();
    expect(after.length).toBe(before.length + 1);
    const rows = await authCodeRow(code!);
    expect(rows.length).toBe(1);
    expect(rows[0].clientId).toBe(registeredClient);
    expect(rows[0].principalId).toBe(harper.admin.username);
    expect(rows[0].redirectUri).toBe(ALLOWED_REDIRECT_URI);
    expect(rows[0].scope).toBe("memory:read memory:write");
    expect(rows[0].codeChallenge).toBe(challenge);
    expect(rows[0].codeChallengeMethod).toBe("S256");

    const tokenRes = await exchange({
      code,
      client_id: registeredClient,
      redirect_uri: ALLOWED_REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(tokenRes.status).toBe(200);
    expect((await tokenRes.json()).token_type).toBe("Bearer");
  }, 30_000);

  test("the rendered consent form submitted URL-encoded with Approve after its client record is deleted answers 400 invalid_client and stores no code", async () => {
    const formClient = `flair_cl_test_form_${randomUUID()}`;
    await registerClient(formClient, "consent form deleted client");
    const { verifier, challenge } = pkcePair();
    const fields = await renderConsentForm(formClient, challenge, randomUUID());

    const del = await adminOp({ operation: "delete", database: "flair", table: "OAuthClient", ids: [formClient] });
    expect(del.status).toBe(200);
    const before = await authCodeIds();

    const res = await submitConsentForm(fields, "approve");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "invalid_client" });
    expect(text).not.toContain("code=");

    expect(await authCodeIds()).toEqual(before);
    expect((await authCodeRowsFor(formClient)).length).toBe(0);

    const tokenRes = await exchange({
      code: randomBytes(32).toString("base64url"),
      client_id: formClient,
      redirect_uri: ALLOWED_REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(tokenRes.status).toBe(400);
    const tokenBody: any = await tokenRes.json();
    expect(tokenBody.error).toBe("invalid_grant");
    expect(tokenBody).not.toHaveProperty("access_token");
  }, 30_000);

  test("the rendered consent form submitted URL-encoded with Deny answers the access_denied redirect and stores no code", async () => {
    const formClient = `flair_cl_test_form_deny_${randomUUID()}`;
    await registerClient(formClient, "consent form deny client");
    const state = randomUUID();
    const fields = await renderConsentForm(formClient, pkcePair().challenge, state);
    const before = await authCodeIds();

    const res = await submitConsentForm(fields, "deny");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(ALLOWED_REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.has("code")).toBe(false);

    expect(await authCodeIds()).toEqual(before);
    expect((await authCodeRowsFor(formClient)).length).toBe(0);
  }, 30_000);

  test("no code was ever stored for the client named only by refused and denied requests", async () => {
    expect((await authCodeRowsFor(scopeClient)).length).toBe(0);
    expect((await authCodeRowsFor(unknownClient)).length).toBe(0);
  }, 30_000);
});
