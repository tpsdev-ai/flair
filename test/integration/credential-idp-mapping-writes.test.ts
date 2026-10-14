// credential-idp-mapping-writes.test.ts — REAL Harper.
//
// An IdP identity mapping is a `Credential` row of kind "idp": the /mcp
// resolver (resources/mcp-handler.ts) and the XAA jwt-bearer grant
// (resources/XAA.ts) resolve a subject to the principal that row names. An
// administrator and trusted server code write such rows: the /mcp and XAA JIT
// provisioners in-process, and `flair mcp enable` / `flair principal link`
// through the operations API. Through the Credential resource, on POST, PUT and
// PATCH, a verified non-admin agent cannot:
//
//   - create a kind:"idp" row;
//   - change a row's kind to or from "idp";
//   - change idpSubject, idpProvider or principalId on an idp row it owns;
//   - change an idp row's status to anything but "revoked", so it cannot
//     reactivate one.
//
// It writes and deletes only credentials it owns, and may relabel, revoke and
// delete its own idp row.
//
// What the refusal cases assert:
//   - the status: 403 naming `idp_mapping_admin_only` for the IdP rule's
//     refusals; 403 for the owner refusals, with the owner refusal's message
//     in the principalId case (the owner-field guard, which runs before the
//     IdP rule) and the not-owned PUT cases; any 4xx for the
//     other-route and malformed-body cases; the DELETE-by-query case asserts
//     no status, only that the row is unchanged;
//   - that a named refusal does not echo a subject the request carried;
//   - for a refused write to a stored row, that the whole stored row is the
//     same right after the refusal as before it; for a refused create, that no
//     row was stored;
//   - /mcp resolution: a token for a subject the refused write would newly map
//     does not resolve, and a linked row the write targeted still resolves to
//     its owner (or, when revoked, to nobody);
//   - XAA resolution, in the POST and idpProvider cases only.
//
// Still allowed: a non-admin agent creating its own webauthn, bearer-token and
// ed25519 credentials; relabelling or revoking its own idp row; an admin agent
// creating and editing idp rows over REST; the operations-API linker; and the
// in-process XAA JIT provisioner.
//
// The last describe runs `flair doctor`'s IdP mapping check
// (src/lib/idp-mapping-audit.ts) against this instance's real audit log, and
// against that log cut where retention would cut it, then runs the review and
// re-stamp commands doctor prints for the unattributed rows.
//
// Mutation check: remove the post(), put() or patch() guard in
// resources/Credential.ts, or its stored-owner check — the cases for that
// path go red.
//
// Agents resolve to the least-privilege `flair-agent` Harper user (provisioned
// in beforeAll), the production posture, whose role grants Credential full CRUD
// — so every refusal here is flair's own rule, not Harper's table permissions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { SignJWT, exportJWK, generateKeyPair, importPKCS8 } from "jose";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { provisionIdpIdentityMapping } from "../../src/lib/mcp-enable";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { describeIdpMappingWriters, idpMappingRemedyCommands, readCredentialAudit, readIdpMappingRows, type CredentialAuditEntry } from "../../src/lib/idp-mapping-audit";

const FORBIDDEN_PORTS = new Set([9925, 9926]);
const MCP_ISSUER = "https://idp-mapping-writes.flair.internal";
const MCP_RESOURCE = `${MCP_ISSUER}/mcp`;
const MCP_KID = "idp-mapping-writes-key";
const XAA_ISSUER = "https://idp.idp-mapping-writes.invalid";
const XAA_IDP_ID = "idp-mapping-writes-xaa";
const REFUSAL = "idp_mapping_admin_only";
const sfx = Date.now().toString(36);

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

// W: the non-admin writer. V: another non-admin principal. ADM: an admin agent.
const W = mkAgent(`idpw-writer-${sfx}`);
const V = mkAgent(`idpw-other-${sfx}`);
const ADM = mkAgent(`idpw-admin-${sfx}`);

let harper: HarperInstance;
let mcpPrivateKeyPem: string;
let xaaSigningKey: any;
let xaaKid: string;
let jwksServer: Server;

function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || FORBIDDEN_PORTS.has(port)) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} on ${op.table}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function signed(agent: TestAgent, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${harper.httpURL}${path}`, {
    method,
    headers: {
      Authorization: ed25519Header(agent, method, path),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: await res.text() };
}

async function readCredential(id: string): Promise<any> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "Credential",
    search_attribute: "id", search_type: "equals", search_value: id, get_attributes: ["*"],
  });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function credentialsForSubject(sub: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "Credential",
    search_attribute: "idpSubject", search_type: "equals", search_value: sub, get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows : [];
}

/** The whole stored row, to compare before and after a refused write. */
async function snapshot(id: string): Promise<Record<string, unknown>> {
  const row = await readCredential(id);
  expect(row, `no stored row ${id}`).not.toBeNull();
  return row;
}

/** The stored row is exactly as it was before the refused write. */
async function expectUnchanged(id: string, before: Record<string, unknown>): Promise<void> {
  expect(await readCredential(id), `row ${id} changed`).toEqual(before);
}

/** Seed a credential row through the operations API (an operator's write). */
async function seedCredential(row: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  await ops({ operation: "insert", database: "flair", table: "Credential", records: [{ status: "active", createdAt: now, ...row }] });
}

/** Link `sub` to `principal` with the function `flair mcp enable` / `flair principal link` use. */
async function link(principal: string, sub: string, idpProvider = "idpw-test"): Promise<string> {
  const opsPort = Number(new URL(harper.opsURL).port);
  await provisionIdpIdentityMapping({
    opsPortOrUrl: opsPort,
    adminUser: harper.admin.username,
    adminPass: harper.admin.password,
    principal,
    principalKind: "agent",
    idpProvider,
    idpSubject: sub,
  });
  const rows = (await credentialsForSubject(sub)).filter((r) => r.kind === "idp" && r.status === "active");
  expect(rows.length, `exactly one active mapping for ${sub} after linking`).toBe(1);
  return String(rows[0].id);
}

function expectRefused(res: { status: number; text: string }, what: string, sub?: string): void {
  expect(res.status, `${what} returned ${res.status}: ${res.text.slice(0, 300)}`).toBe(403);
  expect(res.text, `${what}: the refusal names the rule`).toContain(REFUSAL);
  if (sub) expect(res.text.includes(sub), `${what}: the refusal must not echo the subject`).toBe(false);
}

function expect4xx(res: { status: number; text: string }, what: string): void {
  expect(res.status >= 400 && res.status < 500, `${what} returned ${res.status}: ${res.text.slice(0, 300)}`).toBe(true);
}

// ── /mcp: which principal does a token for `sub` resolve to? ─────────────────

async function mintMcpToken(sub: string): Promise<string> {
  const key = await importPKCS8(mcpPrivateKeyPem, "RS256");
  return new SignJWT({ client_id: "idp-mapping-writes-client", scope: "openid" })
    .setProtectedHeader({ alg: "RS256", kid: MCP_KID, typ: "at+jwt" })
    .setIssuer(MCP_ISSUER)
    .setAudience(MCP_RESOURCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

/** The agentId a memory_store through /mcp lands under, or null when the call is refused. */
async function mcpActsAs(sub: string): Promise<string | null> {
  const marker = `idpw-mcp-${sub}-${randomUUID()}`;
  const res = await fetch(`${harper.httpURL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await mintMcpToken(sub)}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: marker, visibility: "private" } } }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `/mcp returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  const body = JSON.parse(text);
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "content", search_value: marker, get_attributes: ["id", "agentId"],
  });
  if (body.error) {
    expect(Array.isArray(rows) ? rows.length : 0, "a refused tools/call stores nothing").toBe(0);
    return null;
  }
  expect(Array.isArray(rows) && rows.length === 1, `memory_store stored one row: ${text.slice(0, 300)}`).toBe(true);
  return String(rows[0].agentId);
}

// ── XAA: which principal does a jwt-bearer grant for `sub` issue tokens to? ──

async function xaaGrantPrincipal(sub: string): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: "memory:read" })
    .setProtectedHeader({ alg: "ES256", kid: xaaKid })
    .setIssuer(XAA_ISSUER)
    .setSubject(sub)
    .setAudience(harper.httpURL)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(xaaSigningKey);
  const res = await fetch(`${harper.httpURL}/OAuthToken`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.status !== 200) return null;
  const accessToken = JSON.parse(text).access_token;
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "OAuthToken",
    search_attribute: "tokenHash", search_type: "equals",
    search_value: createHash("sha256").update(accessToken).digest("hex"), get_attributes: ["principalId"],
  });
  return Array.isArray(rows) && rows[0] ? String(rows[0].principalId) : null;
}

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  mcpPrivateKeyPem = privateKey;

  // startHarper copies process.env into the spawned Harper; restore it at once.
  const envKeys = ["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", "FLAIR_MCP_JIT_PROVISION", "OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET", "OAUTH_GITHUB_REDIRECT_URI"] as const;
  const prior = envKeys.map((key) => [key, process.env[key]] as const);
  process.env.FLAIR_MCP_OAUTH = "true";
  process.env.FLAIR_MCP_ISSUER = MCP_ISSUER;
  process.env.OAUTH_GITHUB_CLIENT_ID = "idp-mapping-writes-client";
  process.env.OAUTH_GITHUB_CLIENT_SECRET = "idp-mapping-writes-secret";
  process.env.OAUTH_GITHUB_REDIRECT_URI = `${MCP_ISSUER}/oauth`;
  delete process.env.FLAIR_MCP_JIT_PROVISION;
  try {
    harper = await startHarper();
  } finally {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assertOwnInstance(harper);

  await ops({
    operation: "insert", database: "oauth", table: "harper_oauth_mcp_keys",
    records: [{ kid: MCP_KID, alg: "RS256", public_key_pem: publicKey, private_key_pem: privateKey, created_at: Math.floor(Date.now() / 1000) }],
  });

  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);

  const now = new Date().toISOString();
  await ops({
    operation: "insert", database: "flair", table: "Agent",
    records: [
      { id: W.id, name: W.id, kind: "agent", type: "agent", role: "agent", status: "active", publicKey: W.publicKey, createdAt: now, updatedAt: now },
      { id: V.id, name: V.id, kind: "agent", type: "agent", role: "agent", status: "active", publicKey: V.publicKey, createdAt: now, updatedAt: now },
      { id: ADM.id, name: ADM.id, kind: "agent", type: "agent", role: "admin", admin: true, status: "active", publicKey: ADM.publicKey, createdAt: now, updatedAt: now },
    ],
  });

  // A test XAA IdP: a loopback JWKS server and an IdpConfig with JIT on (the default).
  const kp = await generateKeyPair("ES256");
  xaaSigningKey = kp.privateKey;
  xaaKid = `k-${randomUUID()}`;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: xaaKid, alg: "ES256", use: "sig" };
  const jwksBody = JSON.stringify({ keys: [jwk] });
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(jwksBody);
  });
  await new Promise<void>((resolve, reject) => {
    jwksServer.once("error", reject);
    jwksServer.listen(0, "127.0.0.1", () => resolve());
  });
  jwksServer.unref();
  const addr = jwksServer.address();
  if (addr === null || typeof addr === "string" || addr.address !== "127.0.0.1" || FORBIDDEN_PORTS.has(addr.port)) {
    throw new Error(`JWKS server bound ${JSON.stringify(addr)}, not an ephemeral loopback port`);
  }
  await ops({
    operation: "insert", database: "flair", table: "IdpConfig",
    records: [{
      id: XAA_IDP_ID, name: "idp-mapping-writes", issuer: XAA_ISSUER,
      jwksUri: `http://127.0.0.1:${addr.port}/jwks`, clientId: "idp-mapping-writes-xaa-client",
      jitProvision: true, defaultTrustTier: "unverified", enabled: true, createdAt: now,
    }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (jwksServer) jwksServer.close();
}, 60_000);

describe("only an administrator or the server creates an IdP mapping", () => {
  test("a non-admin POST that creates an idp mapping is refused (idp_mapping_admin_only)", async () => {
    const sub = `idpw-post-${sfx}`;
    const res = await signed(W, "POST", "/Credential", { kind: "idp", idpProvider: "mcp-oauth", idpSubject: sub, label: "x" });
    expectRefused(res, "POST kind:idp", sub);
    expect(await credentialsForSubject(sub)).toEqual([]);
    expect(await mcpActsAs(sub)).toBeNull();

    const xaaSub = `idpw-post-xaa-${sfx}`;
    const xres = await signed(W, "POST", "/Credential", { kind: "idp", idpProvider: XAA_IDP_ID, idpSubject: xaaSub });
    expectRefused(xres, "POST kind:idp (XAA provider)", xaaSub);
    expect(await credentialsForSubject(xaaSub)).toEqual([]);
    // No mapping: the grant JIT-provisions a fresh principal (the in-process writer), never the writer.
    const principal = await xaaGrantPrincipal(xaaSub);
    expect(principal).not.toBeNull();
    expect(principal).not.toBe(W.id);
    const jit = (await credentialsForSubject(xaaSub)).filter((r) => r.kind === "idp");
    expect(jit.length, "the XAA JIT provisioner wrote its own mapping").toBe(1);
    expect(jit[0].principalId).toBe(principal);
  }, 90_000);

  test("a non-admin PUT that creates an idp mapping is refused (idp_mapping_admin_only)", async () => {
    const sub = `idpw-putnew-${sfx}`;
    const id = `idpw-putnew-${randomUUID()}`;
    expectRefused(await signed(W, "PUT", `/Credential/${id}`, { id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: sub }), "PUT new kind:idp", sub);
    expect(await readCredential(id)).toBeNull();
    expect(await mcpActsAs(sub)).toBeNull();
  }, 60_000);

  test("a non-admin multi-record PUT that creates an idp mapping is refused (idp_mapping_admin_only)", async () => {
    const sub = `idpw-bulk-${sfx}`;
    const id = `idpw-bulk-${randomUUID()}`;
    const res = await signed(W, "PUT", "/Credential/", [{ id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: sub }]);
    expectRefused(res, "multi-record PUT kind:idp", sub);
    expect(await readCredential(id)).toBeNull();
    expect(await mcpActsAs(sub)).toBeNull();
  }, 60_000);
  test("a non-admin PUT or POST of an idp mapping on another route stores nothing", async () => {
    const sub = `idpw-collput-${sfx}`;
    const id = `idpw-collput-${randomUUID()}`;
    const put = await signed(W, "PUT", "/Credential/", { id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: sub });
    expect4xx(put, "collection PUT (object)");
    const post = await signed(W, "POST", `/Credential/${id}`, { id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: sub });
    expect4xx(post, "record-path POST");
    expect(await credentialsForSubject(sub)).toEqual([]);
    expect(await mcpActsAs(sub)).toBeNull();
  }, 60_000);
});

describe("a non-admin write that changes a credential's kind to idp is refused", () => {
  test("a non-admin PUT that changes kind to idp is refused (idp_mapping_admin_only)", async () => {
    const id = `idpw-own-bearer-put-${randomUUID()}`;
    await seedCredential({ id, principalId: W.id, kind: "bearer-token", label: "mine" });
    const sub = `idpw-kindput-${sfx}`;
    const before = await snapshot(id);
    expectRefused(await signed(W, "PUT", `/Credential/${id}`, { id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: sub }), "PUT kind→idp", sub);
    await expectUnchanged(id, before);
    expect(await mcpActsAs(sub)).toBeNull();
  }, 60_000);

  test("a non-admin PATCH that changes kind to idp is refused (idp_mapping_admin_only)", async () => {
    const id = `idpw-own-bearer-patch-${randomUUID()}`;
    await seedCredential({ id, principalId: W.id, kind: "bearer-token", label: "mine" });
    const sub = `idpw-kindpatch-${sfx}`;
    const before = await snapshot(id);
    expectRefused(await signed(W, "PATCH", `/Credential/${id}`, { kind: "idp", idpProvider: "mcp-oauth", idpSubject: sub }), "PATCH kind→idp", sub);
    await expectUnchanged(id, before);
    expect(await mcpActsAs(sub)).toBeNull();
  }, 60_000);
  test("a non-admin PATCH that changes only the kind to idp is refused (idp_mapping_admin_only)", async () => {
    const sub = `idpw-kindonly-${sfx}`;
    const created = await signed(W, "POST", "/Credential", { kind: "bearer-token", idpProvider: "mcp-oauth", idpSubject: sub });
    expect([200, 201], `POST bearer-token returned ${created.status}: ${created.text.slice(0, 300)}`).toContain(created.status);
    const [row] = await credentialsForSubject(sub);
    expect(row?.kind).toBe("bearer-token");
    expect(await mcpActsAs(sub)).toBeNull();
    const before = await snapshot(row.id);
    expectRefused(await signed(W, "PATCH", `/Credential/${row.id}`, { kind: "idp" }), "PATCH kind-only →idp", sub);
    await expectUnchanged(row.id, before);
    expect(await mcpActsAs(sub)).toBeNull();
  }, 60_000);

  test("a non-admin PATCH with a malformed body naming idp stores no mapping", async () => {
    const id = `idpw-own-bearer-arr-${randomUUID()}`;
    await seedCredential({ id, principalId: W.id, kind: "bearer-token", label: "mine" });
    const sub = `idpw-kindarr-${sfx}`;
    const before = await snapshot(id);
    const arr = await signed(W, "PATCH", `/Credential/${id}`, { kind: ["idp"], idpProvider: "mcp-oauth", idpSubject: sub });
    expect4xx(arr, "PATCH kind:[idp]");
    const coll = await signed(W, "PATCH", "/Credential/", [{ id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: sub }]);
    expect4xx(coll, "collection PATCH (array)");
    await expectUnchanged(id, before);
    expect(await mcpActsAs(sub)).toBeNull();
  }, 60_000);
});

describe("a non-admin write that changes an idp mapping is refused", () => {
  test("a non-admin PATCH that changes idpSubject is refused (idp_mapping_admin_only)", async () => {
    const linked = `idpw-linked-subj-${sfx}`;
    const id = await link(W.id, linked);
    const moved = `idpw-moved-subj-${sfx}`;
    const before = await snapshot(id);
    expectRefused(await signed(W, "PATCH", `/Credential/${id}`, { idpSubject: moved }), "PATCH idpSubject", moved);
    await expectUnchanged(id, before);
    expect(await mcpActsAs(moved)).toBeNull();
    expect(await mcpActsAs(linked)).toBe(W.id); // the operator's mapping keeps working
  }, 60_000);

  test("a non-admin PUT that changes idpSubject is refused (idp_mapping_admin_only)", async () => {
    const linked = `idpw-linked-putsubj-${sfx}`;
    const id = await link(W.id, linked);
    const before = await readCredential(id);
    const moved = `idpw-moved-putsubj-${sfx}`;
    expectRefused(await signed(W, "PUT", `/Credential/${id}`, { ...before, idpSubject: moved }), "PUT idpSubject", moved);
    await expectUnchanged(id, before);
    expect(await mcpActsAs(moved)).toBeNull();
    expect(await mcpActsAs(linked)).toBe(W.id);
  }, 60_000);

  test("a non-admin PATCH that changes idpProvider is refused (idp_mapping_admin_only)", async () => {
    const linked = `idpw-linked-prov-${sfx}`;
    const id = await link(W.id, linked);
    const before = await snapshot(id);
    expectRefused(await signed(W, "PATCH", `/Credential/${id}`, { idpProvider: XAA_IDP_ID }), "PATCH idpProvider");
    await expectUnchanged(id, before);
    // /mcp first: the XAA grant below JIT-provisions its own mapping for this subject.
    expect(await mcpActsAs(linked)).toBe(W.id);
    expect(await xaaGrantPrincipal(linked)).not.toBe(W.id);
  }, 60_000);

  test("a non-admin PATCH that changes kind away from idp is refused (idp_mapping_admin_only)", async () => {
    const linked = `idpw-linked-kind-${sfx}`;
    const id = await link(W.id, linked);
    const before = await snapshot(id);
    expectRefused(await signed(W, "PATCH", `/Credential/${id}`, { kind: "bearer-token" }), "PATCH kind idp→bearer-token");
    await expectUnchanged(id, before);
    expect(await mcpActsAs(linked)).toBe(W.id);
  }, 60_000);

  test("a non-admin PATCH that sets a revoked idp row active is refused (idp_mapping_admin_only)", async () => {
    const linked = `idpw-linked-revoked-${sfx}`;
    const id = await link(W.id, linked);
    await ops({ operation: "update", database: "flair", table: "Credential", records: [{ id, status: "revoked", updatedAt: new Date().toISOString() }] });
    expect(await mcpActsAs(linked)).toBeNull();
    const before = await snapshot(id);
    expectRefused(await signed(W, "PATCH", `/Credential/${id}`, { status: "active" }), "PATCH status revoked→active", linked);
    await expectUnchanged(id, before);
    expect(await mcpActsAs(linked)).toBeNull();
  }, 60_000);

  test("a non-admin PATCH that changes principalId is refused by the owner-field guard", async () => {
    const linked = `idpw-linked-owner-${sfx}`;
    const id = await link(W.id, linked);
    const before = await snapshot(id);
    const res = await signed(W, "PATCH", `/Credential/${id}`, { principalId: V.id });
    expect(res.status, `PATCH principalId returned ${res.status}: ${res.text.slice(0, 300)}`).toBe(403);
    // The owner-field guard runs before the IdP rule, so this is its refusal, not idp_mapping_admin_only.
    expect(res.text).toContain("the owner of a record cannot be changed");
    await expectUnchanged(id, before);
    expect(await mcpActsAs(linked)).toBe(W.id);
  }, 60_000);
});

describe("a non-admin agent writes and deletes only credentials it owns", () => {
  test("a non-admin PUT to an idp credential it does not own is refused", async () => {
    const linked = `idpw-other-bulk-${sfx}`;
    const id = await link(V.id, linked);
    const before = await readCredential(id);
    // The element names no principalId.
    const res = await signed(W, "PUT", "/Credential/", [{ id, kind: "idp", idpProvider: before.idpProvider, idpSubject: linked, status: "active" }]);
    expect(res.status, `PUT returned ${res.status}: ${res.text.slice(0, 300)}`).toBe(403);
    expect(res.text).toContain("owned by another principal");
    await expectUnchanged(id, before);
    expect(await mcpActsAs(linked)).toBe(V.id);
  }, 60_000);

  test("a non-admin PUT to a bearer-token credential it does not own is refused", async () => {
    const id = `idpw-other-bearer-${randomUUID()}`;
    await seedCredential({ id, principalId: V.id, kind: "bearer-token", label: "theirs" });
    const before = await snapshot(id);
    const res = await signed(W, "PUT", "/Credential/", [{ id, kind: "bearer-token", label: "mine now" }]);
    expect(res.status, `PUT returned ${res.status}: ${res.text.slice(0, 300)}`).toBe(403);
    expect(res.text).toContain("owned by another principal");
    await expectUnchanged(id, before);
  }, 60_000);

  test("a non-admin DELETE of an idp credential it does not own is refused", async () => {
    const linked = `idpw-other-del-${sfx}`;
    const id = await link(V.id, linked);
    const before = await snapshot(id);
    const res = await signed(W, "DELETE", `/Credential/${id}`);
    expect(res.status, `DELETE returned ${res.status}: ${res.text.slice(0, 300)}`).toBe(403);
    await expectUnchanged(id, before);
    expect(await mcpActsAs(linked)).toBe(V.id);
  }, 60_000);
  test("a non-admin DELETE by query leaves idp credentials it does not own in place", async () => {
    const linked = `idpw-other-qdel-${sfx}`;
    const id = await link(V.id, linked);
    const before = await snapshot(id);
    const res = await signed(W, "DELETE", `/Credential/?idpSubject=${linked}`);
    expect(await readCredential(id), `row after a collection DELETE (${res.status}: ${res.text.slice(0, 200)})`).toEqual(before);
    expect(await mcpActsAs(linked)).toBe(V.id);
  }, 60_000);
});

describe("legitimate writers are unchanged", () => {
  test("a non-admin agent still creates its own webauthn, bearer-token and ed25519 credentials", async () => {
    for (const kind of ["webauthn", "bearer-token", "ed25519"]) {
      const res = await signed(W, "POST", "/Credential", { kind, label: `own ${kind}` });
      expect([200, 201, 204], `POST ${kind} returned ${res.status}: ${res.text.slice(0, 300)}`).toContain(res.status);
      const id = `idpw-own-${kind}-${randomUUID()}`;
      const put = await signed(W, "PUT", `/Credential/${id}`, { id, kind, label: `own ${kind}` });
      expect([200, 201, 204], `PUT ${kind} returned ${put.status}: ${put.text.slice(0, 300)}`).toContain(put.status);
      expect((await readCredential(id)).principalId).toBe(W.id);
    }
  }, 60_000);

  test("a non-admin agent relabels and then revokes its own idp row", async () => {
    const linked = `idpw-linked-self-${sfx}`;
    const id = await link(W.id, linked);
    const relabel = await signed(W, "PATCH", `/Credential/${id}`, { label: "my laptop" });
    expect([200, 204], `PATCH label returned ${relabel.status}: ${relabel.text.slice(0, 300)}`).toContain(relabel.status);
    expect((await readCredential(id)).label).toBe("my laptop");
    const revoke = await signed(W, "PATCH", `/Credential/${id}`, { status: "revoked" });
    expect([200, 204], `PATCH status revoked returned ${revoke.status}: ${revoke.text.slice(0, 300)}`).toContain(revoke.status);
    expect((await readCredential(id)).status).toBe("revoked");
    expect(await mcpActsAs(linked)).toBeNull();
  }, 60_000);

  test("an admin agent creates an idp row for another principal over REST and edits its subject", async () => {
    const sub = `idpw-admin-${sfx}`;
    const id = `idpw-admin-${randomUUID()}`;
    const put = await signed(ADM, "PUT", `/Credential/${id}`, { id, principalId: W.id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: sub });
    expect([200, 201, 204], `admin PUT returned ${put.status}: ${put.text.slice(0, 300)}`).toContain(put.status);
    expect(await mcpActsAs(sub)).toBe(W.id);
    const sub2 = `idpw-admin2-${sfx}`;
    const patch = await signed(ADM, "PATCH", `/Credential/${id}`, { idpSubject: sub2 });
    expect([200, 204], `admin PATCH returned ${patch.status}: ${patch.text.slice(0, 300)}`).toContain(patch.status);
    expect(await mcpActsAs(sub2)).toBe(W.id);
    const sub3 = `idpw-admin3-${sfx}`;
    const post = await signed(ADM, "POST", "/Credential", { principalId: V.id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: sub3 });
    expect([200, 201, 204], `admin POST returned ${post.status}: ${post.text.slice(0, 300)}`).toContain(post.status);
    expect(await mcpActsAs(sub3)).toBe(V.id);
  }, 60_000);

  test("the operations-API linker maps a subject, and the XAA JIT provisioner maps an unknown one", async () => {
    const linked = `idpw-linker-${sfx}`;
    await link(V.id, linked);
    expect(await mcpActsAs(linked)).toBe(V.id);
    const xaaSub = `idpw-jit-${sfx}`;
    const first = await xaaGrantPrincipal(xaaSub);
    expect(first).not.toBeNull();
    expect(await xaaGrantPrincipal(xaaSub)).toBe(first); // the JIT row resolves on the next grant
  }, 60_000);
});

// ── flair doctor: IdP mapping rows and who wrote them ─────────────────────────
//
// src/lib/idp-mapping-audit.ts reads every idp row and its Harper audit entries.
// For the active rows, it lists those whose retained history shows a mapping
// write by the shared non-admin agent user, and reports as unattributed those
// whose history does not show their creation. The rows to be listed are written
// here as the `flair-agent` Harper user through the operations API (with a
// password this test sets on its own ephemeral instance), which is the user the
// audit log records for a non-admin agent's write.

/** The `flair-agent` Harper user, with a password set on this test's own instance. */
async function asAgentUser(): Promise<(op: Record<string, unknown>) => Promise<void>> {
  const agentPass = `idpw-${randomUUID()}`;
  await ops({ operation: "alter_user", username: "flair-agent", password: agentPass, active: true, role: "flair_agent" });
  return async (op) => {
    const res = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`flair-agent:${agentPass}`) },
      body: JSON.stringify(op),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect(res.status, `${op.operation} as flair-agent: ${text.slice(0, 300)}`).toBe(200);
  };
}

const byTimestamp = (a: CredentialAuditEntry, b: CredentialAuditEntry) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0);

/** Run a remedy command doctor prints, with this instance's admin password wherever curl would prompt for it. */
function runPrinted(command: string): string {
  const user = harper.admin.username;
  expect(command.startsWith(`curl -su ${user} `)).toBe(true);
  for (const step of command.split(" && ")) expect(step).toContain(` ${harper.opsURL.replace(/\/?$/, "/")} `);
  const res = spawnSync("bash", ["-c", command.replaceAll(`curl -su ${user} `, `curl -su ${user}:${harper.admin.password} `)], { encoding: "utf-8", timeout: 20_000 });
  expect(res.status, `printed command failed: ${res.stderr}`).toBe(0);
  return res.stdout;
}

describe("flair doctor: IdP mapping rows and who wrote them (from the audit log)", () => {
  test("lists the rows written as the shared non-admin agent user; the linker, admin REST and JIT rows are attributed", async () => {
    const asAgent = await asAgentUser();
    const now = new Date().toISOString();
    // (1) a mapping created by the non-admin agent user.
    const created = `idpw-doctor-created-${randomUUID()}`;
    await asAgent({ operation: "insert", database: "flair", table: "Credential", records: [{ id: created, principalId: W.id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: `idpw-doctor-a-${sfx}`, status: "active", createdAt: now }] });
    // (2) an operator's mapping whose subject a write as the non-admin agent user changed.
    const repointed = await link(W.id, `idpw-doctor-b-${sfx}`);
    await asAgent({ operation: "update", database: "flair", table: "Credential", records: [{ id: repointed, idpSubject: `idpw-doctor-b2-${sfx}` }] });
    // (3) controls written now, each attributed by its creation stamp: the
    //     linker, an admin agent over REST, the XAA JIT, and a linked row its
    //     owner relabelled; and an operator's insert its owner relabelled.
    const linked = await link(V.id, `idpw-doctor-c-${sfx}`);
    const adminRow = `idpw-doctor-admin-${randomUUID()}`;
    const adminPut = await signed(ADM, "PUT", `/Credential/${adminRow}`, { id: adminRow, principalId: V.id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: `idpw-doctor-d-${sfx}` });
    expect([200, 204]).toContain(adminPut.status);
    const jitSub = `idpw-doctor-e-${sfx}`;
    expect(await xaaGrantPrincipal(jitSub)).not.toBeNull();
    expect(await xaaGrantPrincipal(jitSub)).not.toBeNull(); // a second grant: the server's use stamp
    const [jitRow] = (await credentialsForSubject(jitSub)).filter((r) => r.kind === "idp");
    const selfRow = await link(W.id, `idpw-doctor-f-${sfx}`);
    expect([200, 204]).toContain((await signed(W, "PATCH", `/Credential/${selfRow}`, { label: "mine" })).status);
    const insertedRow = `idpw-doctor-inserted-${randomUUID()}`;
    await seedCredential({ id: insertedRow, principalId: W.id, kind: "idp", idpProvider: "idpw-test", idpSubject: `idpw-doctor-i-${sfx}` });
    expect([200, 204]).toContain((await signed(W, "PATCH", `/Credential/${insertedRow}`, { label: "mine" })).status);
    // (4) a mapping the non-admin agent user created that an operator revoked:
    //     it maps nobody and is not checked.
    const revokedRow = `idpw-doctor-revoked-${randomUUID()}`;
    await asAgent({ operation: "insert", database: "flair", table: "Credential", records: [{ id: revokedRow, principalId: W.id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: `idpw-doctor-j-${sfx}`, status: "active", createdAt: now }] });
    await ops({ operation: "update", database: "flair", table: "Credential", records: [{ id: revokedRow, status: "revoked" }] });
    // (5) a row whose recorded write carries an older creation time, as a row
    //     copied in from elsewhere does: its history does not show its creation.
    const copiedRow = `idpw-doctor-copied-${randomUUID()}`;
    await ops({ operation: "upsert", database: "flair", table: "Credential", records: [{ id: copiedRow, principalId: V.id, kind: "idp", idpProvider: "mcp-oauth", idpSubject: `idpw-doctor-k-${sfx}`, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }] });

    const authHeader = "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
    const rows = await readIdpMappingRows({ opsUrl: harper.opsURL, authHeader });
    expect(rows).not.toBeNull();
    const ids = rows!.map((r) => r.id);
    for (const id of [created, repointed, linked, adminRow, jitRow?.id, selfRow, insertedRow, revokedRow, copiedRow]) expect(ids).toContain(id);
    const audit = await readCredentialAudit({ opsUrl: harper.opsURL, authHeader, ids });
    expect(audit.kind).toBe("ok");
    if (audit.kind !== "ok") return;
    const finding = describeIdpMappingWriters(rows!, audit.byId);
    expect(finding.nonAdmin.map((m) => m.id).sort()).toEqual([created, repointed].sort());
    expect(finding.nonAdmin.find((m) => m.id === created)).toEqual({ id: created, principalId: W.id, idpProvider: "mcp-oauth" });
    // Every other active row in this instance, written by the linker, an admin
    // agent, the XAA JIT or an operator's insert, is attributed.
    expect(finding.unattributed).toEqual([copiedRow]);
    expect(finding.active).toBeLessThan(finding.total);
  }, 90_000);

  test("expired history: an owner's relabel or update that is the first retained entry is unattributed; the printed review returns those rows and the printed re-stamp attributes them", async () => {
    // Harper's retention removes a time prefix of the audit log. A test cannot
    // make Harper expire entries on demand, so this case reads the entries
    // Harper returned for each row and keeps those from the owner's write
    // onward: what retention leaves once the row's creation has expired.
    const relabelled = `idpw-doctor-exp-patch-${randomUUID()}`;
    const updated = `idpw-doctor-exp-put-${randomUUID()}`;
    const subs: Record<string, string> = { [relabelled]: `idpw-doctor-g-${sfx}`, [updated]: `idpw-doctor-h-${sfx}` };
    for (const id of [relabelled, updated]) {
      await seedCredential({ id, principalId: W.id, kind: "idp", idpProvider: "idpw-test", idpSubject: subs[id] });
    }
    const relabel = await signed(W, "PATCH", `/Credential/${relabelled}`, { label: "mine" });
    expect([200, 204], `PATCH label returned ${relabel.status}: ${relabel.text.slice(0, 300)}`).toContain(relabel.status);
    const before = await readCredential(updated);
    const put = await signed(W, "PUT", `/Credential/${updated}`, { ...before, label: "mine" });
    expect([200, 201, 204], `PUT returned ${put.status}: ${put.text.slice(0, 300)}`).toContain(put.status);

    const authHeader = "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
    const readRows = async () => (await readIdpMappingRows({ opsUrl: harper.opsURL, authHeader }))!.filter((r) => r.id === relabelled || r.id === updated);
    const readAudit = async () => {
      const audit = await readCredentialAudit({ opsUrl: harper.opsURL, authHeader, ids: [relabelled, updated] });
      expect(audit.kind).toBe("ok");
      return audit.kind === "ok" ? audit.byId : {};
    };
    /** The entries from the owner's write onward, which is what retention leaves. */
    const cut = (byId: Record<string, CredentialAuditEntry[]>) => {
      const retained: Record<string, CredentialAuditEntry[]> = {};
      for (const id of [relabelled, updated]) {
        const entries = [...byId[id]].sort(byTimestamp);
        const first = entries.findIndex((e) => e.user_name === "flair-agent");
        expect(first, `${id}: no entry by flair-agent after the operator's insert`).toBeGreaterThan(0);
        retained[id] = entries.slice(first);
      }
      return retained;
    };
    const rows = await readRows();
    expect(rows.length).toBe(2);
    const byId = await readAudit();

    // The whole history shows each row's creation and no non-admin mapping write.
    const whole = describeIdpMappingWriters(rows, byId);
    expect(whole.nonAdmin).toEqual([]);
    expect(whole.unattributed).toEqual([]);

    const retained = cut(byId);
    for (const id of [relabelled, updated]) {
      // Harper returns the whole row for that entry, so it names every identity field.
      const image = (retained[id][0].records as any[])[0];
      expect(image).toMatchObject({ id, kind: "idp", principalId: W.id, idpProvider: "idpw-test", idpSubject: subs[id], status: "active", label: "mine" });
    }
    expect(retained[relabelled][0].operation).toBe("patch");
    expect(retained[updated][0].operation).toBe("upsert");
    const expired = describeIdpMappingWriters(rows, retained);
    expect(expired.nonAdmin).toEqual([]);
    expect(expired.unattributed.sort()).toEqual([relabelled, updated].sort());

    // The remedy doctor prints: the review returns these two rows and no
    // other, and the re-stamp is two administrator updates of createdAt.
    const commands = idpMappingRemedyCommands(expired.unattributed, { opsUrl: harper.opsURL.replace(/\/?$/, "/"), adminUser: harper.admin.username });
    expect(commands).not.toBeNull();
    const reviewed = JSON.parse(runPrinted(commands!.review));
    expect(reviewed.map((r: any) => r.id).sort()).toEqual([relabelled, updated].sort());
    expect(runPrinted(commands!.restamp).split("updated 2 of 2").length - 1).toBe(2);
    const after = cut(await readAudit());
    for (const id of [relabelled, updated]) {
      const [prior, last] = after[id].slice(-2);
      expect(prior).toMatchObject({ operation: "update", user_name: harper.admin.username });
      expect((prior.records as any[])[0].createdAt).toBe("1970-01-01T00:00:00Z");
      expect(last).toMatchObject({ operation: "update", user_name: harper.admin.username });
      expect((last.records as any[])[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
    const restamped = describeIdpMappingWriters(await readRows(), after);
    expect(restamped.nonAdmin).toEqual([]);
    expect(restamped.unattributed).toEqual([]);
  }, 60_000);
});
