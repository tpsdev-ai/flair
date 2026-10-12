/**
 * host-source-mcp-public-surface-2477.test.ts — flair#2477.
 *
 * The host-source envelope of the MCP `memory_store` tool is covered through the
 * PUBLIC `/mcp` surface, not only through the in-process tool registry:
 *
 *   - `tools/list` advertises `memory_store`'s host-source arguments with their
 *     declared JSON types: `hostSource` an object, `hostSourceScope` the string
 *     enum `[\"record\"]`;
 *   - `tools/call` carrying a valid envelope passes the argument gate
 *     (resources/mcp-handler.ts — checkToolArguments over the declared schema)
 *     and the server stores the pointer in `MemoryHostSource`;
 *   - a non-object `hostSource` is refused by that same gate, so the gate is
 *     exercised on the reject side too.
 *
 * Harness: an ephemeral Harper with MCP OAuth on and a pinned issuer; a signing
 * key we control is seeded into `oauth.harper_oauth_mcp_keys` (the table
 * withMCPAuth verifies against) so tokens are minted here with `jose`. The token
 * subject is linked to an Agent through a `Credential(kind:"idp")` row, the same
 * mapping `resolveMapping` reads. Every call goes to THIS test's loopback
 * instance on its OS-assigned ports, over the real `/mcp` HTTP route.
 *
 * Names are neutral; no fleet host or agent is named.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const ISSUER = "https://mcp-hs-public.flair.internal";
const RESOURCE = `${ISSUER}/mcp`;
const KID = "host-source-public-test-key";
const sfx = Date.now().toString(36);

const AGENT = `hs-public-agent-${sfx}`;
const SUB = `hs-public-sub-${sfx}`;
const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-hspublic1" };

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

async function mintToken(): Promise<string> {
  const key = await importPKCS8(privateKeyPem, "RS256");
  return new SignJWT({ client_id: "host-source-public-client", scope: "openid" })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "at+jwt" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject(SUB)
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

/** The pointer rows for a memory id, read straight out of storage. */
async function pointerRows(memoryId: string): Promise<any[]> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table: "MemoryHostSource",
    search_attribute: "memoryId", search_value: memoryId, get_attributes: ["*"],
  });
  const body = await res.json().catch(() => []);
  return Array.isArray(body) ? body : [];
}

let token: string;

describe("the /mcp public surface carries the memory_store host-source envelope (flair#2477)", () => {
  beforeAll(async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKeyPem = privateKey;
    publicKeyPem = publicKey;

    // startHarper copies process.env into the spawned Harper; restore it
    // immediately so no other file sees the change.
    const envKeys = ["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", "OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET", "OAUTH_GITHUB_REDIRECT_URI"] as const;
    const prior = envKeys.map((key) => [key, process.env[key]] as const);
    process.env.FLAIR_MCP_OAUTH = "true";
    process.env.FLAIR_MCP_ISSUER = ISSUER;
    process.env.OAUTH_GITHUB_CLIENT_ID = "host-source-public-client";
    process.env.OAUTH_GITHUB_CLIENT_SECRET = "host-source-public-secret";
    process.env.OAUTH_GITHUB_REDIRECT_URI = `${ISSUER}/oauth`;
    try {
      harper = await startHarper();
      // Talk only to this test's own ephemeral instance: loopback, the
      // OS-assigned ports it started on, never a shared/production port, and a
      // data directory under the temp dir — checked before the first call.
      const http = new URL(harper.httpURL);
      const ops = new URL(harper.opsURL);
      for (const u of [http, ops]) {
        const port = Number(u.port);
        if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
          throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
        }
      }
      if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
        throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
      }
    } finally {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // Seed the signing key withMCPAuth verifies against.
    const seedKey = await adminOp({
      operation: "insert", database: "oauth", table: "harper_oauth_mcp_keys",
      records: [{ kid: KID, alg: "RS256", public_key_pem: publicKeyPem, private_key_pem: privateKeyPem, created_at: Math.floor(Date.now() / 1000) }],
    });
    expect(seedKey.status, await seedKey.clone().text()).toBe(200);

    // A principal whose subject is the token's `sub`, mapped through the same
    // Credential(kind:"idp") row resolveMapping reads.
    const now = new Date().toISOString();
    const seeded = await adminOp({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: AGENT, name: AGENT, kind: "agent", type: "agent", role: "agent", status: "active", publicKey: `mcp-oauth:${SUB}`, createdAt: now, updatedAt: now }],
    });
    expect(seeded.status, await seeded.clone().text()).toBe(200);
    const mapped = await adminOp({
      operation: "insert", database: "flair", table: "Credential",
      records: [{ id: `cred-${AGENT}`, principalId: AGENT, kind: "idp", label: "host-source public-surface test", status: "active", idpProvider: "host-source-public-idp", idpSubject: SUB, createdAt: now, lastUsedAt: now }],
    });
    expect(mapped.status, await mapped.clone().text()).toBe(200);

    token = await mintToken();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  test("tools/list advertises memory_store's host-source argument types", async () => {
    const list = await mcp(token, "tools/list");
    expect(list.error, JSON.stringify(list.error)).toBeUndefined();
    const tools = list.result?.tools ?? [];
    const store = tools.find((t: any) => t?.name === "memory_store");
    expect(store, "memory_store is advertised on /mcp").toBeDefined();
    expect(store.inputSchema.properties.hostSource.type).toBe("object");
    expect(store.inputSchema.properties.hostSourceScope.type).toBe("string");
    expect(store.inputSchema.properties.hostSourceScope.enum).toEqual(["record"]);
  }, 60_000);

  test("a tools/call with a valid envelope passes the argument gate and stores the pointer", async () => {
    const marker = `hs public surface ${sfx}`;
    const res = await callTool(token, "memory_store", {
      content: marker, hostSource: POINTER, hostSourceScope: "record",
    });
    expect(res.error, JSON.stringify(res.error)).toBeUndefined();
    expect(res.result?.isError, JSON.stringify(res.result)).toBe(false);
    const id = res.result?.structuredContent?.id;
    expect(typeof id, JSON.stringify(res.result).slice(0, 200)).toBe("string");
    const pointers = await pointerRows(id);
    expect(pointers.length, "one pointer row for the stored memory").toBe(1);
    expect(JSON.parse(pointers[0].hostSource), "the stored canonical pointer").toEqual(POINTER);
    expect(pointers[0].scopeAtWrite, "the record-scope opt-in is recorded (non-null)").toBeTruthy();
    expect(pointers[0].authorId, "the pointer is stamped with the resolved agent").toBe(AGENT);
  }, 60_000);

  test("a non-object hostSource is refused by the argument gate", async () => {
    const marker = `hs public surface bad ${sfx}`;
    const res = await callTool(token, "memory_store", { content: marker, hostSource: "not-a-pointer" });
    expect(res.error?.code, JSON.stringify(res.error)).toBe(-32602);
    expect(res.error?.message, JSON.stringify(res.error)).toContain("hostSource");
  }, 60_000);
});
