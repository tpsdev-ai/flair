// http-method-allowlist-e2e.test.ts: on real Harper, the default REST
// middleware refuses any HTTP method outside GET, HEAD, OPTIONS, POST, PUT,
// PATCH and DELETE with 405 before a table handler runs, for a signed agent
// and an anonymous caller alike, while an allowed method behaves as before.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

let harper: HarperInstance;
const agent = mkAgent("method-allowlist-agent");

describe("HTTP method allowlist on real Harper", () => {
  beforeAll(async () => {
    harper = await startHarper();
    const res = await fetch(harper.opsURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
      },
      body: JSON.stringify({
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
      }),
    });
    expect(res.status).toBe(200);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  for (const path of ["/Memory/", "/Relationship/", "/Credential/"]) {
    test(`a signed agent's PROPFIND ${path} gets 405 with an Allow header`, async () => {
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "PROPFIND",
        headers: { Authorization: ed25519Header(agent, "PROPFIND", path) },
      });
      const text = await res.text();
      expect(res.status, `PROPFIND ${path} returned ${res.status}: ${text.slice(0, 200)}`).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE");
      expect(JSON.parse(text).error).toBe("method_not_allowed");
    }, 30_000);
  }

  test("an anonymous PROPFIND on a public path gets 405", async () => {
    const res = await fetch(`${harper.httpURL}/health`, { method: "PROPFIND" });
    expect(res.status).toBe(405);
  }, 30_000);

  test("the same agent's GET /Memory/ is handled as before (200)", async () => {
    const path = "/Memory/";
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(agent, "GET", path) },
    });
    expect(res.status).toBe(200);
  }, 30_000);
});
