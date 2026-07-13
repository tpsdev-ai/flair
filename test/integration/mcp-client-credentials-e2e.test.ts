// mcp-client-credentials-e2e.test.ts — live-Harper proof of RFC 7523
// client_credentials agent-auth against the PUBLISHED @harperfast/oauth@2.2.0
// package, as far as an ephemeral, network-isolated local Harper can take it.
//
// ── What this proves, live, against a REAL running plugin ──────────────────
//  1. The AS's `/.well-known/oauth-authorization-server` discovery document
//     advertises `client_credentials` + `private_key_jwt` + `EdDSA` when
//     `mcp.clientCredentials.enabled` — our config wiring produces the
//     behavior #170/#171 actually ship.
//  2. Our production `resources/MCPClientMetadata.ts` document is genuinely
//     CIMD-shaped to the real, live token endpoint: a real client_credentials
//     grant request naming our agent's client_id reaches
//     `resolveClient()`/`isCimdClientId()` and is recognized as a CIMD
//     candidate — it is rejected ONLY by the plugin's unconditional SSRF/DNS
//     gate (see below), never by a shape/validation error. That is the
//     furthest a fully-live network round trip can be driven inside this
//     environment.
//  3. A client_id whose host isn't on `clientIdMetadataDocuments.allowedHosts`
//     is rejected with a DIFFERENT, distinguishable error ("Unknown client")
//     — proving the allowlist gate is live and distinct from the SSRF gate.
//  4. Our shipped `requestMcpAccessToken` client helper correctly surfaces
//     the live rejection as a thrown `McpTokenRequestError`, not a hang or a
//     mis-parse.
//
// ── Why the full token MINT can't be forced further here (read before
//    extending this file) ───────────────────────────────────────────────────
// `@harperfast/oauth@2.2.0`'s CIMD document fetch
// (`node_modules/@harperfast/oauth/dist/lib/mcp/cimd.js`) enforces an
// UNCONDITIONAL SSRF gate: `https://` scheme required (no loopback
// exception — contrast `mcp.issuer`'s explicit loopback carve-out for TLS in
// `dist/index.js`, which has no analog here) and every resolved DNS address
// is checked against the full IANA private/loopback/link-local ranges with
// NO override or allowlist knob. A CIMD document served by THIS SAME
// ephemeral Harper (loopback, no public DNS) can therefore never be fetched
// by the AS over a real network hop — by design, not a bug. The plugin
// exports `_setDnsLookup`/`_setFetch` test-injection hooks for exactly this
// class of problem (used in
// test/unit/mcp-client-credentials-live-package.test.ts), but those only
// help when the test and the plugin code run in the SAME process. This test
// spawns Harper as a CHILD PROCESS (this repo's established
// `harper-lifecycle.ts` pattern); a spawned Harper does not share this test
// process's module registry. Worse, EMPIRICAL investigation while building
// this test found Harper's OWN component loader gives each
// `package:`-declared sibling component (flair's own `jsResource`-loaded
// resources vs. this `'@harperfast/oauth': {package: ...}` component) an
// ISOLATED module graph even within the SAME process/thread — a
// same-process JS resource that deep-imports `cimd.js` and arms
// `_setDnsLookup`/`_setFetch` on ITS OWN import instance does NOT affect the
// separate module instance the plugin's own `/oauth/mcp/token` route uses
// internally (confirmed by direct experiment: the harness's own `resolveClient`
// call succeeded against the mocked transport; the live HTTP endpoint,
// hit immediately after, still failed with the identical SSRF rejection).
// A DCR-store seed (bypassing CIMD resolution entirely) is also not a
// substitute: `MCPClientStore`'s `encodeRecord`/`decodeRecord`
// (`node_modules/@harperfast/oauth/dist/lib/mcp/clientStore.js`) have no
// `jwks`/`_cimd` fields at all, so a stored client can never satisfy
// `handleClientCredentialsGrant`'s `client._cimd !== true` gate — confirmed
// by reading the source, not assumed. See
// docs/notes/mcp-agent-auth-consumer.md for the full writeup. The rate-limit
// (#171/#163) and post-auth-debit-ordering proofs therefore live in
// test/unit/mcp-client-credentials-live-package.test.ts instead, composing
// the plugin's REAL `verifyClientAssertion`/`createRateLimiter` in-process —
// they cannot be reached via this live endpoint at all (client resolution
// always fails first).
//
// ── The oauth plugin as a live component (validated mechanism) ────────────
// `@harperfast/oauth` is a real `dependencies` entry (package.json) but is
// NEVER loaded as a Harper component by this repo's shipped `config.yaml` —
// `resources/mcp-oauth.ts` only ever does a bare `import("@harperfast/oauth")`
// for its `withMCPAuth` named export, wrapping flair's OWN `/mcp` handler.
// The full plugin (its `/oauth/mcp/token` route, `.well-known/*` discovery,
// `harper_oauth_mcp_*` tables) only mounts when declared as a Harper
// component — `'<name>': { package: '<npm-pkg>', ...options }` inside
// `config.yaml`, exactly the pattern this file used to use for
// `harper-fabric-embeddings` before flair#504/694 moved that to in-process
// boot (see config.yaml's own history/comments). This test stages that
// block into a TEMPORARY copy of config.yaml for its own lifetime only
// (restored in `afterAll`, even on failure) — `bun test test/integration/`
// runs test files sequentially in one process (this repo's CI invokes it as
// a single `bun test test/integration/`), so this mutation window never
// overlaps another integration test's own `startHarper()` config read.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import {
  signClientAssertion,
  buildTokenRequestForm,
  publicJwkFromPrivateKey,
  requestMcpAccessToken,
  McpTokenRequestError,
} from "../../src/mcp-client-assertion";

const CONFIG_PATH = join(process.cwd(), "config.yaml");
const ISSUER = "https://cimd-test.flair-663.internal";
const ALLOWED_HOST = "cimd-test.flair-663.internal";
const AGENT_ID = "mcp-cc-e2e-agent";

const OAUTH_COMPONENT_BLOCK = `
'@harperfast/oauth':
  package: '@harperfast/oauth'
  providers:
    testprovider:
      provider: 'generic'
      clientId: 'test-client-id'
      clientSecret: 'test-client-secret'
      authorizationUrl: 'https://example.invalid/authorize'
      tokenUrl: 'https://example.invalid/token'
      userInfoUrl: 'https://example.invalid/userinfo'
  mcp:
    enabled: true
    issuer: '${ISSUER}'
    clientCredentials:
      enabled: true
      rateLimit: 30
    clientIdMetadataDocuments:
      allowedHosts:
        - '${ALLOWED_HOST}'
`;

let originalConfig: string;
let harper: HarperInstance;
let clientId: string;
let tokenEndpoint: string;
let agentPrivateKey: KeyObject;

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64"),
    },
    body: JSON.stringify(op),
  });
}

describe("MCP client_credentials agent-auth vs. a live @harperfast/oauth@2.2.0 component", () => {
  beforeAll(async () => {
    originalConfig = readFileSync(CONFIG_PATH, "utf8");
    writeFileSync(CONFIG_PATH, originalConfig + OAUTH_COMPONENT_BLOCK);

    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = ISSUER;

    harper = await startHarper();

    // Seed the agent MCPClientMetadata.ts will serve a CIMD document for.
    const agentKeyPair = generateKeyPairSync("ed25519");
    agentPrivateKey = agentKeyPair.privateKey;
    const agentJwk = publicJwkFromPrivateKey(agentPrivateKey);
    const agentRes = await adminOp({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{ id: AGENT_ID, name: AGENT_ID, role: "agent", publicKey: agentJwk.x, createdAt: new Date().toISOString() }],
    });
    expect(agentRes.status).toBe(200);

    clientId = `${ISSUER}/MCPClientMetadata/${AGENT_ID}`;
    tokenEndpoint = `${ISSUER}/oauth/mcp/token`;
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    writeFileSync(CONFIG_PATH, originalConfig);
    delete process.env.FLAIR_MCP_OAUTH;
    delete process.env.FLAIR_MCP_ISSUER;
  });

  test("the plugin mounts for real: /.well-known/oauth-authorization-server advertises client_credentials + private_key_jwt + EdDSA", async () => {
    const res = await fetch(`${harper.httpURL}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.issuer).toBe(ISSUER);
    expect(body.token_endpoint).toBe(tokenEndpoint);
    expect(body.grant_types_supported).toContain("client_credentials");
    expect(body.token_endpoint_auth_methods_supported).toContain("private_key_jwt");
    expect(body.token_endpoint_auth_signing_alg_values_supported).toEqual(["EdDSA"]);
    expect(body.client_id_metadata_document_supported).toBe(true);
  }, 30_000);

  test("our MCPClientMetadata document is served correctly (sanity check, over the real live server)", async () => {
    const res = await fetch(`${harper.httpURL}/MCPClientMetadata/${AGENT_ID}`);
    expect(res.status).toBe(200);
    const doc: any = await res.json();
    expect(doc.client_id).toBe(clientId);
    expect(doc.grant_types).toEqual(["client_credentials"]);
    expect(doc.token_endpoint_auth_method).toBe("private_key_jwt");
    expect(doc.jwks.keys).toHaveLength(1);
  }, 30_000);

  test("a real client_credentials grant naming our agent reaches CIMD resolution and is rejected ONLY by the SSRF/DNS gate — not a shape error", async () => {
    const { assertion } = signClientAssertion({ clientId, tokenEndpoint, privateKey: agentPrivateKey });
    const form = buildTokenRequestForm({ clientId, assertion, resource: `${ISSUER}/mcp` });
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, String(v));

    const res = await fetch(`${harper.httpURL}/oauth/mcp/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(401);
    const payload: any = await res.json();
    expect(payload.error).toBe("invalid_client");
    // The DNS-gate rejection message (cimd.js's DNS_GATE_REJECTION) — deliberately
    // uniform/detail-free by the plugin's own design (never echoes the resolved
    // address). Its presence, rather than a "missing field"/"invalid document"
    // message, proves our document reached validation-adjacent code, not that it
    // was thrown out earlier for being malformed.
    expect(payload.error_description).toMatch(/could not be resolved to a permitted address/);
  }, 30_000);

  test("a client_id host NOT on allowedHosts is rejected as an unknown client — distinct from the SSRF-gate rejection above", async () => {
    const offAllowlistClientId = `https://not-allowlisted.flair-663.internal/MCPClientMetadata/${AGENT_ID}`;
    const { assertion } = signClientAssertion({ clientId: offAllowlistClientId, tokenEndpoint, privateKey: agentPrivateKey });
    const form = buildTokenRequestForm({ clientId: offAllowlistClientId, assertion, resource: `${ISSUER}/mcp` });
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, String(v));

    const res = await fetch(`${harper.httpURL}/oauth/mcp/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(401);
    const payload: any = await res.json();
    expect(payload.error).toBe("invalid_client");
    expect(payload.error_description).toMatch(/Unknown client/);
    expect(payload.error_description).not.toMatch(/could not be resolved to a permitted address/);
  }, 30_000);

  test("requestMcpAccessToken (our shipped client helper) surfaces the live rejection as McpTokenRequestError, not a hang or mis-parse", async () => {
    const { assertion } = signClientAssertion({ clientId, tokenEndpoint, privateKey: agentPrivateKey });
    const form = buildTokenRequestForm({ clientId, assertion, resource: `${ISSUER}/mcp` });

    try {
      await requestMcpAccessToken(form, tokenEndpoint.replace(ISSUER, harper.httpURL), { maxRetries: 0 });
      throw new Error("expected requestMcpAccessToken to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTokenRequestError);
      expect((err as McpTokenRequestError).status).toBe(401);
      expect((err as McpTokenRequestError).error).toBe("invalid_client");
    }
  }, 30_000);
});
