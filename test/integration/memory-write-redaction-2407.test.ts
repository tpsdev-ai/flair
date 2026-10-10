/**
 * memory-write-redaction-2407.test.ts — server-side credential redaction on the
 * real HTTP Memory write surface (flair#2407).
 *
 * Complements test/unit-isolated/memory-write-redaction-2407.test.ts: this file
 * runs against a REAL Harper (test/helpers/harper-lifecycle.ts), so the
 * redaction is proven through Harper's own resource dispatch and response
 * serialization — not a stand-in table. It sends POST /Memory, PUT and PATCH
 * /Memory/<id> and POST /FeedMemories as an agent key, an admin agent key or
 * the Basic administrator, and a signed batch to POST /FederationSync.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { redactSecrets, redactSecretsWithCount } from "../../packages/flair-mcp/src/secret-redaction.js";
import { computeContentHash } from "../../resources/memory-feed-lib.js";
import { signBody, signBodyFresh } from "../../resources/federation-crypto.js";
import { currentSeed, runSkillSeed, SEED_SKILL_ID, skillSeedRestIo } from "../../src/lib/skill-seed.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}
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
const agent = mkAgent("redact-agent-a");
// An agent key whose Agent record carries the admin role.
const adminAgent = mkAgent("redact-admin-a");
const PEER = "redact-peer-a";
const peerKeys = nacl.sign.keyPair();

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const adminBasic = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;
async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminBasic() },
    body: JSON.stringify(op),
  });
}
async function authFetch(method: string, path: string, body?: unknown, who: TestAgent = agent): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(who, method, path), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function basicFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: adminBasic(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function readRow(id: string): Promise<any> {
  const res = await adminOp({
    operation: "search_by_value",
    database: "flair",
    table: "Memory",
    search_attribute: "id",
    search_type: "equals",
    search_value: id,
    get_attributes: ["*"],
  });
  expect(res.status).toBe(200);
  const rows = JSON.parse(await res.text());
  return rows.find((r: any) => r.id === id);
}

const GITHUB_TOKEN = `ghp_${"a".repeat(24)}`;
const AWS_KEY = `AKIA${"B".repeat(16)}`;
const SLACK_TOKEN = `xoxb-${"c".repeat(12)}`;
const REDACTED = "[redacted]";

beforeAll(async () => {
  harper = await startHarper({ cwd: ROOT });
  assertOwnInstance(harper);
  const seed = await adminOp({
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [
      { id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() },
      { id: adminAgent.id, name: adminAgent.id, role: "admin", publicKey: adminAgent.publicKey, createdAt: new Date().toISOString() },
    ],
  });
  expect(seed.status).toBe(200);
  const peer = await adminOp({
    operation: "upsert",
    database: "flair",
    table: "Peer",
    records: [{ id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: new Date().toISOString() }],
  });
  expect(peer.status).toBe(200);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
});

describe("flair#2407 — real-Harper REST write paths redact and report the count", () => {
  it("POST /Memory stores the redacted content and reports one redacted value", async () => {
    const id = `r2407-post-${randomUUID()}`;
    const original = `stored CI token ${GITHUB_TOKEN} for the deploy job`;
    const res = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: original, visibility: "shared" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redactedValues).toBe(1);
    const row = await readRow(id);
    expect(row.content).toBe(`stored CI token ${REDACTED} for the deploy job`);
  }, 60_000);

  it("PUT /Memory/<id> stores the redacted content and reports one redacted value", async () => {
    const id = `r2407-put-${randomUUID()}`;
    const seed = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: "seed row before the update", visibility: "shared" });
    expect(seed.status).toBe(201);
    const original = `backup uses the key ${AWS_KEY} every night`;
    const res = await authFetch("PUT", `/Memory/${id}`, { id, agentId: agent.id, content: original, visibility: "shared" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redactedValues).toBe(1);
    expect((await readRow(id)).content).toBe(`backup uses the key ${REDACTED} every night`);
  }, 60_000);

  it("PATCH /Memory/<id> stores the redacted content and reports one redacted value", async () => {
    const id = `r2407-patch-${randomUUID()}`;
    const seed = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: "seed row before the patch", visibility: "shared" });
    expect(seed.status).toBe(201);
    const res = await authFetch("PATCH", `/Memory/${id}`, { content: `notify via ${SLACK_TOKEN}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redactedValues).toBe(1);
    expect((await readRow(id)).content).toBe(`notify via ${REDACTED}`);
  }, 60_000);

  it("POST /Memory with a string that merely starts like a prefix stores it byte-identical, no count", async () => {
    const id = `r2407-clean-${randomUUID()}`;
    const original = "the placeholder ghp_tooshort and sk-abc are not credentials";
    const res = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: original, visibility: "shared" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redactedValues).toBeUndefined();
    expect((await readRow(id)).content).toBe(original);
  }, 60_000);

  it("POST /Memory counts only the values it changed, not one already in redacted form", async () => {
    const id = `r2407-mixed-${randomUUID()}`;
    const res = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: `API_KEY=${REDACTED} and ${GITHUB_TOKEN} in one note`, visibility: "shared" });
    expect(res.status).toBe(201);
    expect((await res.json()).redactedValues).toBe(1);
    expect((await readRow(id)).content).toBe(`API_KEY=${REDACTED} and ${REDACTED} in one note`);
  }, 60_000);

  it("POST /FeedMemories stores the redacted content and reports one redacted value", async () => {
    const id = `r2407-feed-${randomUUID()}`;
    const original = `feed body carrying ${SLACK_TOKEN} for the team`;
    const res = await authFetch("POST", "/FeedMemories", { id, agentId: agent.id, content: original, durability: "permanent" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redactedValues).toBe(1);
    expect((await readRow(id)).content).toBe(`feed body carrying ${REDACTED} for the team`);
  }, 60_000);
});

/** The whole stored row through the admin surface, Harper's own metadata dropped. */
async function readStored(id: string): Promise<Record<string, any> | null> {
  const res = await adminOp({ operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"] });
  const text = await res.text();
  expect(res.status, text.slice(0, 200)).toBe(200);
  const record = (JSON.parse(text) as any[])[0];
  if (!record) return null;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith("__")));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("flair#2407 — the shipped-skill seed's Basic PUT is exempt from redaction", () => {
  it("the seed's Basic PUT stores its text verbatim; the same text from an admin agent key is redacted", async () => {
    const seed = currentSeed();
    // Precondition: the redactor changes this text, so the comparison below means something.
    expect(redactSecrets(seed.content)).not.toBe(seed.content);

    const outcome = await runSkillSeed(
      skillSeedRestIo({ baseUrl: harper.httpURL, user: harper.admin.username, pass: harper.admin.password }),
      seed,
    );
    expect(outcome.kind, JSON.stringify(outcome)).toBe("ok");
    const seeded = await readStored(SEED_SKILL_ID);
    expect(seeded?.content).toBe(seed.content);
    expect(seeded?.trigger).toBe(seed.trigger);

    const id = `r2407-admin-agent-${randomUUID()}`;
    const res = await authFetch("POST", "/Memory", { id, agentId: adminAgent.id, content: seed.content, visibility: "shared" }, adminAgent);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.redactedValues).toBe(redactSecretsWithCount(seed.content).count);
    expect((await readStored(id))?.content).toBe(redactSecrets(seed.content));
  }, 180_000);

  it("a Basic administrator's PUT to an id other than the seed's is redacted", async () => {
    const id = `r2407-basic-${randomUUID()}`;
    const res = await basicFetch("PUT", `/Memory/${id}`, { id, agentId: harper.admin.username, content: `operator note ${GITHUB_TOKEN}`, visibility: "shared" });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.redactedValues).toBe(1);
    expect((await readStored(id))?.content).toBe(`operator note ${REDACTED}`);
  }, 60_000);
});

describe("flair#2407 — a supplied embedding is replaced when redaction changes its source text", () => {
  const CREDENTIAL_TEXT = `the deploy job reads token=${GITHUB_TOKEN} from the vault`;
  const REDACTED_TEXT = `the deploy job reads token=${REDACTED} from the vault`;
  let computed: number[];
  let modelId: string;
  let supplied: number[];

  beforeAll(async () => {
    // The server's own vector for the redacted text. That text is already in
    // redacted form, so it is stored unchanged and no count is reported.
    const id = `r2407-vec-control-${randomUUID()}`;
    const res = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: REDACTED_TEXT, visibility: "shared" });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.redactedValues).toBeUndefined();
    const row = await readStored(id);
    expect(row?.content).toBe(REDACTED_TEXT);
    expect(Array.isArray(row?.embedding) && row!.embedding.length > 0).toBe(true);
    computed = row!.embedding;
    modelId = row!.embeddingModel;
    supplied = computed.map((_, i) => (i === 0 ? 1 : 0));
    expect(cosine(supplied, computed)).toBeLessThan(0.9);
  }, 120_000);

  function expectComputed(row: Record<string, any> | null): void {
    expect(row?.content).toBe(REDACTED_TEXT);
    expect(row?.embeddingModel).toBe(modelId);
    expect(row?.embedding).not.toEqual(supplied);
    expect(cosine(row!.embedding, computed)).toBeGreaterThan(0.9999);
  }

  it("POST /Memory", async () => {
    const id = `r2407-vec-post-${randomUUID()}`;
    const res = await authFetch("POST", "/Memory", {
      id, agentId: agent.id, content: CREDENTIAL_TEXT, visibility: "shared", embedding: supplied, embeddingModel: "client-model",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).redactedValues).toBe(1);
    expectComputed(await readStored(id));
  }, 60_000);

  it("PUT /Memory/<id>", async () => {
    const id = `r2407-vec-put-${randomUUID()}`;
    expect((await authFetch("POST", "/Memory", { id, agentId: agent.id, content: "row before the update", visibility: "shared" })).status).toBe(201);
    const res = await authFetch("PUT", `/Memory/${id}`, {
      id, agentId: agent.id, content: CREDENTIAL_TEXT, visibility: "shared", embedding: supplied, embeddingModel: "client-model",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).redactedValues).toBe(1);
    expectComputed(await readStored(id));
  }, 60_000);

  it("PATCH /Memory/<id>", async () => {
    const id = `r2407-vec-patch-${randomUUID()}`;
    expect((await authFetch("POST", "/Memory", { id, agentId: agent.id, content: "row before the patch", visibility: "shared" })).status).toBe(201);
    const res = await authFetch("PATCH", `/Memory/${id}`, { content: CREDENTIAL_TEXT, embedding: supplied, embeddingModel: "client-model" });
    expect(res.status).toBe(200);
    expect((await res.json()).redactedValues).toBe(1);
    expectComputed(await readStored(id));
  }, 60_000);

  it("POST /FeedMemories refuses a supplied vector and stores nothing (flair#2354)", async () => {
    const id = `r2407-vec-feed-${randomUUID()}`;
    const res = await authFetch("POST", "/FeedMemories", {
      id, agentId: agent.id, content: `feed: ${CREDENTIAL_TEXT}`, durability: "permanent", embedding: supplied, embeddingModel: "client-model",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("feed_embedding_not_writable");
    expect(await readStored(id)).toBeFalsy();
  }, 60_000);

  it("a POST /Memory that redaction leaves unchanged keeps its supplied vector", async () => {
    const id = `r2407-vec-clean-${randomUUID()}`;
    const res = await authFetch("POST", "/Memory", {
      id, agentId: agent.id, content: "a plain note about the deploy job", visibility: "shared", embedding: supplied, embeddingModel: "client-model",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).redactedValues).toBeUndefined();
    const row = await readStored(id);
    expect(row?.embedding).toEqual(supplied);
    expect(row?.embeddingModel).toBe("client-model");
  }, 60_000);
});

describe("flair#2407 — a deduplicated feed write reports the count in its response only", () => {
  it("a repeated feed write returns the stored row plus the count; the stored row has no count", async () => {
    const original = `feed dedup body carrying ${SLACK_TOKEN} ${randomUUID()}`;
    const first = await authFetch("POST", "/FeedMemories", { agentId: agent.id, content: original, durability: "permanent" });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.redactedValues).toBe(1);
    const storedFirst = await readStored(firstBody.id);
    expect(storedFirst && "redactedValues" in storedFirst).toBe(false);

    const second = await authFetch("POST", "/FeedMemories", { agentId: agent.id, content: original, durability: "permanent" });
    expect(second.status).toBe(200);
    const { redactedValues, ...rest } = await second.json();
    expect(redactedValues).toBe(1);
    expect(rest.id).toBe(firstBody.id);
    const stored = await readStored(firstBody.id);
    expect(stored && "redactedValues" in stored).toBe(false);
    expect(stored?.content).toBe(original.replace(SLACK_TOKEN, REDACTED));
    expect(rest).toEqual(stored!);
  }, 60_000);

  it("the expiry repair of a deduplicated ephemeral row returns the repaired row plus the count", async () => {
    const tail = randomUUID();
    const original = `ephemeral feed state ${SLACK_TOKEN} ${tail}`;
    const redacted = `ephemeral feed state ${REDACTED} ${tail}`;
    const id = `r2407-repair-${tail}`;
    const insert = await adminOp({
      operation: "insert", database: "flair", table: "Memory",
      records: [{ id, agentId: agent.id, content: redacted, contentHash: computeContentHash(agent.id, redacted), durability: "ephemeral", createdAt: new Date().toISOString() }],
    });
    expect(insert.status).toBe(200);
    expect((await readStored(id))?.expiresAt ?? null).toBeNull();

    const res = await authFetch("POST", "/FeedMemories", { agentId: agent.id, content: original });
    expect(res.status).toBe(200);
    const { redactedValues, ...rest } = await res.json();
    expect(redactedValues).toBe(1);
    const stored = await readStored(id);
    expect(typeof stored?.expiresAt).toBe("string");
    expect(stored && "redactedValues" in stored).toBe(false);
    expect(rest).toEqual(stored!);
  }, 60_000);
});

describe("flair#2407 — the redactor leaves incoming federated content alone", () => {
  it("a signed Memory record with credential-shaped content is accepted and stored unchanged", async () => {
    const content = `peer memory carrying ${GITHUB_TOKEN} as written at its origin`;
    const record = (id: string) => ({
      v: 2, table: "Memory", id,
      data: { id, agentId: agent.id, content, visibility: "shared", createdAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(), originatorInstanceId: PEER, principalId: agent.id,
    });
    const goodId = `r2407-fed-${randomUUID()}`;
    const good = record(goodId);
    // The signature is checked on the incoming record: one signed by another key is skipped.
    const forgedId = `r2407-fed-forged-${randomUUID()}`;
    const forged = record(forgedId);
    const batch = signBodyFresh({
      instanceId: PEER,
      records: [
        { ...good, signature: signBody(good, peerKeys.secretKey) },
        { ...forged, signature: signBody(forged, nacl.sign.keyPair().secretKey) },
      ],
      lamportClock: Date.now(),
    }, peerKeys.secretKey);
    const res = await fetch(`${harper.httpURL}/FederationSync`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.merged, JSON.stringify(body)).toBe(1);
    expect(body.skippedReasons).toEqual({ invalid_signature: 1 });
    expect((await readStored(goodId))?.content).toBe(content);
    expect(await readStored(forgedId)).toBeNull();
  }, 60_000);
});
