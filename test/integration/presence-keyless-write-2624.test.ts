/**
 * presence-keyless-write-2624.test.ts — flair#2624.
 *
 * An authenticated administrator's keyless PUT/PATCH gets 400
 * presence_target_required; a non-admin agent's collection PUT/PATCH gets the
 * owner guard's named 403; an anonymous request gets 401. A normal
 * self-addressed PUT/PATCH still stores.
 *
 * Real Harper, real spawn, real Ed25519 signatures (mirrors
 * test/integration/presence-api.test.ts's harness conventions). Build
 * prerequisite: dist/resources/*.js (`bun run build`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HARPER_STOP_BUDGET_MS, type HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("hex"), secretKey: kp.secretKey };
}

/** `Authorization: TPS-Ed25519 <id>:<ts>:<nonce>:<sig>` over `<id>:<ts>:<nonce>:<METHOD>:<path>`. */
function ed25519Header(a: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${a.id}:${ts}:${nonce}:${method}:${path}`), a.secretKey);
  return `TPS-Ed25519 ${a.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

const sfx = Date.now().toString(36);
const AGENT = mkAgent(`keyless-agent-a-${sfx}`);

let harper: HarperInstance;

/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must avoid ports 9925/9926`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const adminBasic = () => "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminBasic() },
    body: JSON.stringify({ database: "flair", ...operation }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function seedAgent(a: TestAgent): Promise<void> {
  await ops({
    operation: "insert",
    table: "Agent",
    records: [{
      id: a.id, name: a.id, displayName: a.id, role: "agent", publicKey: a.publicKey,
      status: "active", kind: "agent", createdAt: new Date().toISOString(),
    }],
  });
}

/** Row count of the whole Presence table, read through the ops API. */
async function presenceCount(): Promise<number> {
  const rows = await ops({ operation: "sql", sql: "SELECT agentId FROM flair.Presence" });
  expect(Array.isArray(rows)).toBe(true);
  return rows.length;
}

async function readPresenceRow(id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_id", table: "Presence", ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

describe("Presence keyless write refusal (flair#2624)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);
    await seedAgent(AGENT);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, HARPER_STOP_BUDGET_MS);

  // A non-admin agent's keyless collection PUT/PATCH is intercepted BEFORE the
  // resource by the install-wide owner-scoped write guard
  // (resources/owner-scoped-write-policy.ts), which answers its own named 403.
  // The presence_target_required refusal in put()/patch() is the administrator's
  // branch; an anonymous request gets 401 from the auth check ahead of both.
  test("keyless PUT from a verified agent → owner guard's 403, no row", async () => {
    const before = await presenceCount();
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: ed25519Header(AGENT, "PUT", "/Presence") },
      body: JSON.stringify({ currentTask: "keyless put must be refused", activity: "coding" }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect(res.status, `keyless agent PUT: ${text.slice(0, 200)}`).toBe(403);
    expect(JSON.parse(text).error).toBe("forbidden: a non-admin write to Presence must address one record by its id");
    expect(await presenceCount()).toBe(before);
  }, 30_000);

  test("keyless PATCH from a verified agent → owner guard's 403, no row", async () => {
    const before = await presenceCount();
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: ed25519Header(AGENT, "PATCH", "/Presence") },
      body: JSON.stringify({ currentTask: "keyless patch must be refused" }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect(res.status, `keyless agent PATCH: ${text.slice(0, 200)}`).toBe(403);
    expect(JSON.parse(text).error).toBe("forbidden: a non-admin write to Presence must address one record by its id");
    expect(await presenceCount()).toBe(before);
  }, 30_000);

  test("keyless PUT from the Basic administrator → 400 presence_target_required, no row", async () => {
    const before = await presenceCount();
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: adminBasic() },
      body: JSON.stringify({ currentTask: "admin keyless put must be refused", activity: "coding" }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect(res.status, `keyless admin PUT: ${text.slice(0, 200)}`).toBe(400);
    expect(JSON.parse(text).error).toBe("presence_target_required");
    expect(await presenceCount()).toBe(before);
  }, 30_000);

  test("keyless PATCH from the Basic administrator → 400 presence_target_required, no row", async () => {
    const before = await presenceCount();
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: adminBasic() },
      body: JSON.stringify({ currentTask: "admin keyless patch must be refused" }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect(res.status, `keyless admin PATCH: ${text.slice(0, 200)}`).toBe(400);
    expect(JSON.parse(text).error).toBe("presence_target_required");
    expect(await presenceCount()).toBe(before);
  }, 30_000);

  test("anonymous keyless PUT is exactly 401, no row", async () => {
    const before = await presenceCount();
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentTask: "anonymous put must be refused", activity: "coding" }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect(res.status, `anonymous PUT: ${text.slice(0, 200)}`).toBe(401);
    expect(await presenceCount()).toBe(before);
  }, 30_000);

  test("anonymous keyless PATCH is exactly 401, no row", async () => {
    const before = await presenceCount();
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentTask: "anonymous patch must be refused" }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect(res.status, `anonymous PATCH: ${text.slice(0, 200)}`).toBe(401);
    expect(await presenceCount()).toBe(before);
  }, 30_000);

  test("admin PUT with an empty-string body id → 400 presence_target_required, no row", async () => {
    const before = await presenceCount();
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: adminBasic() },
      body: JSON.stringify({ id: "", currentTask: "empty id put must be refused", activity: "coding" }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect(res.status, `empty-id admin PUT: ${text.slice(0, 200)}`).toBe(400);
    expect(JSON.parse(text).error).toBe("presence_target_required");
    expect(await presenceCount()).toBe(before);
  }, 30_000);

  test("admin PATCH with an empty-string body id → 400 presence_target_required, no row", async () => {
    const before = await presenceCount();
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: adminBasic() },
      body: JSON.stringify({ id: "", currentTask: "empty id patch must be refused" }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect(res.status, `empty-id admin PATCH: ${text.slice(0, 200)}`).toBe(400);
    expect(JSON.parse(text).error).toBe("presence_target_required");
    expect(await presenceCount()).toBe(before);
  }, 30_000);

  test("keyless DELETE from the Basic administrator → 400 presence_target_required, no row lost", async () => {
    const now = Date.now();
    await fetch(`${harper.httpURL}/Presence/${AGENT.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: ed25519Header(AGENT, "PUT", `/Presence/${AGENT.id}`) },
      body: JSON.stringify({ agentId: AGENT.id, currentTask: "row kept before keyless delete", activity: "coding", lastHeartbeatAt: now, activityUpdatedAt: now }),
      signal: AbortSignal.timeout(20_000),
    });
    const before = await presenceCount();
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "DELETE",
      headers: { Authorization: adminBasic() },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect(res.status, `keyless admin DELETE: ${text.slice(0, 200)}`).toBe(400);
    expect(JSON.parse(text).error).toBe("presence_target_required");
    expect(await presenceCount()).toBe(before);
  }, 30_000);

  test("an addressed DELETE from the Basic administrator still deletes", async () => {
    const now = Date.now();
    await fetch(`${harper.httpURL}/Presence/${AGENT.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: ed25519Header(AGENT, "PUT", `/Presence/${AGENT.id}`) },
      body: JSON.stringify({ agentId: AGENT.id, currentTask: "row removed by addressed delete", activity: "coding", lastHeartbeatAt: now, activityUpdatedAt: now }),
      signal: AbortSignal.timeout(20_000),
    });
    const before = await presenceCount();
    const res = await fetch(`${harper.httpURL}/Presence/${AGENT.id}`, {
      method: "DELETE",
      headers: { Authorization: adminBasic() },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    expect([200, 204], `addressed admin DELETE: ${text.slice(0, 200)}`).toContain(res.status);
    expect(await readPresenceRow(AGENT.id)).toBeNull();
    expect(await presenceCount()).toBe(before - 1);
  }, 30_000);

  test("a normal self-addressed PUT still stores; a normal self-addressed PATCH still stores", async () => {
    const before = await presenceCount();
    const now = Date.now();

    // Self-addressed PUT: the URL id resolves the target, so it is not keyless.
    const putRes = await fetch(`${harper.httpURL}/Presence/${AGENT.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: ed25519Header(AGENT, "PUT", `/Presence/${AGENT.id}`) },
      body: JSON.stringify({ agentId: AGENT.id, currentTask: "self put stored", activity: "coding", lastHeartbeatAt: now, activityUpdatedAt: now }),
      signal: AbortSignal.timeout(20_000),
    });
    expect([200, 204], `self PUT: ${await putRes.clone().text()}`).toContain(putRes.status);
    const afterPut = await readPresenceRow(AGENT.id);
    expect(afterPut).not.toBeNull();
    expect(afterPut.currentTask).toBe("self put stored");

    // Self-addressed PATCH merges into the stored row.
    const patchRes = await fetch(`${harper.httpURL}/Presence/${AGENT.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: ed25519Header(AGENT, "PATCH", `/Presence/${AGENT.id}`) },
      body: JSON.stringify({ currentTask: "self patch stored" }),
      signal: AbortSignal.timeout(20_000),
    });
    expect([200, 204], `self PATCH: ${await patchRes.clone().text()}`).toContain(patchRes.status);
    const afterPatch = await readPresenceRow(AGENT.id);
    expect(afterPatch).not.toBeNull();
    expect(afterPatch.currentTask).toBe("self patch stored");

    // Both writes landed on the SAME row: the count grew by exactly one.
    expect(await presenceCount()).toBe(before + 1);
  }, 30_000);
});
