/**
 * The client-assertion audience form (flair#2103) — the RFC 7523bis transition
 * switch in `src/mcp-client-assertion.ts`.
 *
 * Three claims:
 *   1. The switch: the default is `token-endpoint`, both values are accepted,
 *      and an unrecognised value is refused rather than treated as the default.
 *   2. The issuer form's `aud` is the authorization server metadata document's
 *      `issuer` — read from the document, never derived from the token-endpoint
 *      URL. The fixture's issuer is on a different origin from both the
 *      metadata URL and the token-endpoint URL, so a URL-derived value could
 *      not satisfy it.
 *   3. Each form's verdict under the verifier's rule as configured:
 *      `mirrorVerifyAudienceFormRule` mirrors the `aud`/`typ` policy of
 *      HarperFast/oauth #245 (merged upstream, NOT released), where the issuer
 *      is accepted and the token-endpoint URL stays accepted unless
 *      `mcp.clientCredentials.acceptTokenEndpointAudience` is `false`.
 */
import { describe, test, expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  signClientAssertion,
  clientAssertionAudienceForm,
  resolveClientAssertionAudience,
  oauthMetadataUrl,
  CLIENT_ASSERTION_AUDIENCE_ENV,
  CLIENT_ASSERTION_TYP_JWT,
  CLIENT_ASSERTION_TYP_CLIENT_AUTHENTICATION,
} from "../../src/mcp-client-assertion";

const CLIENT_ID = "https://flair.example.com/MCPClientMetadata/flint";
const TOKEN_ENDPOINT = "https://flair.example.com/oauth/mcp/token";
const METADATA_ORIGIN = "https://as.example.com";
const METADATA_URL = oauthMetadataUrl(METADATA_ORIGIN);
/** A different origin from the metadata URL AND from the token endpoint — a
 *  value derived from either could not equal it. */
const METADATA_ISSUER = "https://sso.example.net/tenant-a";

function headerOf(assertion: string): any {
  return JSON.parse(Buffer.from(assertion.split(".")[0], "base64url").toString("utf8"));
}

function claimsOf(assertion: string): any {
  const [, payload] = assertion.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function sign(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], audience: { aud: string; typ: string }) {
  return signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey, audience });
}

/** A `fetch` stand-in that records every URL it is called with. */
function metadataFetch(
  body: unknown,
  opts: { status?: number; notJson?: boolean; throwMessage?: string } = {},
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    if (opts.throwMessage) throw new Error(opts.throwMessage);
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.notJson) throw new Error("not json");
        return body;
      },
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function refusalMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err: any) {
    return String(err?.message ?? err);
  }
  throw new Error("expected a refusal, but the call resolved");
}

/**
 * The `aud`/`typ` policy of HarperFast/oauth #245 (merged upstream, not
 * released): `typ`, when present, is `JWT` or `client-authentication+jwt`
 * (case-insensitive, with an optional `application/` prefix); `aud` is a string
 * or a single-element array and must be the issuer — or the token endpoint
 * while `mcp.clientCredentials.acceptTokenEndpointAudience` is not `false`.
 * Only the audience rule is mirrored here; key, signature and claim-window
 * checks are the #165 mirror's, in mcp-client-assertion.test.ts.
 */
function mirrorVerifyAudienceFormRule(
  assertion: string,
  opts: { issuer: string; tokenEndpoint: string; acceptTokenEndpointAudience: boolean },
): { valid: true } | { valid: false; reason: string } {
  const segments = assertion.split(".");
  if (segments.length !== 3) return { valid: false, reason: "not a compact JWT" };
  const header = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8"));
  if (header.typ !== undefined) {
    if (typeof header.typ !== "string") return { valid: false, reason: "typ must be a string" };
    const normalized = header.typ.toLowerCase().replace(/^application\//, "");
    if (normalized !== "jwt" && normalized !== "client-authentication+jwt") {
      return { valid: false, reason: "client_assertion typ must be JWT or client-authentication+jwt" };
    }
  }
  const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  const aud = Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud;
  if (typeof aud !== "string") return { valid: false, reason: "aud must be a string or a single-element array" };
  const accepted = [opts.issuer, ...(opts.acceptTokenEndpointAudience ? [opts.tokenEndpoint] : [])];
  if (!accepted.includes(aud)) return { valid: false, reason: "client_assertion aud does not match an accepted audience" };
  return { valid: true };
}

describe("the audience form switch (#2103)", () => {
  test("defaults to token-endpoint, and accepts both values case-insensitively", () => {
    expect(clientAssertionAudienceForm(undefined)).toBe("token-endpoint");
    expect(clientAssertionAudienceForm("")).toBe("token-endpoint");
    expect(clientAssertionAudienceForm("  ")).toBe("token-endpoint");
    expect(clientAssertionAudienceForm("token-endpoint")).toBe("token-endpoint");
    expect(clientAssertionAudienceForm("issuer")).toBe("issuer");
    expect(clientAssertionAudienceForm("ISSUER")).toBe("issuer");
  });

  test("refuses an unrecognised value instead of defaulting", () => {
    expect(() => clientAssertionAudienceForm("jwt")).toThrow(new RegExp(CLIENT_ASSERTION_AUDIENCE_ENV));
    expect(() => clientAssertionAudienceForm("none")).toThrow(/token-endpoint/);
  });

  test("the token-endpoint form signs aud = the token endpoint with typ JWT", () => {
    const audience = resolveClientAssertionAudience({ form: "token-endpoint", tokenEndpoint: TOKEN_ENDPOINT });
    return audience.then((resolved) => {
      expect(resolved).toEqual({ aud: TOKEN_ENDPOINT, typ: CLIENT_ASSERTION_TYP_JWT });
      const { privateKey } = generateKeyPairSync("ed25519");
      const { assertion, claims } = sign(privateKey, resolved);
      expect(claims.aud).toBe(TOKEN_ENDPOINT);
      expect(headerOf(assertion)).toEqual({ alg: "EdDSA", typ: "JWT" });
    });
  });

  test("signing without an audience keeps the token-endpoint form", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const { assertion, claims } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey });
    expect(claims.aud).toBe(TOKEN_ENDPOINT);
    expect(headerOf(assertion)).toEqual({ alg: "EdDSA", typ: "JWT" });
  });
});

describe("the issuer audience form (#2103)", () => {
  test("reads the issuer from the metadata document and signs it as the sole aud", () => {
    const { fetchImpl, calls } = metadataFetch({ issuer: METADATA_ISSUER, token_endpoint: TOKEN_ENDPOINT });
    return resolveClientAssertionAudience({
      form: "issuer",
      tokenEndpoint: TOKEN_ENDPOINT,
      metadataUrl: METADATA_URL,
      fetchImpl,
    }).then((audience) => {
      expect(calls).toEqual([METADATA_URL]);
      expect(audience).toEqual({ aud: METADATA_ISSUER, typ: CLIENT_ASSERTION_TYP_CLIENT_AUTHENTICATION });
      const { privateKey } = generateKeyPairSync("ed25519");
      const { assertion, claims } = sign(privateKey, audience);
      expect(claims.aud).toBe(METADATA_ISSUER);
      expect(claimsOf(assertion).aud).toBe(METADATA_ISSUER);
      expect(headerOf(assertion)).toEqual({ alg: "EdDSA", typ: "client-authentication+jwt" });
    });
  });

  test("refuses, naming the switch and the metadata URL, when the document cannot be read", async () => {
    const { fetchImpl } = metadataFetch(undefined, { throwMessage: "connect ECONNREFUSED 127.0.0.1:443" });
    const message = await refusalMessage(
      resolveClientAssertionAudience({ form: "issuer", tokenEndpoint: TOKEN_ENDPOINT, metadataUrl: METADATA_URL, fetchImpl }),
    );
    expect(message).toContain(CLIENT_ASSERTION_AUDIENCE_ENV);
    expect(message).toContain(METADATA_URL);
    expect(message).toContain("ECONNREFUSED");
  });

  test("refuses, naming the switch and the metadata URL, on a non-OK response", async () => {
    const { fetchImpl } = metadataFetch(undefined, { status: 503 });
    const message = await refusalMessage(
      resolveClientAssertionAudience({ form: "issuer", tokenEndpoint: TOKEN_ENDPOINT, metadataUrl: METADATA_URL, fetchImpl }),
    );
    expect(message).toContain(CLIENT_ASSERTION_AUDIENCE_ENV);
    expect(message).toContain(METADATA_URL);
    expect(message).toContain("503");
  });

  test("refuses, naming the switch and the metadata URL, on a non-JSON body", async () => {
    const { fetchImpl } = metadataFetch(undefined, { notJson: true });
    const message = await refusalMessage(
      resolveClientAssertionAudience({ form: "issuer", tokenEndpoint: TOKEN_ENDPOINT, metadataUrl: METADATA_URL, fetchImpl }),
    );
    expect(message).toContain(CLIENT_ASSERTION_AUDIENCE_ENV);
    expect(message).toContain(METADATA_URL);
    expect(message).toContain("JSON");
  });

  test("refuses, naming the switch and the metadata URL, when the issuer is missing or unusable", async () => {
    for (const body of [
      {},
      { issuer: 42 },
      { issuer: "" },
      { issuer: "not-a-url" },
      { issuer: 7 },
      { issuer: "https://as.example.com/?q=1" },
      { issuer: "https://as.example.com/#fragment" },
      { issuer: "https://as.example.com/?" },
      { issuer: "https://as.example.com/#" },
    ]) {
      const { fetchImpl } = metadataFetch(body);
      const message = await refusalMessage(
        resolveClientAssertionAudience({ form: "issuer", tokenEndpoint: TOKEN_ENDPOINT, metadataUrl: METADATA_URL, fetchImpl }),
      );
      expect(message).toContain(CLIENT_ASSERTION_AUDIENCE_ENV);
      expect(message).toContain(METADATA_URL);
    }
  });

  test("refuses, naming the switch, when no metadata URL is configured", async () => {
    const message = await refusalMessage(
      resolveClientAssertionAudience({ form: "issuer", tokenEndpoint: TOKEN_ENDPOINT }),
    );
    expect(message).toContain(CLIENT_ASSERTION_AUDIENCE_ENV);
    expect(message).toContain("--issuer");
  });
});

describe("the verifier's audience rule as configured (#2103)", () => {
  const rule = { issuer: METADATA_ISSUER, tokenEndpoint: TOKEN_ENDPOINT };

  test("the token-endpoint form is accepted while acceptTokenEndpointAudience is true, and refused when false", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const audience = await resolveClientAssertionAudience({ form: "token-endpoint", tokenEndpoint: TOKEN_ENDPOINT });
    const { assertion } = sign(privateKey, audience);

    const accepted = mirrorVerifyAudienceFormRule(assertion, { ...rule, acceptTokenEndpointAudience: true });
    expect(accepted.valid).toBe(true);
    const refused = mirrorVerifyAudienceFormRule(assertion, { ...rule, acceptTokenEndpointAudience: false });
    expect(refused.valid).toBe(false);
    if (!refused.valid) expect(refused.reason).toMatch(/aud/);
  });

  test("the issuer form is accepted with either setting", async () => {
    const { fetchImpl } = metadataFetch({ issuer: METADATA_ISSUER });
    const { privateKey } = generateKeyPairSync("ed25519");
    const audience = await resolveClientAssertionAudience({
      form: "issuer",
      tokenEndpoint: TOKEN_ENDPOINT,
      metadataUrl: METADATA_URL,
      fetchImpl,
    });
    const { assertion } = sign(privateKey, audience);

    expect(mirrorVerifyAudienceFormRule(assertion, { ...rule, acceptTokenEndpointAudience: true }).valid).toBe(true);
    expect(mirrorVerifyAudienceFormRule(assertion, { ...rule, acceptTokenEndpointAudience: false }).valid).toBe(true);
  });
});
