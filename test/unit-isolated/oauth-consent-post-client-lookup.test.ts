/**
 * OAuth consent POST — the client_id it checks is the value as received. A
 * client_id that is not a string (absent, `null`, a number, an array, an
 * object) is refused with 400 invalid_client WITHOUT an OAuthClient lookup, and
 * no authorization code is written; every string is looked up, the empty string
 * included, as the consent page (GET) looks it up.
 *
 * The real-Harper behaviour of the overlapping requests (an absent, `null` and
 * array client_id) is covered by test/integration/oauth-consent-post-client.test.ts;
 * the number, object and boolean values are covered only here. This file
 * records the lookups themselves, which an HTTP test cannot see.
 *
 * Isolated lane: this file stubs `harper` for `databases`, so it must run
 * one-process-per-file — the shared `test/unit` process would let its stub
 * poison a sibling file's module cache.
 */
import { mock, describe, it, expect, beforeEach } from "bun:test";

const REGISTERED = "flair_cl_registered";
const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";

/** Every id passed to OAuthClient.get, in order. */
const lookups: unknown[] = [];
/** Every row passed to OAuthAuthCode.put. */
const codePuts: unknown[] = [];

// Same shape as the sibling isolated tests' harper stub: `Resource` and every
// unknown `databases.flair.*` model is a no-op class (XAA.ts extends
// `databases.flair.IdpConfig` at load time).
class NoopBase { constructor(_id?: any, _ctx?: any) {} }
const flairStub = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === "OAuthClient") {
      return {
        get: async (id: unknown) => {
          lookups.push(id);
          return id === REGISTERED ? { id: REGISTERED, name: "Registered App" } : null;
        },
      };
    }
    if (prop === "OAuthAuthCode") return { put: async (row: unknown) => { codePuts.push(row); return row; } };
    return NoopBase;
  },
});

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  Resource: NoopBase,
  databases: { flair: flairStub },
}));

const { OAuthAuthorize } = await import("../../resources/OAuth.ts");

beforeEach(() => {
  lookups.length = 0;
  codePuts.length = 0;
});

/** POST the consent form with no credentials: the client check runs before authentication. */
function post(fields: Record<string, unknown>): Promise<Response> {
  const inst: any = new (OAuthAuthorize as any)();
  inst.getContext = () => ({ request: { headers: { get: () => undefined } } });
  return inst.post({
    action: "approve",
    redirect_uri: ALLOWED_REDIRECT_URI,
    scope: "memory:read",
    state: "s1",
    code_challenge: "cc",
    code_challenge_method: "S256",
    ...fields,
  });
}

describe("consent POST — client_id lookup", () => {
  const nonStrings: Array<[string, Record<string, unknown>]> = [
    ["absent", {}],
    ["null", { client_id: null }],
    ["a number", { client_id: 42 }],
    ["an array holding a registered id", { client_id: [REGISTERED] }],
    ["an object", { client_id: { id: REGISTERED } }],
    ["a boolean", { client_id: true }],
  ];

  for (const [label, fields] of nonStrings) {
    it(`a client_id that is ${label} is refused with 400 invalid_client and no OAuthClient lookup`, async () => {
      const res = await post(fields);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_client" });
      expect(lookups).toEqual([]);
      expect(codePuts).toEqual([]);
    });
  }

  it("an empty-string client_id is looked up, as the consent page looks it up, and refused with invalid_client", async () => {
    const res = await post({ client_id: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_client" });
    expect(lookups).toEqual([""]);
    expect(codePuts).toEqual([]);

    lookups.length = 0;
    const page: any = new (OAuthAuthorize as any)();
    page.getContext = () => ({ request: { url: "https://flair.example.com/OAuthAuthorize?response_type=code&client_id=" } });
    const pageRes = await page.get();
    expect(pageRes.status).toBe(400);
    expect(await pageRes.json()).toEqual({ error: "invalid_client" });
    expect(lookups).toEqual([""]);
  });

  it("a registered client_id is looked up and passes the client check (the request then stops at authentication)", async () => {
    const res = await post({ client_id: REGISTERED });
    expect(lookups).toEqual([REGISTERED]);
    expect(res.status).toBe(401);
    expect(codePuts).toEqual([]);
  });
});
