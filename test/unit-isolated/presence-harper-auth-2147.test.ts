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
let middleware: any;
mock.module("harper", () => ({
  databases: { flair: {
    Agent: { get: async () => agent, search: async function* () { yield agent; } },
    ReplayNonce: createFakeReplayNonceTable(),
  } },
  server: { getUser: async () => user, http: (fn: any) => { middleware = fn; } },
  Resource: class {},
}));
const restoreTransaction = ensureGlobalHarperTransaction();
afterAll(restoreTransaction);
await import("../../resources/auth-middleware.ts");
const { resolveAgentAuth } = await import("../../resources/agent-auth.ts");

function request(signedPath = "/Presence"): any {
  const ts = Date.now();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:GET:${signedPath}`;
  const signature = sign(null, Buffer.from(payload), keys.privateKey).toString("base64");
  const asObject: Record<string, string> = {
    authorization: `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${signature}`, host: "localhost",
  };
  return {
    method: "GET", url: "/Presence",
    headers: { asObject, get: (name: string) => asObject[name.toLowerCase()],
      set: (name: string, value: string) => { asObject[name.toLowerCase()] = value; } },
  };
}

function harperAuth(req: any): Response {
  const result = spawnSync("node", [fileURLToPath(new URL("../helpers/harper-authentication.cjs", import.meta.url))], {
    input: JSON.stringify({ headers: req.headers.asObject, user: req.user }), encoding: "utf8",
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
