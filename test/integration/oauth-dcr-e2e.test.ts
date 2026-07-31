// oauth-dcr-e2e.test.ts — dynamic client registration, over real HTTP against a
// real Harper spawn.
//
// The unit test proves the gate's logic. This proves it is REACHED: that a
// default install genuinely refuses `POST /OAuthRegister`, that no client row is
// created when it does, and that an operator who opts in genuinely gets a
// working endpoint. Two Harper instances, because the difference under test is a
// boot-time environment variable.
//
// MODEL: test/integration/oauth-authorize-authz.test.ts.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";
const HEADER = "x-flair-initial-access-token";
// Generated, not a literal, so nothing token-shaped is committed to the repo.
const TOKEN = randomBytes(24).toString("base64url");

function registerBody(name: string) {
  return JSON.stringify({ client_name: name, redirect_uris: [ALLOWED_REDIRECT_URI] });
}

async function register(h: HarperInstance, name: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${h.httpURL}/OAuthRegister`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: registerBody(name),
  });
  return { status: res.status, text: await res.text() };
}

/** How many OAuthClient rows exist, via the admin ops API. */
async function clientRowCount(h: HarperInstance): Promise<number> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`),
    },
    body: JSON.stringify({ operation: "search_by_value", database: "flair", table: "OAuthClient", search_attribute: "registeredBy", search_value: "dcr", get_attributes: ["id"] }),
  });
  if (res.status !== 200) return -1;
  const rows = await res.json() as any[];
  return Array.isArray(rows) ? rows.length : -1;
}

// ─── Default install: registration is closed ────────────────────────────────

describe("DCR is closed on a default install (real Harper)", () => {
  let harper: HarperInstance;
  let savedToken: string | undefined;

  beforeAll(async () => {
    savedToken = process.env.FLAIR_OAUTH_DCR_TOKEN;
    delete process.env.FLAIR_OAUTH_DCR_TOKEN;
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (savedToken === undefined) delete process.env.FLAIR_OAUTH_DCR_TOKEN;
    else process.env.FLAIR_OAUTH_DCR_TOKEN = savedToken;
  });

  test("an anonymous POST /OAuthRegister is refused with 403", async () => {
    const res = await register(harper, "uninvited");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text).error).toBe("access_denied");
  });

  test("NO client row is created by a refused registration", async () => {
    // The point of the endpoint being closed is the durable, replicated row it
    // no longer creates. A 403 that still wrote would be no fix at all.
    const before = await clientRowCount(harper);
    expect(before).toBeGreaterThanOrEqual(0); // the ops probe itself works
    for (let i = 0; i < 3; i++) await register(harper, `uninvited-${i}`);
    expect(await clientRowCount(harper)).toBe(before);
  });

  test("presenting a token when none is configured does not open it", async () => {
    const res = await register(harper, "guesser", { [HEADER]: "a".repeat(40) });
    expect(res.status).toBe(403);
  });

  test("the refusal happens BEFORE the redirect-URI policy is applied", async () => {
    // A bad redirect URI would be a 400 invalid_redirect_uri if the policy ran
    // first. A closed endpoint must not double as a probe for what this server
    // would accept.
    const res = await fetch(`${harper.httpURL}/OAuthRegister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "probe", redirect_uris: ["https://evil.example.com/cb"] }),
    });
    expect(res.status).toBe(403);
    expect((await res.text())).not.toContain("invalid_redirect_uri");
  });

  test("discovery does NOT advertise a registration endpoint", async () => {
    for (const path of ["/.well-known/oauth-authorization-server", "/OAuthMetadata"]) {
      const res = await fetch(`${harper.httpURL}${path}`);
      expect(res.status).toBe(200);
      const doc = await res.json() as any;
      // POSITIVE CONTROL: the document is otherwise intact.
      expect(doc.token_endpoint).toBe(`${doc.issuer}/OAuthToken`);
      expect(doc.registration_endpoint).toBeUndefined();
    }
  });
});

// ─── Opted in: registration works, and only with the token ──────────────────

describe("DCR when an operator has opted in (real Harper)", () => {
  let harper: HarperInstance;
  let savedToken: string | undefined;

  beforeAll(async () => {
    savedToken = process.env.FLAIR_OAUTH_DCR_TOKEN;
    process.env.FLAIR_OAUTH_DCR_TOKEN = TOKEN;
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (savedToken === undefined) delete process.env.FLAIR_OAUTH_DCR_TOKEN;
    else process.env.FLAIR_OAUTH_DCR_TOKEN = savedToken;
  });

  test("POSITIVE CONTROL: the right initial access token registers a client", async () => {
    const res = await register(harper, "invited", { [HEADER]: TOKEN });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).client_id).toStartWith("flair_cl_");
  });

  test("no token → 401, and no row", async () => {
    const before = await clientRowCount(harper);
    const res = await register(harper, "no-token");
    expect(res.status).toBe(401);
    expect(JSON.parse(res.text).error).toBe("invalid_token");
    expect(await clientRowCount(harper)).toBe(before);
  });

  test("a wrong token → 401, and no row", async () => {
    const before = await clientRowCount(harper);
    const res = await register(harper, "wrong-token", { [HEADER]: randomBytes(24).toString("base64url") });
    expect(res.status).toBe(401);
    expect(await clientRowCount(harper)).toBe(before);
  });

  test("the token in an Authorization: Bearer header does not work", async () => {
    // Harper's own auth layer claims that header before flair's code runs, which
    // is why the token travels in a dedicated one. Pinned so nobody 'fixes' the
    // gate to read Bearer and ships a path that can never be reached.
    const res = await register(harper, "bearer-attempt", { authorization: `Bearer ${TOKEN}` });
    expect(res.status).not.toBe(200);
  });

  test("discovery advertises the registration endpoint again", async () => {
    const res = await fetch(`${harper.httpURL}/.well-known/oauth-authorization-server`);
    const doc = await res.json() as any;
    expect(doc.registration_endpoint).toBe(`${doc.issuer}/OAuthRegister`);
  });
});
