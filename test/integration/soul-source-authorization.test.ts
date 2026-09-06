import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { signBody, signBodyFresh } from "../../resources/federation-crypto";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const agent = (id: string) => ({ id, ...nacl.sign.keyPair() });
const owner = agent("soul-runtime"), other = agent("soul-admin-runtime");
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
const read = async (id: string) => (await op({ operation: "search_by_id", database: "flair", table: "Soul", ids: [id], get_attributes: ["*"] }))[0];
beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  await seed("Agent", [owner, other].map(a => ({ id: a.id, name: a.id, role: a.id === other.id ? "admin" : "agent", publicKey: Buffer.from(a.publicKey).toString("base64"), createdAt: now })));
}, 120_000);
afterAll(async () => { if (harper) await stopHarper(harper); });


const operator = async (method: string, path: string, body?: unknown, credential?: string) => fetch(harper.httpURL + path, {
  method,
  headers: { "Content-Type": "application/json", Authorization: credential ?? `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const entry = (id: string, value = "Operator-authored identity") => ({ id, agentId: owner.id, key: id, value, createdAt: now });

describe("Soul source authorization over HTTP", () => {
  test("agent and admin-agent keys cannot mutate Soul with forged source fields", async () => {
    for (const who of [owner, other]) {
      for (const [method, root] of ["POST", "PUT", "PATCH", "DELETE"].flatMap(method => ["Soul", "soul"].map(root => [method, root]))) {
        const id = `${who.id}-${method}`;
        const original = entry(id);
        await seed("Soul", [original]);
        const result = await request(who, method, method === "POST" ? `/${root}/` : `/${root}/${id}`, method === "DELETE" ? undefined : {
          ...original, value: "runtime claim", sourceClass: "operator", __flairInternal: true,
          provenance: '{"verified":{"sourceClass":"operator"}}',
        });
        expect(root === "Soul" ? [403] : [403, 404]).toContain(result.status);
        expect((await read(id)).value).toBe(original.value);
      }
    }
  });

  test("operator Basic writes and deletes; provenance is server-derived", async () => {
    for (const method of ["POST", "PUT", "PATCH"]) {
      const id = `operator-${method}`;
      if (method === "PATCH") await seed("Soul", [entry(id)]);
      const result = await operator(method, method === "POST" ? "/Soul/" : `/Soul/${id}`, {
        ...entry(id), value: "Deliberately authored", provenance: "forged",
      });
      expect(result.status).toBeLessThan(300);
      const stored = await read(id);
      const provenance = JSON.parse(stored.provenance);
      expect(provenance.verified.sourceClass).toBe("operator");
      expect(provenance.verified.agentId).toBe(harper.admin.username);
      expect(provenance.verified.timestamp).toBeTruthy();
      expect((await operator("DELETE", `/Soul/${id}`)).status).toBeLessThan(300);
      expect(await read(id)).toBeUndefined();
    }
  });

  test("admin bearer tokens do not become operator sessions", async () => {
    const tokens = await op({ operation: "create_authentication_tokens", username: harper.admin.username, password: harper.admin.password });
    expect(tokens.operation_token).toBeTruthy();
    const result = await operator("PUT", "/Soul/bearer", entry("bearer"), `Bearer ${tokens.operation_token}`);
    expect([401, 403]).toContain(result.status);
    expect(await read("bearer")).toBeUndefined();
  });

  test("anonymous and invalid credentials cannot claim operator source", async () => {
    const response = await fetch(`${harper.httpURL}/Soul/anonymous`, { method: "PUT", headers: { "Content-Type": "application/json", "x-flair-source-class": "operator" }, body: JSON.stringify(entry("anonymous")) });
    expect(response.status).toBe(401);
    expect((await operator("PUT", "/Soul/invalid", entry("invalid"), `Basic ${btoa("admin:wrong")}`)).status).toBe(401);
    expect(await read("anonymous")).toBeUndefined();
    expect(await read("invalid")).toBeUndefined();
  });

  test("operator credentials cannot launder the target agent’s untagged or legacy learned content", async () => {
    await seed("Memory", [{ id: "learned", agentId: owner.id, content: "Learned from a runtime", createdAt: now }]);
    await seed("MemoryCandidate", [{ id: "candidate", agentId: owner.id, claim: "Candidate from a runtime", status: "pending", createdAt: now, generatedAt: now }]);
    for (const value of ["Learned from a runtime", "Candidate from a runtime"]) {
      for (const method of ["POST", "PUT", "PATCH"]) {
        const id = `learned-${method}`;
        await seed("Soul", [entry(id)]);
        const response = await operator(method, method === "POST" ? "/Soul/" : `/Soul/${id}`, { ...entry(id), value });
        expect(response.status).toBe(403);
        expect((await read(id)).value).toBe(entry(id).value);
      }
    }
  });

  test("AgentSeed cannot turn admin-agent input into an internal Soul write", async () => {
    const response = await request(other, "POST", "/AgentSeed", { agentId: "seed-bypass", soulTemplate: { role: "runtime claim" } });
    expect(response.status).toBe(403);
    expect(await read("seed-bypass:role")).toBeUndefined();
    const seeded = await operator("POST", "/AgentSeed", { agentId: "operator-seed", soulTemplate: { role: "Operator-authored role" } });
    expect(seeded.status).toBeLessThan(300);
    expect((await read("operator-seed:role")).value).toBe("Operator-authored role");
  });
  test("authenticated federation preserves the originating Soul provenance", async () => {
    const id = "replicated-soul";
    expect((await operator("PUT", `/Soul/${id}`, entry(id))).status).toBeLessThan(300);
    const authored = await read(id);
    const peer = agent("soul-peer");
    await seed("Peer", [{ id: peer.id, publicKey: Buffer.from(peer.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: now }]);
    const unsigned = { v: 2, table: "Soul", id: "replica", data: { ...authored, id: "replica" }, updatedAt: new Date().toISOString(), originatorInstanceId: peer.id, principalId: owner.id };
    const record = { ...unsigned, signature: signBody(unsigned, peer.secretKey) };
    const batch = signBodyFresh({ instanceId: peer.id, records: [record], lamportClock: Date.now() }, peer.secretKey);
    const response = await fetch(`${harper.httpURL}/FederationSync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) });
    expect(response.status).toBe(200);
    expect((await response.json()).merged).toBe(1);
    expect((await read("replica")).provenance).toBe(authored.provenance);
  }, 120_000);

  test("operator restore must write souls before memories when identity text matches", async () => {
    const value = "Restored identity that also exists as a memory";
    const soulId = "restore-order-soul";
    expect((await operator("PUT", `/Soul/${soulId}`, entry(soulId, value))).status).toBeLessThan(300);
    await seed("Memory", [{ id: "restore-order-mem", agentId: owner.id, content: value, createdAt: now }]);
    expect((await read(soulId)).value).toBe(value);
    expect((await operator("DELETE", `/Soul/${soulId}`)).status).toBeLessThan(300);
    expect((await operator("PUT", `/Soul/${soulId}`, entry(soulId, value))).status).toBe(403);
    await op({ operation: "delete", database: "flair", table: "Memory", ids: ["restore-order-mem"] });
    expect((await operator("PUT", `/Soul/${soulId}`, entry(soulId, value))).status).toBeLessThan(300);
    expect((await read(soulId)).value).toBe(value);
  });

  test("array bodies cannot bypass the learned-content check", async () => {
    await seed("Memory", [{ id: "array-source", agentId: owner.id, content: "Array laundering probe", createdAt: now }]);
    const response = await operator("POST", "/Soul/", [entry("array-target", "Array laundering probe")]);
    expect([400, 403, 405]).toContain(response.status);
    expect(await read("array-target")).toBeUndefined();
  });

});
