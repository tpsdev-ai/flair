/**
 * memory-supersede-authority-2307.test.ts — flair#2307 item 4, real Harper.
 *
 * A Memory write that carries `supersedes` must enforce the cross-agent write
 * grant against the record the reference RESOLVES to — the way Harper resolves a
 * by-id path (decode, then drop a trailing declared-attribute selector) — not
 * against the literal reference string. Otherwise a suffix or encoding on the
 * reference names a record the caller is not allowed to supersede.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

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
function assertOwnInstance(harper: HarperInstance): void {
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
}
async function authSend(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `seed agent returned ${res.status}`).toBe(200);
}
async function insertRow(harper: HarperInstance, id: string, agentId: string, content: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Memory",
    records: [{ id, agentId, content, contentHash: id, visibility: "shared", archived: false, instanceToken: randomUUID(), createdAt: "2026-01-01T00:00:00.000Z" }],
  });
  expect(res.status, `raw insert of ${id} returned ${res.status}`).toBe(200);
}

let harper: HarperInstance;
const owner = mkAgent("msw-owner");
const attacker = mkAgent("msw-attacker");

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  await seedAgent(harper, owner);
  await seedAgent(harper, attacker);
  for (const id of ["msw-victim", "msw-victim-b", "msw-victim-c"]) {
    await insertRow(harper, id, owner.id, "VICTIM BODY");
  }
}, 240_000);

afterAll(async () => { if (harper) await stopHarper(harper); });

describe("flair#2307 item 4 — supersede authority is enforced against the resolved record", () => {
  it("a plain cross-agent supersede without a grant is refused (control)", async () => {
    const res = await authSend(harper, attacker, "PUT", "/Memory/msw-new-plain", {
      id: "msw-new-plain", agentId: attacker.id, content: "plain successor long enough for the gate", supersedes: "msw-victim",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("cannot supersede");
  }, 30_000);

  it("a declared-attribute suffix on the reference does not evade the grant check", async () => {
    const res = await authSend(harper, attacker, "PUT", "/Memory/msw-new-suffix", {
      id: "msw-new-suffix", agentId: attacker.id, content: "suffix successor long enough for the gate", supersedes: "msw-victim-b.agentId",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("cannot supersede");
  }, 30_000);

  it("an encoded reference does not evade the grant check either", async () => {
    const res = await authSend(harper, attacker, "PUT", "/Memory/msw-new-encoded", {
      id: "msw-new-encoded", agentId: attacker.id, content: "encoded successor long enough for the gate", supersedes: "msw-victim-c%2EagentId",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("cannot supersede");
  }, 30_000);
});
