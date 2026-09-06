import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const agent = (id: string) => ({ id, ...nacl.sign.keyPair() });
const owner = agent("authority-owner"), other = agent("authority-other");
let harper: HarperInstance;
const now = new Date().toISOString();
const headers = (who: typeof owner, method: string, path: string) => {
  const ts = String(Date.now()), nonce = randomUUID();
  const signature = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return { "Content-Type": "application/json", Authorization: `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(signature).toString("base64")}` };
};
async function request(who: typeof owner, method: string, path: string, body?: unknown) {
  return fetch(harper.httpURL + path, { method, headers: headers(who, method, path), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function op(body: Record<string, unknown>) {
  const response = await fetch(harper.opsURL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.json();
}
async function seed(table: string, records: Record<string, unknown>[]) {
  return op({ operation: "upsert", database: "flair", table, records });
}
const read = async (id: string) => (await op({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] }))[0];
beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  await seed("Agent", [owner, other].map(a => ({ id: a.id, name: a.id, role: "agent", publicKey: Buffer.from(a.publicKey).toString("base64"), createdAt: now })));
}, 120_000);
afterAll(async () => { if (harper) await stopHarper(harper); });

describe("Memory owner deletion over HTTP", () => {
  test("REST permanent-memory lifecycle is owner-controlled, with admin override", async () => {
    const id = "owner-permanent";
    const created = await request(owner, "PUT", `/Memory/${id}`, { id, agentId: owner.id, content: "Owner-controlled permanent lifecycle fixture.", durability: "permanent" });
    expect(created.status).toBe(200);
    expect((await request(other, "DELETE", `/Memory/${id}`)).status).toBe(403);
    expect((await fetch(`${harper.httpURL}/Memory/${id}`, { method: "DELETE" })).status).toBe(401);
    expect((await read(id)).durability).toBe("permanent");
    expect((await request(owner, "DELETE", `/Memory/${id}`)).status).toBe(200);
    expect(await read(id)).toBeUndefined();
    await seed("Memory", [{ id, agentId: owner.id, content: "Administrator deletion fixture.", durability: "permanent", createdAt: now }]);
    const adminDeleted = await fetch(`${harper.httpURL}/Memory/${id}`, { method: "DELETE", headers: { Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` } });
    expect(adminDeleted.status).toBe(200);
    expect(await read(id)).toBeUndefined();
  }, 120_000);
  test("lowercase memory route cannot bypass owner authorization", async () => {
    const id = "lowercase-permanent";
    await seed("Memory", [{ id, agentId: owner.id, content: "Lowercase route fixture.", durability: "permanent", createdAt: now }]);
    const denied = await request(other, "DELETE", `/memory/${id}`);
    expect([403, 404]).toContain(denied.status);
    expect((await read(id)).id).toBe(id);
    const deleted = await request(owner, "DELETE", `/memory/${id}`);
    // Harper may expose only the case-sensitive /Memory route. An absent alias
    // must leave the row intact; an active alias must enforce the same policy.
    expect([200, 204, 404]).toContain(deleted.status);
    if (deleted.status === 404) {
      expect((await read(id)).id).toBe(id);
      expect((await request(owner, "DELETE", `/Memory/${id}`)).status).toBe(200);
    }
    expect(await read(id)).toBeUndefined();
  }, 120_000);

});
