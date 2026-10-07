// An operator's collection DELETE on Integration must remove exactly the
// matched rows (flair#2309), and a runtime principal's collection DELETE must
// stay refused.
//
// Real-Harper integration test. Harper's bulk delete
// (resources/Table.ts:3068, `delete()`'s search branch) consumes the resource's
// own `search()` synchronously:
//
//   for await (const entry of this.search(scanTarget)) { ... }
//
// `Integration.search()` is async, so `this.search(...)` returns a Promise, not
// an async iterable, and the operator's collection DELETE 500s and removes
// nothing. This file pins the fixed behaviour against a real Harper.
//
// MODEL: test/integration/flair-agent-deelevation.test.ts (mkAgent /
// ed25519Header / adminOp helpers, real Harper via startHarper()).
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
const adminAgent = mkAgent("intdel-admin");
const runtimeAgent = mkAgent("intdel-runtime");
const ownerAgent = mkAgent("intdel-owner");

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

function basicAdmin(): string {
  return "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
}

/** Seed one Integration row owned by `ownerAgent` via the real ops API. */
async function seedRow(id: string, platform: string): Promise<void> {
  const res = await adminOp({
    operation: "insert", database: "flair", table: "Integration",
    records: [{
      id, agentId: ownerAgent.id, platform,
      createdAt: new Date().toISOString(),
    }],
  });
  expect(res.status, `seed Integration/${id}`).toBe(200);
}

/** Read back one Integration row as the operator (Basic admin). */
async function readRow(id: string): Promise<any | null> {
  const res = await fetch(`${harper.httpURL}/Integration/${id}`, { headers: { Authorization: basicAdmin() } });
  if (res.status === 404) return null;
  return await res.json();
}

/** Read the collection matched by `platform` as the operator (Basic admin). */
async function readByPlatform(platform: string): Promise<any[]> {
  const res = await fetch(`${harper.httpURL}/Integration/?platform=${encodeURIComponent(platform)}`, {
    headers: { Authorization: basicAdmin() },
  });
  expect(res.status, `GET /Integration/?platform=${platform}`).toBe(200);
  const body: any = await res.json();
  return Array.isArray(body) ? body : (body?.results ?? []);
}

describe("Integration collection DELETE (flair#2309)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    for (const a of [adminAgent, runtimeAgent, ownerAgent]) {
      const res = await adminOp({
        operation: "insert", database: "flair", table: "Agent",
        records: [{
          id: a.id, name: a.id,
          role: a === adminAgent ? "admin" : "agent",
          publicKey: a.publicKey, createdAt: new Date().toISOString(),
        }],
      });
      expect(res.status, `seed Agent/${a.id}`).toBe(200);
    }
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("OPERATOR: collection DELETE removes every matched row and leaves an unmatched control row", async () => {
    await seedRow("intdel-op-a", "slack-op");
    await seedRow("intdel-op-b", "slack-op");
    await seedRow("intdel-op-c", "slack-op");
    await seedRow("intdel-op-control", "discord-op");

    const del = await fetch(`${harper.httpURL}/Integration/?platform=slack-op`, {
      method: "DELETE",
      headers: { Authorization: basicAdmin() },
    });
    expect(
      [200, 204],
      `operator collection DELETE returned ${del.status}: ${(await del.text()).slice(0, 300)}`,
    ).toContain(del.status);

    const matched = await readByPlatform("slack-op");
    expect(matched.map((r) => r.id).sort()).toEqual([]);

    const control = await readRow("intdel-op-control");
    expect(control).not.toBeNull();
    expect(control.id).toBe("intdel-op-control");
  }, 60_000);

  test("RUNTIME PRINCIPAL: collection DELETE is refused and deletes nothing", async () => {
    await seedRow("intdel-rt-a", "slack-rt");
    await seedRow("intdel-rt-b", "slack-rt");

    const path = "/Integration/?platform=slack-rt";
    const del = await fetch(`${harper.httpURL}${path}`, {
      method: "DELETE",
      headers: { Authorization: ed25519Header(runtimeAgent, "DELETE", path) },
    });
    expect(
      [401, 403],
      `runtime collection DELETE returned ${del.status}: ${(await del.text()).slice(0, 300)}`,
    ).toContain(del.status);

    const still = await readByPlatform("slack-rt");
    expect(still.map((r) => r.id).sort()).toEqual(["intdel-rt-a", "intdel-rt-b"]);
  }, 60_000);
});
