/**
 * mcp-soul-set-listing-2689.test.ts — flair#2689.
 *
 * The native /mcp surface advertises `soul_set` only to a caller the soul write
 * policy's source-authorization step admits (resources/soul-write-policy.ts;
 * `Soul.post` applies its content guards after that step). The list is the
 * advertised tool definitions. It resolves the caller the way a call does — a
 * token subject mapped to an Agent acts as an agent principal, and a valid
 * token with no mapping reaches the list with no principal — except that
 * listing never JIT-provisions. The delegated tool context carries no operator
 * credentials, so the policy refuses an agent principal. On that surface:
 *
 *   - `tools/list` returns every other curated tool and does not return
 *     `soul_set`, for a non-admin agent and for an admin agent, and returns the
 *     no-principal set for an unmapped subject with JIT provisioning on;
 *   - that unmapped subject's `tools/list` creates no Agent or Credential row.
 *     A `tools/call` by a subject with JIT on is a different path: handleToolCall
 *     resolves with provisioning allowed, so a call can create a principal;
 *   - `tools/call soul_set` still answers 403 `soul_write_requires_operator`
 *     and stores no Soul row.
 *
 * Harness: an ephemeral Harper with MCP OAuth on and a pinned issuer; a signing
 * key this test controls is seeded into the table withMCPAuth verifies against,
 * and tokens are minted here with `jose`. Each token subject is linked to an
 * Agent through a `Credential(kind:"idp")` row — the mapping `resolveMapping`
 * reads. Every request goes to this test's own loopback instance on its
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

const ISSUER = "https://issuer.mcp-soul-listing.example";
const RESOURCE = `${ISSUER}/mcp`;
const KID = "mcp-soul-listing-test-key";
const sfx = Date.now().toString(36);

const AGENT = `mcp-soul-agent-${sfx}`;
const ADMIN_AGENT = `mcp-soul-admin-${sfx}`;
const AGENT_SUB = `mcp-soul-sub-${sfx}`;
const ADMIN_SUB = `mcp-soul-admin-sub-${sfx}`;
const UNMAPPED_SUB = `mcp-soul-unmapped-${sfx}`;
const SEEDED_AGENT = `mcp-soul-seeded-${sfx}`;

/** Every tool name the registry declares. */
const ALL_TOOLS = Object.keys(TOOLS).sort();

let harper: HarperInstance;
let privateKeyPem: string;
let publicKeyPem: string;
let agentToken: string;
let adminToken: string;

function basicHeader(): string {
  return basicAuthOf(harper);
}

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicHeader() },
    body: JSON.stringify(op),
  });
}

async function mintToken(sub: string): Promise<string> {
  const key = await importPKCS8(privateKeyPem, "RS256");
  return new SignJWT({ client_id: "mcp-soul-listing-client", scope: "openid" })
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

async function toolNames(token: string): Promise<string[]> {
  const reply = await mcp(token, "tools/list");
  expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
  return (reply.result?.tools ?? []).map((t: any) => t.name);
}

const callTool = (token: string, name: string, args: Record<string, unknown>) =>
  mcp(token, "tools/call", { name, arguments: args });

/**
 * Rows for one search_by_value query, read straight out of storage. Only an
 * HTTP 2xx with an array body is an answer: a failed read or an unparsable body
 * fails the test, so an empty result is never a fallback for an error.
 */
async function checkedRows(table: string, attribute: string, value: string): Promise<any[]> {
  assertOwnInstance(harper);
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table,
    search_attribute: attribute, search_value: value, get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `${table} read returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${table} read returned a body that is not JSON: ${text.slice(0, 300)}`);
  }
  expect(Array.isArray(body), `${table} read returned a non-array body: ${text.slice(0, 300)}`).toBe(true);
  return body as any[];
}

/** A subject's Soul rows. */
async function soulRows(agentId: string): Promise<any[]> {
  return checkedRows("Soul", "agentId", agentId);
}

describe("the /mcp tool list omits soul_set for an agent principal (flair#2689)", () => {
  beforeAll(async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKeyPem = privateKey;
    publicKeyPem = publicKey;

    harper = await startHarper({
      serverEnv: {
        FLAIR_MCP_OAUTH: "true",
        FLAIR_MCP_ISSUER: ISSUER,
        OAUTH_GITHUB_CLIENT_ID: "mcp-soul-listing-client",
        OAUTH_GITHUB_CLIENT_SECRET: "mcp-soul-listing-secret",
        OAUTH_GITHUB_REDIRECT_URI: `${ISSUER}/oauth`,
        FLAIR_MCP_JIT_PROVISION: "1",
      },
    });
    assertOwnInstance(harper);

    const seedKey = await adminOp({
      operation: "insert", database: "oauth", table: "harper_oauth_mcp_keys",
      records: [{ kid: KID, alg: "RS256", public_key_pem: publicKeyPem, private_key_pem: privateKeyPem, created_at: Math.floor(Date.now() / 1000) }],
    });
    expect(seedKey.status, await seedKey.clone().text()).toBe(200);

    const now = new Date().toISOString();
    for (const [id, role, sub] of [
      [AGENT, "agent", AGENT_SUB],
      [ADMIN_AGENT, "admin", ADMIN_SUB],
    ]) {
      const agent = await adminOp({
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id, name: id, kind: "agent", type: "agent", role, status: "active", publicKey: `mcp-oauth:${sub}`, createdAt: now, updatedAt: now }],
      });
      expect(agent.status, await agent.clone().text()).toBe(200);
      const credential = await adminOp({
        operation: "insert", database: "flair", table: "Credential",
        records: [{ id: `cred-${id}`, principalId: id, kind: "idp", label: "mcp soul listing test", status: "active", idpProvider: "mcp-soul-listing-idp", idpSubject: sub, createdAt: now, lastUsedAt: now }],
      });
      expect(credential.status, await credential.clone().text()).toBe(200);
    }

    agentToken = await mintToken(AGENT_SUB);
    adminToken = await mintToken(ADMIN_SUB);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  test("the storage read used by the no-row checks finds an operator-seeded Soul row", async () => {
    const now = new Date().toISOString();
    const seededAgent = await adminOp({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: SEEDED_AGENT, name: SEEDED_AGENT, kind: "agent", type: "agent", role: "agent", status: "active", publicKey: "mcp-oauth:seeded", createdAt: now, updatedAt: now }],
    });
    expect(seededAgent.status, await seededAgent.clone().text()).toBe(200);

    const written = await fetch(`${harper.httpURL}/Soul/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicHeader() },
      body: JSON.stringify({ id: `soul-${sfx}`, agentId: SEEDED_AGENT, key: "voice", value: "operator-authored", durability: "permanent" }),
    });
    expect(written.status, await written.clone().text()).toBeLessThan(300);

    const rows = await soulRows(SEEDED_AGENT);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe("operator-authored");
  }, 60_000);

  test("an unmapped subject's tools/list is the no-principal set and creates no Agent or Credential row", async () => {
    const token = await mintToken(UNMAPPED_SUB);
    const names = (await toolNames(token)).sort();
    expect(names).toEqual(ALL_TOOLS.filter((name) => name !== "soul_set"));
    expect(await checkedRows("Agent", "publicKey", `mcp-oauth:${UNMAPPED_SUB}`)).toEqual([]);
    expect(await checkedRows("Credential", "idpSubject", UNMAPPED_SUB)).toEqual([]);
  }, 60_000);

  test("a non-admin agent's tools/list has every tool except soul_set", async () => {
    const names = (await toolNames(agentToken)).sort();
    expect(names).not.toContain("soul_set");
    expect(names).toEqual(ALL_TOOLS.filter((name) => name !== "soul_set"));
    expect(ALL_TOOLS).toContain("soul_set");
  }, 60_000);

  test("an admin agent's tools/list has every tool except soul_set", async () => {
    const names = (await toolNames(adminToken)).sort();
    expect(names).not.toContain("soul_set");
    expect(names).toEqual(ALL_TOOLS.filter((name) => name !== "soul_set"));
  }, 60_000);

  test("the agent's soul_set call is still refused with 403 soul_write_requires_operator, and writes nothing", async () => {
    const reply = await callTool(agentToken, "soul_set", { key: "voice", value: `mcp soul listing ${sfx}` });
    expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
    const result = reply.result;
    expect(result?.isError, JSON.stringify(result)).toBe(true);
    expect(result?.structuredContent?.status).toBe(403);
    expect(result?.structuredContent?.error).toContain("soul_write_requires_operator");
    expect(await soulRows(AGENT)).toEqual([]);
  }, 60_000);

  test("the admin agent's soul_set call is refused the same way", async () => {
    const reply = await callTool(adminToken, "soul_set", { key: "voice", value: `mcp soul listing admin ${sfx}` });
    expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
    const result = reply.result;
    expect(result?.isError, JSON.stringify(result)).toBe(true);
    expect(result?.structuredContent?.status).toBe(403);
    expect(result?.structuredContent?.error).toContain("soul_write_requires_operator");
    expect(await soulRows(ADMIN_AGENT)).toEqual([]);
  }, 60_000);
});
