import { TPS_ED25519_ROUTES } from "../helpers/tps-ed25519-routes.ts";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFakeReplayNonceTable, ensureGlobalHarperTransaction } from "../helpers/fake-replay-store.ts";

const keys = generateKeyPairSync("ed25519");
const agent = {
  id: "presence-reader", status: "active", role: "agent",
  publicKey: (keys.publicKey.export({ format: "jwk" }) as any).x,
};
const user = { username: "flair-agent", role: { permission: {} } };
const replayTable = createFakeReplayNonceTable();
let middleware: any;
mock.module("harper", () => ({
  databases: { flair: {
    Agent: { get: async () => agent, search: async function* () { yield agent; } },
    ReplayNonce: replayTable,
  } },
  server: { getUser: async () => user, http: (fn: any) => { middleware = fn; } },
  Resource: class {},
}));
const restoreTransaction = ensureGlobalHarperTransaction();
afterAll(restoreTransaction);
await import("../../resources/auth-middleware.ts");
const { resolveAgentAuth } = await import("../../resources/agent-auth.ts");

function request(signedPath = "/Presence", path = "/Presence", method = "GET"): any {
  const ts = Date.now();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${signedPath}`;
  const signature = sign(null, Buffer.from(payload), keys.privateKey).toString("base64");
  const asObject: Record<string, string> = {
    authorization: `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${signature}`, host: "localhost",
  };
  return {
    method, url: path,
    headers: { asObject, get: (name: string) => asObject[name.toLowerCase()],
      set: (name: string, value: string) => { asObject[name.toLowerCase()] = value; } },
  };
}

function harperAuth(req: any): Response {
  const result = spawnSync("node", [fileURLToPath(new URL("../helpers/harper-authentication.cjs", import.meta.url))], {
    input: JSON.stringify({ method: req.method, url: req.url, headers: req.headers.asObject, user: req.user }), encoding: "utf8", timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return new Response(result.stdout, { status: JSON.parse(result.stdout).status });
}

describe("Presence collection GET before Harper authentication", () => {
  test("Harper rejects an unhandled TPS scheme", () => {
    expect(harperAuth(request()).status).toBe(401);
  });

  test("a valid signature reaches Harper as a verified principal and is consumed once", async () => {
    const req = request();
    const header = req.headers.get("authorization");
    const res = await middleware(req, harperAuth);
    expect(res.status).toBe(200);
    expect(req.headers.get("authorization")).toBe(header);
    expect(req.user).toEqual(user);
    expect(await resolveAgentAuth(req)).toEqual({ kind: "agent", agentId: agent.id, isAdmin: false });
    expect((await middleware(requestWithHeader(header), harperAuth)).status).toBe(401);
  });

  test("a signature over a different path is refused before Harper", async () => {
    let called = false;
    const res = await middleware(request("/Memory"), () => { called = true; return new Response(); });
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  test("a credentialless reader remains anonymous despite ambient local elevation", async () => {
    const req = request();
    delete req.headers.asObject.authorization;
    await middleware(req, () => { req.user = { username: "admin", role: { permission: { super_user: true } } }; return new Response(); });
    expect(await resolveAgentAuth(req)).toEqual({ kind: "anonymous" });
  });
});

function requestWithHeader(header: string): any {
  const req = request();
  req.headers.asObject.authorization = header;
  return req;
}

for (const { method, path } of TPS_ED25519_ROUTES) {
  test(`${method} ${path}: valid TPS passes Harper auth; invalid TPS is refused`, async () => {
    const req = request(path, path, method);
    expect((await middleware(req, harperAuth)).status).toBe(200);
    expect(await resolveAgentAuth(req)).toEqual({ kind: "agent", agentId: agent.id, isAdmin: false });
    let reached = false;
    const refused = await middleware(request(`${path}/wrong`, path, method), () => {
      reached = true;
      return new Response();
    });
    expect(refused.status).toBe(401);
    expect(reached).toBe(false);
    expect((await middleware(requestWithHeaderFor(req), harperAuth)).status).toBe(401);
  }, 30_000);
}

function requestWithHeaderFor(req: any): any {
  const replay = request(req.url, req.url, req.method);
  replay.headers.asObject.authorization = req.headers.get("authorization");
  return replay;
}

for (const status of ["inactive", "revoked"]) {
  test(`a ${status} principal cannot use a public route with TPS`, async () => {
    agent.status = status;
    try {
      const res = await middleware(request("/FederationSync", "/FederationSync", "POST"), harperAuth);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "principal_deactivated" });
    } finally {
      agent.status = "active";
    }
  });
}

for (const header of ["TPS-Ed25519", "TPS-Ed25519 broken"]) {
  test(`malformed ${header} cannot bypass verification on a public route`, async () => {
    const req = request("/Health", "/Health");
    req.headers.asObject.authorization = header;
    let reached = false;
    const res = await middleware(req, () => { reached = true; return new Response(); });
    expect(res.status).toBe(401);
    expect(reached).toBe(false);
  });
}

test("public TPS requests fail closed when the replay store cannot persist", async () => {
  replayTable.fail.put = true;
  try {
    let reached = false;
    const res = await middleware(request("/FederationSync", "/FederationSync", "POST"), () => {
      reached = true;
      return new Response();
    });
    expect(res.status).toBe(503);
    expect(reached).toBe(false);
  } finally {
    delete replayTable.fail.put;
  }
});

test("a preexisting Harper super-user does not bypass TPS verification", async () => {
  const req = request("/wrong", "/Health");
  req.user = { username: "admin", role: { permission: { super_user: true } } };
  let reached = false;
  const res = await middleware(req, () => { reached = true; return new Response(); });
  expect(res.status).toBe(401);
  expect(reached).toBe(false);
});


for (const scheme of ["tps-ed25519", "TpS-eD25519"]) {
  test(`${scheme} authenticates through middleware and the resource parser`, async () => {
    const req = request("/OAuthAuthorize", "/OAuthAuthorize", "POST");
    req.headers.asObject.authorization = req.headers.asObject.authorization.replace("TPS-Ed25519", scheme);
    const res = await middleware(req, () => new Response());
    expect(res.status).toBe(200);
    expect(await resolveAgentAuth(req)).toEqual({ kind: "agent", agentId: agent.id, isAdmin: false });
    const fallback = request();
    fallback.headers.asObject.authorization = fallback.headers.asObject.authorization.replace("TPS-Ed25519", scheme);
    expect(await resolveAgentAuth(fallback)).toEqual({ kind: "agent", agentId: agent.id, isAdmin: false });
    const malformed = request("/Health", "/Health");
    malformed.headers.asObject.authorization = `${scheme} broken`;
    let reached = false;
    const refused = await middleware(malformed, () => { reached = true; return new Response(); });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "invalid_authorization_header" });
    expect(reached).toBe(false);
  });
}
