// mcp-audience-binding-igmt.test.ts — ops-igmt: EXECUTED must-fail proof that
// flair's /mcp audience binding rejects tokens minted for a different resource
// or a different issuer, and accepts the correctly-bound token.
//
// This is the "a read is not a firing" closure: flint verified by READ that
// @harperfast/oauth 2.5.0 withMCPAuth verifies {audience: <issuer>/mcp, issuer}
// and 401s with resource_metadata. This test FIRES it against a live ephemeral
// Harper (never prod) by seeding a signing key we control and hand-signing three
// tokens:
//
//   (1) aud = <other resource>, iss = pinned  -> 401 invalid_token
//   (2) aud = <issuer>/mcp,   iss = pinned  -> accepted (handler runs)
//   (3) aud = <issuer>/mcp,   iss = <other> -> 401 invalid_token
//
// The signing key is seeded directly into oauth.harper_oauth_mcp_keys (the same
// table withMCPAuth's getAllPublicKeys reads) so we hold the private half and can
// mint arbitrary tokens without going through the plugin's own mint path.
//
// Tokens are signed with `jose` (a direct flair dependency) rather than
// `jsonwebtoken` (only transitive via @harperfast/oauth), so the lock does not
// depend on a hoisted transitive package.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const ISSUER = "https://mcp-aud-test.flair.internal";
const RESOURCE = `${ISSUER}/mcp`;
const OTHER_RESOURCE = "https://other.example/mcp";
const OTHER_ISSUER = "https://evil.example";
const KID = "igmt-test-key";

let harper: HarperInstance;
let privateKeyPem: string;
let publicKeyPem: string;

function basicHeader(): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicHeader() },
    body: JSON.stringify(op),
  });
}

async function signToken(opts: { audience: string; issuer: string }): Promise<string> {
  const key = await importPKCS8(privateKeyPem, "RS256");
  return new SignJWT({ client_id: "igmt-client", scope: "openid" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject("igmt-agent")
    .setExpirationTime("5m")
    .sign(key);
}

async function postMcp(token: string): Promise<{ status: number; wwwAuth: string | null; body: string }> {
  const res = await fetch(`${harper.httpURL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  return {
    status: res.status,
    wwwAuth: res.headers.get("www-authenticate"),
    body: await res.text(),
  };
}

describe("MCP audience binding (ops-igmt) — executed must-fail", () => {
  beforeAll(async () => {
    // Generate an RSA keypair we control, so we can hand-sign tokens.
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    publicKeyPem = publicKey;
    privateKeyPem = privateKey;

    // Enable MCP OAuth with a pinned issuer. "true" (not "1") so BOTH flair's
    // mcpOAuthEnabled() and the component's coerceConfigBoolean agree (flair#1152).
    process.env.FLAIR_MCP_OAUTH = "true";
    process.env.FLAIR_MCP_ISSUER = ISSUER;

    harper = await startHarper({ cwd: process.cwd() });

    // Seed the signing key into the table withMCPAuth verifies against.
    const seed = await adminOp({
      operation: "insert",
      database: "oauth",
      table: "harper_oauth_mcp_keys",
      records: [
        {
          kid: KID,
          alg: "RS256",
          public_key_pem: publicKeyPem,
          private_key_pem: privateKeyPem,
          created_at: Math.floor(Date.now() / 1000),
        },
      ],
    });
    expect(seed.status).toBe(200);
  }, 180_000);

  afterAll(async () => {
    await stopHarper(harper);
  });

  test("(1) wrong audience -> 401 invalid_token + resource_metadata", async () => {
    const token = await signToken({ audience: OTHER_RESOURCE, issuer: ISSUER });
    const r = await postMcp(token);
    expect(r.status).toBe(401);
    expect(r.wwwAuth).toMatch(/^Bearer\s+resource_metadata="/);
    expect(r.body).toContain("invalid_token");
  });

  test("(2) correct audience + issuer -> accepted (handler runs)", async () => {
    const token = await signToken({ audience: RESOURCE, issuer: ISSUER });
    const r = await postMcp(token);
    // Not 401: withMCPAuth passed the request to the handler, which returns a
    // JSON-RPC response (200) for a valid initialize.
    expect(r.status).toBe(200);
    expect(r.wwwAuth).toBeNull();
    expect(r.body).toContain("jsonrpc");
  });

  test("(3) correct audience but wrong issuer -> 401 invalid_token", async () => {
    const token = await signToken({ audience: RESOURCE, issuer: OTHER_ISSUER });
    const r = await postMcp(token);
    expect(r.status).toBe(401);
    expect(r.wwwAuth).toMatch(/^Bearer\s+resource_metadata="/);
    expect(r.body).toContain("invalid_token");
  });
});
