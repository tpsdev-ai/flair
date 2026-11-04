/**
 * mcp-tools-list-resolution-2760.test.ts — flair#2760.
 *
 * On the native /mcp route, a `tools/list` by a token whose subject's mapping
 * is refused answers with the JSON-RPC error a `tools/call` by the same token
 * gets, and no tool list. The refusals covered over the real route: a
 * deactivated principal, a credential naming a principal that does not exist,
 * and a subject whose only credential is revoked. An unmapped subject still
 * gets the no-principal tool list and no row is written for it, with JIT
 * provisioning on; an active agent still gets its list.
 *
 * A failed credential or principal read is covered in
 * test/unit/mcp-handler.test.ts; this harness does not inject read failures.
 *
 * Harness: an ephemeral Harper with MCP OAuth on and a pinned issuer; a signing
 * key this test controls is seeded into the table withMCPAuth verifies against,
 * and tokens are minted here with `jose`. Subjects are linked to principals by
 * `Credential(kind:"idp")` rows inserted through this instance's operations
 * API. Every request goes to this test's own loopback instance on its
 * OS-assigned ports.
 *
 * Names are neutral; no fleet host or agent is named.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { assertOwnInstance, basicAuthOf } from "../helpers/own-harper-instance";
import { TOOLS } from "../../resources/mcp-tools";

const ISSUER = "https://issuer.mcp-list-resolution.example";
const RESOURCE = `${ISSUER}/mcp`;
const KID = "mcp-list-resolution-test-key";
const sfx = Date.now().toString(36);

const ACTIVE = { id: `mcp-list-active-${sfx}`, sub: `mcp-list-active-sub-${sfx}` };
const DEACTIVATED = { id: `mcp-list-deactivated-${sfx}`, sub: `mcp-list-deactivated-sub-${sfx}` };
const MISSING = { id: `mcp-list-missing-${sfx}`, sub: `mcp-list-missing-sub-${sfx}` };
const REVOKED = { id: `mcp-list-revoked-${sfx}`, sub: `mcp-list-revoked-sub-${sfx}` };
const UNMAPPED_SUB = `mcp-list-unmapped-sub-${sfx}`;

/** The tools listed for a caller with no principal: every tool but the gated soul_set. */
const UNGATED_TOOLS = Object.keys(TOOLS).filter((name) => name !== "soul_set").sort();

let harper: HarperInstance;
let privateKeyPem: string;

async function adminOp(op: Record<string, any>): Promise<Response> {
  assertOwnInstance(harper);
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuthOf(harper) },
    body: JSON.stringify(op),
  });
}

async function expectOk(res: Response, what: string): Promise<void> {
  const text = await res.text();
  expect(res.status, `${what} returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
}

async function mintToken(sub: string): Promise<string> {
  const key = await importPKCS8(privateKeyPem, "RS256");
  return new SignJWT({ client_id: "mcp-list-resolution-client", scope: "openid" })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "at+jwt" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

let rpcId = 0;
async function mcp(token: string, method: string, params?: Record<string, unknown>): Promise<any> {
  assertOwnInstance(harper);
  const res = await fetch(`${harper.httpURL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  expect(res.status, `/mcp ${method} returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

/**
 * Rows for one search_by_value query. Only an HTTP 200 with an array body is
 * an answer, so an empty result is never a fallback for a failed read.
 */
async function checkedRows(table: string, attribute: string, value: string): Promise<any[]> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table,
    search_attribute: attribute, search_value: value, get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `${table} read returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  const body = JSON.parse(text);
  expect(Array.isArray(body), `${table} read returned a non-array body: ${text.slice(0, 300)}`).toBe(true);
  return body;
}

describe("/mcp tools/list answers a refused mapping with the tools/call error (flair#2760)", () => {
  beforeAll(async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKeyPem = privateKey;

    harper = await startHarper({
      serverEnv: {
        FLAIR_MCP_OAUTH: "true",
        FLAIR_MCP_ISSUER: ISSUER,
        OAUTH_GITHUB_CLIENT_ID: "mcp-list-resolution-client",
        OAUTH_GITHUB_CLIENT_SECRET: "mcp-list-resolution-secret",
        OAUTH_GITHUB_REDIRECT_URI: `${ISSUER}/oauth`,
        FLAIR_MCP_JIT_PROVISION: "1",
      },
    });
    assertOwnInstance(harper);

    await expectOk(await adminOp({
      operation: "insert", database: "oauth", table: "harper_oauth_mcp_keys",
      records: [{ kid: KID, alg: "RS256", public_key_pem: publicKey, private_key_pem: privateKey, created_at: Math.floor(Date.now() / 1000) }],
    }), "seed signing key");

    const now = new Date().toISOString();
    const agent = (p: { id: string; sub: string }, status: string) => ({
      id: p.id, name: p.id, kind: "agent", type: "agent", role: "agent", status,
      publicKey: `mcp-oauth:${p.sub}`, createdAt: now, updatedAt: now,
    });
    await expectOk(await adminOp({
      operation: "insert", database: "flair", table: "Agent",
      records: [agent(ACTIVE, "active"), agent(DEACTIVATED, "deactivated"), agent(REVOKED, "active")],
    }), "seed principals");

    const credential = (p: { id: string; sub: string }, status: string) => ({
      id: `cred-${p.id}`, principalId: p.id, kind: "idp", label: "mcp list resolution test", status,
      idpProvider: "mcp-list-resolution-idp", idpSubject: p.sub, createdAt: now,
    });
    await expectOk(await adminOp({
      operation: "insert", database: "flair", table: "Credential",
      records: [
        credential(ACTIVE, "active"),
        credential(DEACTIVATED, "active"),
        credential(MISSING, "active"),
        credential(REVOKED, "revoked"),
      ],
    }), "seed credentials");
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  const refusals: [string, { id: string; sub: string }, string][] = [
    ["a deactivated principal", DEACTIVATED, `principal '${DEACTIVATED.id}' is deactivated`],
    ["a credential naming a principal that does not exist", MISSING, `principal '${MISSING.id}', which does not exist`],
    ["a subject whose only credential is revoked", REVOKED, `cred-${REVOKED.id}`],
  ];
  for (const [label, p, text] of refusals) {
    test(`${label}: tools/list answers the tools/call error and no tool list`, async () => {
      const token = await mintToken(p.sub);
      const listed = await mcp(token, "tools/list");
      const called = await mcp(token, "tools/call", { name: "memory_search", arguments: { query: "anything" } });
      expect(listed.result, JSON.stringify(listed.result)?.slice(0, 200)).toBeUndefined();
      expect(listed.error?.code, JSON.stringify(listed.error)).toBe(-32001);
      expect(listed.error?.message).toContain(text);
      expect(listed.error).toEqual(called.error);
    }, 30_000);
  }

  test("an unmapped subject's tools/list is the no-principal set and writes no row, with JIT provisioning on", async () => {
    const listed = await mcp(await mintToken(UNMAPPED_SUB), "tools/list");
    expect(listed.error, JSON.stringify(listed.error)).toBeUndefined();
    expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual(UNGATED_TOOLS);
    expect(await checkedRows("Credential", "idpSubject", UNMAPPED_SUB)).toEqual([]);
    expect(await checkedRows("Agent", "publicKey", `mcp-oauth:${UNMAPPED_SUB}`)).toEqual([]);
  }, 30_000);

  test("an active agent's tools/list has every tool except soul_set", async () => {
    const listed = await mcp(await mintToken(ACTIVE.sub), "tools/list");
    expect(listed.error, JSON.stringify(listed.error)).toBeUndefined();
    expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual(UNGATED_TOOLS);
  }, 30_000);
});
