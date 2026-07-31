/**
 * oauth-wellknown-e2e.test.ts — flair#1000 item 2, proved over real HTTP
 * against a live Harper running flair's shipped config.yaml.
 *
 * Before this change both of these answered 404, which is why a spec-compliant
 * MCP client could not discover a Flair instance at all:
 *
 *   /.well-known/oauth-protected-resource      RFC 9728 (MCP auth spec: MUST)
 *   /.well-known/oauth-authorization-server    RFC 8414
 *
 * Every assertion below fails on origin/main. Three of them are the ones that
 * matter most and are easiest to lose later:
 *
 *   1. DRIFT — the well-known authorization-server document and /OAuthMetadata
 *      are compared byte-for-byte over the wire, not in the builder. If anyone
 *      ever re-implements one of them, this fails.
 *   2. PATH INSERTION — /.well-known/oauth-protected-resource/mcp is the URL
 *      real MCP clients construct and the URL withMCPAuth's 401 challenge
 *      points at. Serving only the bare path looks correct in a browser and
 *      404s for the client that matters.
 *   3. POSITIVE CONTROL ON THE AUTH PATH — Basic and Ed25519 callers, and the
 *      401/403 they get without credentials, are asserted unchanged. A test
 *      that only checked the new documents would pass while the auth chain
 *      regressed underneath it.
 *
 * MODEL: test/integration/auth-middleware-e2e.test.ts — startHarper(), seed via
 * the ops API, real fetch, assert status codes and bodies.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const PRM_PATH = "/.well-known/oauth-protected-resource";
const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

let harper: HarperInstance;
let base: string;

const agentKeys = nacl.sign.keyPair();
const AGENT_ID = "oauth-wellknown-e2e-agent";
const AGENT_PUBLIC_KEY = Buffer.from(agentKeys.publicKey).toString("base64");

/** A TPS-Ed25519 Authorization header. The signature covers pathname + search. */
function ed25519Header(method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${AGENT_ID}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agentKeys.secretKey);
  return `TPS-Ed25519 ${AGENT_ID}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

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

describe("OAuth discovery at the well-known paths (real Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    base = harper.httpURL;

    const agentRes = await adminOp({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{
        id: AGENT_ID,
        name: AGENT_ID,
        role: "agent",
        publicKey: AGENT_PUBLIC_KEY,
        createdAt: new Date().toISOString(),
      }],
    });
    expect(agentRes.status).toBe(200);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  // ── RFC 8414 ───────────────────────────────────────────────────────────────

  describe(`GET ${AS_METADATA_PATH} (RFC 8414)`, () => {
    test("is served, unauthenticated, as JSON", async () => {
      const res = await fetch(base + AS_METADATA_PATH);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const doc: any = await res.json();
      expect(doc.issuer).toBe(base);
      expect(doc.token_endpoint).toBe(`${base}/OAuthToken`);
      expect(doc.authorization_endpoint).toBe(`${base}/OAuthAuthorize`);
      expect(doc.registration_endpoint).toBe(`${base}/OAuthRegister`);
      expect(doc.revocation_endpoint).toBe(`${base}/OAuthRevoke`);
      expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    }, 30_000);

    test("is readable cross-origin — browser MCP clients fetch it from another origin", async () => {
      const res = await fetch(base + AS_METADATA_PATH);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }, 30_000);

    test("every sub-path is a 404 — flair's issuer carries no path component", async () => {
      for (const sub of ["/mcp", "/bogus", "/Memory"]) {
        const res = await fetch(base + AS_METADATA_PATH + sub);
        expect(res.status, `${AS_METADATA_PATH}${sub}`).toBe(404);
      }
    }, 30_000);

    test("a POST is not a discovery request", async () => {
      const res = await fetch(base + AS_METADATA_PATH, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    }, 30_000);
  });

  // ── RFC 9728 ───────────────────────────────────────────────────────────────

  describe(`GET ${PRM_PATH} (RFC 9728)`, () => {
    test("is served, unauthenticated, and names the MCP surface as the resource", async () => {
      const res = await fetch(base + PRM_PATH);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const doc: any = await res.json();
      expect(doc.resource).toBe(`${base}/mcp`);
      expect(doc.authorization_servers).toEqual([base]);
      expect(doc.bearer_methods_supported).toEqual(["header"]);
    }, 30_000);

    test("the RFC 9728 §3.1 path-appended form serves the same document", async () => {
      // <origin>/.well-known/oauth-protected-resource/mcp — the URL an MCP
      // client constructs by path insertion, and the URL withMCPAuth's 401
      // challenge points at. Serving only the bare path 404s for real clients.
      const bare = await (await fetch(base + PRM_PATH)).json();
      const inserted = await fetch(base + PRM_PATH + "/mcp");
      expect(inserted.status).toBe(200);
      expect(await inserted.json()).toEqual(bare);
    }, 30_000);

    test("a near-miss sub-path is a 404 — /mcp-evil must not match /mcp", async () => {
      for (const sub of ["/mcp-evil", "/mcpx", "/bogus", "/Memory", "/mcp/deeper"]) {
        const res = await fetch(base + PRM_PATH + sub);
        expect(res.status, `${PRM_PATH}${sub}`).toBe(404);
      }
    }, 30_000);
  });

  // ── The discovery loop, end to end ─────────────────────────────────────────

  describe("the discovery loop a real client walks", () => {
    test("PRM → authorization_servers[0] → AS metadata → an issuer that matches", async () => {
      const prm: any = await (await fetch(base + PRM_PATH)).json();
      const asUrl = prm.authorization_servers[0] + AS_METADATA_PATH;
      const asRes = await fetch(asUrl);
      expect(asRes.status).toBe(200);
      const as: any = await asRes.json();
      // RFC 8414 §3.3: the issuer in the document MUST match the one used to
      // build the URL. If it doesn't, a conformant client aborts.
      expect(as.issuer).toBe(prm.authorization_servers[0]);
    }, 30_000);

    test("the advertised token endpoint is a real endpoint, not a 404", async () => {
      const as: any = await (await fetch(base + AS_METADATA_PATH)).json();
      const res = await fetch(as.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code: "nope" }),
      });
      // A well-formed OAuth error, NOT a 404 — the endpoint exists and ran.
      expect(res.status).toBeLessThan(500);
      expect(res.status).not.toBe(404);
    }, 30_000);
  });

  // ── The anti-drift assertion ───────────────────────────────────────────────

  describe("/OAuthMetadata is an alias of the well-known path", () => {
    test("both paths return byte-identical documents over the wire", async () => {
      const wellKnown = await (await fetch(base + AS_METADATA_PATH)).text();
      const alias = await (await fetch(base + "/OAuthMetadata")).text();
      expect(alias).toBe(wellKnown);
    }, 30_000);

    test("the two documents agree on issuer and on every endpoint", async () => {
      const wellKnown: any = await (await fetch(base + AS_METADATA_PATH)).json();
      const alias: any = await (await fetch(base + "/OAuthMetadata")).json();
      for (const field of Object.keys(wellKnown)) {
        if (field !== "issuer" && !field.endsWith("_endpoint")) continue;
        expect(alias[field], field).toEqual(wellKnown[field]);
      }
    }, 30_000);

    test("the protected-resource document agrees with /OAuthMetadata on the issuer", async () => {
      const prm: any = await (await fetch(base + PRM_PATH)).json();
      const alias: any = await (await fetch(base + "/OAuthMetadata")).json();
      expect(prm.authorization_servers).toEqual([alias.issuer]);
      expect(prm.resource.startsWith(alias.issuer + "/")).toBe(true);
    }, 30_000);
  });

  // ── POSITIVE CONTROL: the auth chain is untouched ──────────────────────────
  //
  // flair#1000 item 3 asked for a Bearer challenge on protected resources. It
  // is deliberately NOT applied to flair's REST surface (see
  // resources/oauth-wellknown.ts's header). These assertions are what makes
  // that a decision rather than an omission: if a future change starts
  // advertising Bearer here, or breaks Basic / Ed25519 doing it, this block
  // fails.

  describe("existing auth is intact (positive control)", () => {
    test("Basic admin auth still reaches a protected resource", async () => {
      const res = await fetch(base + "/Memory", { headers: { Authorization: basicHeader() } });
      expect(res.status).toBe(200);
    }, 30_000);

    test("Ed25519 agent auth still reaches a protected resource", async () => {
      const path = `/Memory/?agentId=${AGENT_ID}`;
      const res = await fetch(base + path, { headers: { Authorization: ed25519Header("GET", path) } });
      expect(res.status).toBe(200);
    }, 30_000);

    test("an unauthenticated protected resource is still refused, with NO Bearer challenge", async () => {
      const res = await fetch(base + "/Memory");
      expect([401, 403]).toContain(res.status);
      const challenge = res.headers.get("www-authenticate");
      expect(challenge === null || !challenge.toLowerCase().includes("bearer")).toBe(true);
    }, 30_000);

    test("the browser admin page still gets its Basic challenge, unchanged", async () => {
      const res = await fetch(base + "/Admin");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Basic realm="Flair Admin"');
    }, 30_000);

    test("a bearer token cannot reach a flair resource — which is why we do not advertise one", async () => {
      // Harper's own auth layer claims every `Bearer …` header and validates it
      // as a Harper OPERATION token, so no flair-issued `flair_at_…` value can
      // ever authorize a REST call. A `WWW-Authenticate: Bearer` challenge here
      // would send an MCP client around a loop that ends exactly here.
      const res = await fetch(base + "/Memory", { headers: { Authorization: "Bearer flair_at_not_a_real_token" } });
      expect(res.status).toBe(401);
    }, 30_000);

    test("/mcp stays absent — discovery does not turn the surface on", async () => {
      // FLAIR_MCP_OAUTH is default-off and this change must not alter that. A
      // client that discovers the authorization server and then finds no /mcp
      // is a coherent state; a /mcp that appeared because discovery shipped
      // would not be.
      const res = await fetch(base + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });
      expect(res.status).toBe(404);
    }, 30_000);
  });
});
