/**
 * mcp-tools-list-read-failures-2794.test.ts — flair#2794.
 *
 * The two failed-read branches of the /mcp sub→principal resolution over a real
 * Harper: the `Credential(kind:"idp", idpSubject=sub)` lookup and the mapped
 * principal's `Agent` read. Each is failed once by a test-only hook under
 * FLAIR_ENABLE_TEST_FAULT_INJECTION, for a token subject named by the hook's own
 * setting. The first requests from two tagged subjects mapped to the same
 * principal produce equal errors: a `tools/list` from one answers with the
 * JSON-RPC error a `tools/call` from the other gets, and lists no tools; the
 * next request from a tagged subject is answered normally. A second instance boots with the
 * same settings and the gate off, and neither setting has any effect there.
 *
 * After the failed credential read is answered, a `tools/call` by the same
 * subject writes a memory owned by the principal its `Credential` row maps it
 * to, and a subject with no `Credential` row is refused the same call: recovery
 * is the mapping, not only a list.
 *
 * The two calls that are compared use two subjects: each hook fails once per
 * subject, so the subject that saw the failed tools/list is answered normally
 * afterwards. Both subjects of a case map to the same principal, so a refused
 * principal is named identically in both errors.
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

const ISSUER = "https://issuer.mcp-read-failure.example";
const RESOURCE = `${ISSUER}/mcp`;
const KID = "mcp-read-failure-test-key";
const sfx = Date.now().toString(36);

// What each hook's setting carries: the two subjects of that case contain it.
const CREDENTIAL_READ_TAG = `cred-read-${sfx}`;
const PRINCIPAL_READ_TAG = `principal-read-${sfx}`;

const CREDENTIAL_LIST_SUB = `${CREDENTIAL_READ_TAG}-list`;
const CREDENTIAL_CALL_SUB = `${CREDENTIAL_READ_TAG}-call`;
const PRINCIPAL_LIST_SUB = `${PRINCIPAL_READ_TAG}-list`;
const PRINCIPAL_CALL_SUB = `${PRINCIPAL_READ_TAG}-call`;

const CREDENTIAL_READ_PRINCIPAL = `mcp-rf-cred-${sfx}`;
const PRINCIPAL_READ_PRINCIPAL = `mcp-rf-principal-${sfx}`;
// No Credential row names this subject, so resolution refuses its tool calls.
const UNMAPPED_SUB = `unmapped-${sfx}`;

/** The tools listed for an active non-admin agent: every tool but the gated soul_set. */
const UNGATED_TOOLS = Object.keys(TOOLS).filter((name) => name !== "soul_set").sort();

const MCP_ENV = {
  FLAIR_MCP_OAUTH: "true",
  FLAIR_MCP_ISSUER: ISSUER,
  OAUTH_GITHUB_CLIENT_ID: "mcp-read-failure-client",
  OAUTH_GITHUB_CLIENT_SECRET: "mcp-read-failure-secret",
  OAUTH_GITHUB_REDIRECT_URI: `${ISSUER}/oauth`,
};

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
  return new SignJWT({ client_id: "mcp-read-failure-client", scope: "openid" })
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

/** A `tools/call` of a by-id read: it fails at resolution or attempts one by-id read, and never embeds. */
function callMemoryGet(token: string): Promise<any> {
  return mcp(token, "tools/call", { name: "memory_get", arguments: { id: `mcp-rf-absent-${sfx}` } });
}

/** Boot one instance with the settings under test declared through serverEnv. */
async function boot(serverEnv: Record<string, string | undefined>): Promise<HarperInstance> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = privateKey;

  const instance = await startHarper({ serverEnv: { ...MCP_ENV, ...serverEnv } });
  assertOwnInstance(instance);
  harper = instance;

  await expectOk(await adminOp({
    operation: "insert", database: "oauth", table: "harper_oauth_mcp_keys",
    records: [{ kid: KID, alg: "RS256", public_key_pem: publicKey, private_key_pem: privateKey, created_at: Math.floor(Date.now() / 1000) }],
  }), "seed signing key");

  const now = new Date().toISOString();
  const agent = (id: string) => ({
    id, name: id, kind: "agent", type: "agent", role: "agent", status: "active",
    publicKey: `mcp-oauth:${id}`, createdAt: now, updatedAt: now,
  });
  await expectOk(await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [agent(CREDENTIAL_READ_PRINCIPAL), agent(PRINCIPAL_READ_PRINCIPAL)],
  }), "seed principals");

  const credential = (sub: string, principalId: string) => ({
    id: `cred-${sub}`, principalId, kind: "idp", label: "mcp read-failure test", status: "active",
    idpProvider: "mcp-read-failure-idp", idpSubject: sub, createdAt: now,
  });
  await expectOk(await adminOp({
    operation: "insert", database: "flair", table: "Credential",
    records: [
      credential(CREDENTIAL_LIST_SUB, CREDENTIAL_READ_PRINCIPAL),
      credential(CREDENTIAL_CALL_SUB, CREDENTIAL_READ_PRINCIPAL),
      credential(PRINCIPAL_LIST_SUB, PRINCIPAL_READ_PRINCIPAL),
      credential(PRINCIPAL_CALL_SUB, PRINCIPAL_READ_PRINCIPAL),
    ],
  }), "seed credentials");

  return instance;
}

describe("/mcp tools/list answers a failed resolution read with the tools/call error (flair#2794)", () => {
  beforeAll(async () => {
    harper = await boot({
      FLAIR_ENABLE_TEST_FAULT_INJECTION: "1",
      FLAIR_TEST_MCP_CREDENTIAL_READ_FAIL_SUB: CREDENTIAL_READ_TAG,
      FLAIR_TEST_MCP_PRINCIPAL_READ_FAIL_SUB: PRINCIPAL_READ_TAG,
    });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  test("a failed credential read: tools/list answers the tools/call error, lists no tools, and the next list is normal", async () => {
    const listed = await mcp(await mintToken(CREDENTIAL_LIST_SUB), "tools/list");
    const called = await callMemoryGet(await mintToken(CREDENTIAL_CALL_SUB));
    expect(listed.result, JSON.stringify(listed.result)?.slice(0, 200)).toBeUndefined();
    expect(listed.error?.code, JSON.stringify(listed.error)).toBe(-32000);
    expect(listed.error?.message).toContain("the credential for this token's subject could not be read");
    expect(listed.error).toEqual(called.error);

    const again = await mcp(await mintToken(CREDENTIAL_LIST_SUB), "tools/list");
    expect(again.error, JSON.stringify(again.error)).toBeUndefined();
    expect(again.result.tools.map((t: any) => t.name).sort()).toEqual(UNGATED_TOOLS);

    // Recovery proves the mapping: the same subject's tools/call runs as the
    // principal its Credential row names.
    const token = await mintToken(CREDENTIAL_LIST_SUB);
    const stored = await mcp(token, "tools/call", {
      name: "memory_store",
      arguments: { content: `mcp read-failure recovery ${sfx}` },
    });
    expect(stored.error, JSON.stringify(stored.error)).toBeUndefined();
    const memoryId = stored.result?.structuredContent?.id;
    expect(typeof memoryId, `memory_store echo: ${JSON.stringify(stored.result)?.slice(0, 300)}`).toBe("string");

    const read = await mcp(token, "tools/call", { name: "memory_get", arguments: { id: memoryId } });
    expect(read.error, JSON.stringify(read.error)).toBeUndefined();
    expect(read.result?.structuredContent?.agentId).toBe(CREDENTIAL_READ_PRINCIPAL);

    // The same call by a subject with no Credential row is refused, so the
    // write above is the mapped principal's, not that of any resolved caller.
    const unmapped = await mcp(await mintToken(UNMAPPED_SUB), "tools/call", {
      name: "memory_get",
      arguments: { id: memoryId },
    });
    expect(unmapped.result, JSON.stringify(unmapped.result)?.slice(0, 300)).toBeUndefined();
    expect(unmapped.error?.code, JSON.stringify(unmapped.error)).toBe(-32001);
    expect(unmapped.error?.message).toContain("not a provisioned flair agent");
  }, 30_000);

  test("a failed principal read: tools/list answers the tools/call error, lists no tools, and the next list is normal", async () => {
    const listed = await mcp(await mintToken(PRINCIPAL_LIST_SUB), "tools/list");
    const called = await callMemoryGet(await mintToken(PRINCIPAL_CALL_SUB));
    expect(listed.result, JSON.stringify(listed.result)?.slice(0, 200)).toBeUndefined();
    expect(listed.error?.code, JSON.stringify(listed.error)).toBe(-32000);
    expect(listed.error?.message).toContain(`the status of principal '${PRINCIPAL_READ_PRINCIPAL}' could not be read`);
    expect(listed.error).toEqual(called.error);

    const again = await mcp(await mintToken(PRINCIPAL_LIST_SUB), "tools/list");
    expect(again.error, JSON.stringify(again.error)).toBeUndefined();
    expect(again.result.tools.map((t: any) => t.name).sort()).toEqual(UNGATED_TOOLS);
  }, 30_000);
});

describe("with the fault-injection gate off the read-failure settings have no effect (flair#2794)", () => {
  beforeAll(async () => {
    harper = await boot({
      FLAIR_ENABLE_TEST_FAULT_INJECTION: undefined,
      FLAIR_TEST_MCP_CREDENTIAL_READ_FAIL_SUB: CREDENTIAL_READ_TAG,
      FLAIR_TEST_MCP_PRINCIPAL_READ_FAIL_SUB: PRINCIPAL_READ_TAG,
    });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  for (const [label, sub] of [
    ["the credential-read setting", CREDENTIAL_LIST_SUB],
    ["the principal-read setting", PRINCIPAL_LIST_SUB],
  ]) {
    test(`${label} names the subject, but tools/list lists every tool but soul_set`, async () => {
      const listed = await mcp(await mintToken(sub), "tools/list");
      expect(listed.error, JSON.stringify(listed.error)).toBeUndefined();
      expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual(UNGATED_TOOLS);
    }, 30_000);
  }

  test("a tools/call by a principal-read setting's subject is not refused", async () => {
    const called = await callMemoryGet(await mintToken(PRINCIPAL_CALL_SUB));
    expect(called.error, JSON.stringify(called.error)).toBeUndefined();
    expect(called.result).toBeDefined();
  }, 30_000);
});
