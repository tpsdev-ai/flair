// mcp-principal-status.test.ts — the native /mcp path checks the mapped
// principal's status on every tool call, the same rule the Ed25519 path applies.
//
// A token's subject resolves to a principal through Credential(kind:"idp"). That
// principal must exist and be active each time a tool is called — not only when
// the token was minted. Deactivating a principal therefore refuses the tokens it
// already holds, on every tool, with an error that names the principal and the
// operator's remedy; reactivating it restores access; other principals are
// unaffected.
//
// Harness: an ephemeral Harper with MCP OAuth on and a pinned issuer. A signing
// key we control is seeded into oauth.harper_oauth_mcp_keys (the table
// withMCPAuth verifies against), so tokens are minted here with `jose`
// (the pattern of mcp-audience-binding-igmt.test.ts). Subjects are linked to
// principals with provisionIdpIdentityMapping, the function `flair mcp enable`
// uses, and a principal is deactivated with the same Agent update
// `flair principal disable` sends.
//
// The case where the principal's status cannot be read is covered in
// test/unit/mcp-handler.test.ts, where the read can be made to fail.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { SignJWT, importPKCS8 } from "jose";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { provisionIdpIdentityMapping } from "../../src/lib/mcp-enable";

const ISSUER = "https://mcp-status-test.flair.internal";
const RESOURCE = `${ISSUER}/mcp`;
const KID = "principal-status-test-key";
const sfx = Date.now().toString(36);

// C: the principal that is deactivated and reactivated. It also holds an
// Ed25519 key, so the REST path can be checked against the same record.
const C = { id: `mcpstatus-c-${sfx}`, sub: `idp-sub-c-${sfx}` };
// D: stays active throughout.
const D = { id: `mcpstatus-d-${sfx}`, sub: `idp-sub-d-${sfx}` };
// L: a principal record with no `status` field (it predates the field).
const L = { id: `mcpstatus-l-${sfx}`, sub: `idp-sub-l-${sfx}` };

let harper: HarperInstance;
let privateKeyPem: string;
const cKeys = nacl.sign.keyPair();

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

async function expectOk(res: Response, what: string): Promise<void> {
  const text = await res.text();
  expect(res.status, `${what} returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
}

async function mintToken(sub: string): Promise<string> {
  const key = await importPKCS8(privateKeyPem, "RS256");
  return new SignJWT({ client_id: "principal-status-client", scope: "openid" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

let rpcId = 0;
async function mcp(token: string, method: string, params?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${harper.httpURL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  expect(res.status, `/mcp ${method} returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

const callTool = (token: string, name: string, args: Record<string, unknown>) =>
  mcp(token, "tools/call", { name, arguments: args });

async function setStatus(id: string, status: string): Promise<void> {
  // The update `flair principal disable` sends (src/commands/principal.ts).
  await expectOk(await adminOp({
    operation: "update", database: "flair", table: "Agent",
    records: [{ id, status, updatedAt: new Date().toISOString() }],
  }), `set ${id} status ${status}`);
}

async function memoriesWithContent(content: string): Promise<any[]> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "content", search_value: content, get_attributes: ["id", "agentId"],
  });
  const body = await res.json().catch(() => []);
  return Array.isArray(body) ? body : [];
}

function ed25519Get(path: string): Promise<Response> {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${C.id}:${ts}:${nonce}:GET:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), cKeys.secretKey);
  return fetch(`${harper.httpURL}${path}`, {
    headers: { Authorization: `TPS-Ed25519 ${C.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}` },
  });
}

/** Minimal arguments that pass each tool's argument check. */
function argsFor(name: string, marker: string): Record<string, unknown> {
  switch (name) {
    case "memory_search": return { query: marker };
    case "memory_store": return { content: marker };
    case "memory_get":
    case "memory_delete":
    case "memory_basement":
    case "memory_restore":
    case "skill_get": return { id: `${marker}-id` };
    case "memory_update": return { id: `${marker}-id`, content: marker };
    case "record_usage": return { memoryId: `${marker}-id` };
    case "soul_get": return { key: "role" };
    case "soul_set": return { key: "role", value: marker };
    case "flair_workspace_set": return { ref: marker };
    case "flair_orgevent": return { kind: "note", summary: marker };
    case "skill_store": return { content: marker };
    case "skill_search": return { task: marker };
    case "attention": return { entity: marker };
    default: return {};
  }
}

let cToken: string;
let dToken: string;
let lToken: string;
let cMemoryId: string;
let toolNames: string[];

describe("native MCP checks the principal's status on every tool call", () => {
  beforeAll(async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKeyPem = privateKey;

    // "true" so flair's route and the oauth component both enable (flair#1152).
    // startHarper copies process.env into the spawned Harper; restore it
    // immediately so no other file sees the change.
    const prior = { oauth: process.env.FLAIR_MCP_OAUTH, issuer: process.env.FLAIR_MCP_ISSUER, jit: process.env.FLAIR_MCP_JIT_PROVISION };
    process.env.FLAIR_MCP_OAUTH = "true";
    process.env.FLAIR_MCP_ISSUER = ISSUER;
    delete process.env.FLAIR_MCP_JIT_PROVISION;
    try {
      harper = await startHarper();
    } finally {
      for (const [k, v] of [["FLAIR_MCP_OAUTH", prior.oauth], ["FLAIR_MCP_ISSUER", prior.issuer], ["FLAIR_MCP_JIT_PROVISION", prior.jit]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    await expectOk(await adminOp({
      operation: "insert", database: "oauth", table: "harper_oauth_mcp_keys",
      records: [{ kid: KID, alg: "RS256", public_key_pem: publicKey, private_key_pem: privateKey, created_at: Math.floor(Date.now() / 1000) }],
    }), "seed signing key");

    const now = new Date().toISOString();
    await expectOk(await adminOp({
      operation: "insert", database: "flair", table: "Agent",
      records: [
        { id: C.id, name: C.id, kind: "agent", type: "agent", role: "agent", status: "active", publicKey: Buffer.from(cKeys.publicKey).toString("base64"), createdAt: now, updatedAt: now },
        // D and L authenticate only with MCP tokens: a placeholder key, the form
        // the MCP provisioning path writes.
        { id: D.id, name: D.id, kind: "agent", type: "agent", role: "agent", status: "active", publicKey: `mcp-oauth:${D.sub}`, createdAt: now, updatedAt: now },
        { id: L.id, name: L.id, kind: "agent", type: "agent", role: "agent", publicKey: `mcp-oauth:${L.sub}`, createdAt: now, updatedAt: now },
      ],
    }), "seed principals");

    // provisionIdpIdentityMapping reads a STRING target as a served origin and
    // swaps in the hosted ops port; only a numeric port addresses this
    // ephemeral instance's own ops API.
    const opsPort = Number(new URL(harper.opsURL).port);
    expect(opsPort > 0 && harper.opsURL === `http://127.0.0.1:${opsPort}`, `ephemeral ops API ${harper.opsURL}`).toBe(true);
    for (const p of [C, D, L]) {
      await provisionIdpIdentityMapping({
        opsPortOrUrl: opsPort,
        adminUser: harper.admin.username,
        adminPass: harper.admin.password,
        principal: p.id,
        principalKind: "agent",
        idpProvider: "status-test-idp",
        idpSubject: p.sub,
      });
    }

    // Every token is minted now, while every principal is active.
    cToken = await mintToken(C.sub);
    dToken = await mintToken(D.sub);
    lToken = await mintToken(L.sub);

    const list = await mcp(cToken, "tools/list");
    toolNames = list.result.tools.map((t: any) => t.name);
    expect(toolNames.length, "tools/list returned the curated tools").toBeGreaterThan(10);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  test("an active principal's token calls tools", async () => {
    const marker = `mcpstatus C own ${sfx}`;
    const stored = await callTool(cToken, "memory_store", { content: marker, visibility: "private" });
    expect(stored.error, JSON.stringify(stored.error)).toBeUndefined();
    expect(stored.result.isError, JSON.stringify(stored.result)).toBe(false);
    const rows = await memoriesWithContent(marker);
    expect(rows.map((r) => r.agentId)).toEqual([C.id]);
    cMemoryId = rows[0].id;

    const found = await callTool(cToken, "memory_search", { query: marker });
    expect(found.error, JSON.stringify(found.error)).toBeUndefined();
    expect(found.result.isError).toBe(false);

    const rest = await ed25519Get(`/Memory/${cMemoryId}`);
    await rest.arrayBuffer();
    expect(rest.status, "the Ed25519 path serves the same active principal").toBe(200);
  }, 60_000);

  test("a principal record with no status field is served", async () => {
    const res = await callTool(lToken, "memory_search", { query: "anything" });
    expect(res.error, JSON.stringify(res.error)).toBeUndefined();
    expect(res.result.isError).toBe(false);
  }, 30_000);

  test("after the principal is deactivated, its already-minted token is refused on every tool, with the principal named and the remedy stated", async () => {
    await setStatus(C.id, "deactivated");
    const marker = `mcpstatus C after deactivation ${sfx}`;
    for (const name of toolNames) {
      const res = await callTool(cToken, name, argsFor(name, marker));
      expect(res.result, `${name}: must not run for a deactivated principal (${JSON.stringify(res.result)?.slice(0, 200)})`).toBeUndefined();
      expect(res.error?.code, `${name}: ${JSON.stringify(res.error)}`).toBe(-32001);
      expect(res.error?.message, name).toContain(`principal '${C.id}' is deactivated`);
      expect(res.error?.message, name).toContain(`set its status to "active"`);
    }
    expect(await memoriesWithContent(marker), "memory_store must not have written").toEqual([]);
  }, 120_000);

  test("the Ed25519 path refuses the same deactivated principal", async () => {
    const res = await ed25519Get(`/Memory/${cMemoryId}`);
    const body = await res.text();
    expect(res.status).toBe(401);
    expect(body).toContain("principal_deactivated");
  }, 30_000);

  test("a token minted after deactivation is refused too", async () => {
    const fresh = await mintToken(C.sub);
    const res = await callTool(fresh, "memory_search", { query: "anything" });
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32001);
    expect(res.error?.message).toContain(`principal '${C.id}' is deactivated`);
  }, 30_000);

  test("another principal that is still active is unaffected", async () => {
    const res = await callTool(dToken, "memory_search", { query: "anything" });
    expect(res.error, JSON.stringify(res.error)).toBeUndefined();
    expect(res.result.isError).toBe(false);
  }, 30_000);

  test("reactivating the principal restores its token", async () => {
    await setStatus(C.id, "active");
    const res = await callTool(cToken, "memory_search", { query: `mcpstatus C own ${sfx}` });
    expect(res.error, JSON.stringify(res.error)).toBeUndefined();
    expect(res.result.isError).toBe(false);
  }, 30_000);

  test("a credential that maps to a principal that does not exist is refused", async () => {
    const ghost = { id: `mcpstatus-ghost-${sfx}`, sub: `idp-sub-ghost-${sfx}` };
    const now = new Date().toISOString();
    await expectOk(await adminOp({
      operation: "insert", database: "flair", table: "Credential",
      records: [{ id: `cred-${ghost.id}`, principalId: ghost.id, kind: "idp", label: "status test", status: "active", idpProvider: "status-test-idp", idpSubject: ghost.sub, createdAt: now, lastUsedAt: now }],
    }), "seed dangling credential");
    const res = await callTool(await mintToken(ghost.sub), "memory_search", { query: "anything" });
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32001);
    expect(res.error?.message).toContain(`principal '${ghost.id}', which does not exist`);
  }, 30_000);
});
