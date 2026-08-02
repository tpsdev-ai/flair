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
  let savedRegisterLimit: string | undefined;

  beforeAll(async () => {
    savedToken = process.env.FLAIR_OAUTH_DCR_TOKEN;
    delete process.env.FLAIR_OAUTH_DCR_TOKEN;
    // The registration rate limiter runs BEFORE this gate (deliberately — see
    // the ordering test at the bottom of this file), and its default budget is
    // 5 per five minutes. These cases make more registration attempts than that
    // against one instance, so at the default the later ones would be answered
    // 429 by the limiter and never reach the gate under test. Raising it takes
    // an unrelated control out of the path; it does not weaken a single
    // assertion below, each of which still demands an exact status and body.
    savedRegisterLimit = process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT;
    process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT = "100";
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (savedToken === undefined) delete process.env.FLAIR_OAUTH_DCR_TOKEN;
    else process.env.FLAIR_OAUTH_DCR_TOKEN = savedToken;
    if (savedRegisterLimit === undefined) delete process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT;
    else process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT = savedRegisterLimit;
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
  let savedRegisterLimit: string | undefined;

  beforeAll(async () => {
    savedToken = process.env.FLAIR_OAUTH_DCR_TOKEN;
    process.env.FLAIR_OAUTH_DCR_TOKEN = TOKEN;
    // Same reason as the closed block: keep the registration limiter out of the
    // path so these assertions test the gate. This block currently makes four
    // registration requests against a default budget of five — it passes today
    // by one request, and the fifth test anyone adds would fail for a reason
    // that has nothing to do with what they were testing.
    savedRegisterLimit = process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT;
    process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT = "100";
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (savedToken === undefined) delete process.env.FLAIR_OAUTH_DCR_TOKEN;
    else process.env.FLAIR_OAUTH_DCR_TOKEN = savedToken;
    if (savedRegisterLimit === undefined) delete process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT;
    else process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT = savedRegisterLimit;
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
    expect(res.status).toBe(200);
    const doc = await res.json() as any;
    expect(doc.registration_endpoint).toBe(`${doc.issuer}/OAuthRegister`);
  });
});

// ─── The limiter sits IN FRONT of the gate ──────────────────────────────────

describe("the registration rate limiter runs BEFORE the DCR gate (real Harper)", () => {
  // This is the interaction that broke both of these suites when rate limiting
  // and the DCR gate first met on one branch: every registration attempt spends
  // budget, INCLUDING the ones the gate is about to refuse, so a flood against a
  // closed endpoint is answered 429 rather than 403.
  //
  // That is the order we want. The limiter is the cheaper check and it is the
  // one protecting the endpoint from volume; making the gate run first would
  // mean an attacker's refused attempts cost the server gate work and never
  // exhausted anything. Nothing asserted it, so it took a CI failure on a
  // combined branch to notice — hence this test.
  let harper: HarperInstance;
  let savedToken: string | undefined;
  let savedRegisterLimit: string | undefined;
  const LIMIT = 3;

  beforeAll(async () => {
    savedToken = process.env.FLAIR_OAUTH_DCR_TOKEN;
    delete process.env.FLAIR_OAUTH_DCR_TOKEN; // closed: every attempt is gate-refused
    savedRegisterLimit = process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT;
    process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT = String(LIMIT);
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (savedToken === undefined) delete process.env.FLAIR_OAUTH_DCR_TOKEN;
    else process.env.FLAIR_OAUTH_DCR_TOKEN = savedToken;
    if (savedRegisterLimit === undefined) delete process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT;
    else process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT = savedRegisterLimit;
  });

  test("refused registrations still spend budget, and the limiter answers once it is gone", async () => {
    const seen: number[] = [];
    for (let i = 0; i < LIMIT + 2; i++) seen.push((await register(harper, `flood-${i}`)).status);
    // The first LIMIT attempts reach the gate and are refused by it...
    expect(seen.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(403));
    // ...and past that the limiter answers first, so the gate is never reached.
    expect(seen.slice(LIMIT)).toEqual([429, 429]);
  });
});
