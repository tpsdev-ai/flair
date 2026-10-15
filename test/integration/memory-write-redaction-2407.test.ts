/**
 * memory-write-redaction-2407.test.ts — server-side credential redaction on the
 * real HTTP Memory write surface (flair#2407).
 *
 * Complements test/unit-isolated/memory-write-redaction-2407.test.ts: this file
 * runs against a REAL Harper (test/helpers/harper-lifecycle.ts), so the
 * redaction is proven through Harper's own resource dispatch and response
 * serialization — not a stand-in table. It sends POST /Memory, PUT and PATCH
 * /Memory/<id> and POST /FeedMemories as an agent key, an admin agent key or
 * the Basic administrator, and a signed batch to POST /FederationSync. The
 * flair#2467 blocks also drive the real FlairClient and the MCP write handlers.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { redactSecrets, redactSecretsWithCount } from "../../packages/flair-mcp/src/secret-redaction.js";
import { computeContentHash } from "../../resources/memory-feed-lib.js";
import { signBody, signBodyFresh } from "../../resources/federation-crypto.js";
import { currentSeed, runSkillSeed, SEED_SKILL_ID, skillSeedRestIo } from "../../src/lib/skill-seed.js";
import { FlairClient } from "../../packages/flair-client/src/client.js";
import { STDIO_TOOL_HANDLERS } from "../../packages/flair-mcp/src/adapter-tools.ts";

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

/**
 * flair#2467 — a redacting write's response carries the post-redaction values
 * of the text fields that write committed, and the SDK's write/update results
 * and the MCP write replies are built from it, through the REAL FlairClient
 * against REAL Harper.
 *
 * The SDK makes no read after the write: what a result reports comes from the
 * write's own response, so a later write to the same row cannot change it.
 */
describe("flair#2467 — a redacting write's response carries the stored text it committed", () => {
  it("POST, PUT and PATCH /Memory return `stored`: the redacted text fields that write committed", async () => {
    const id = `r2467-rest-${randomUUID()}`;
    const post = await authFetch("POST", "/Memory", {
      id, agentId: agent.id, content: `post body ${GITHUB_TOKEN} end`, summary: `post summary ${AWS_KEY}`, visibility: "shared",
    });
    expect(post.status).toBe(201);
    const postBody = await post.json();
    expect(postBody.redactedValues).toBe(2);
    expect(postBody.stored).toEqual({ content: `post body ${REDACTED} end`, summary: `post summary ${REDACTED}` });

    const put = await authFetch("PUT", `/Memory/${id}`, {
      id, agentId: agent.id, content: `put body ${SLACK_TOKEN} end`, summary: `put summary ${GITHUB_TOKEN}`,
      trigger: `put trigger ${AWS_KEY}`, visibility: "shared",
    });
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.redactedValues).toBe(3);
    expect(putBody.stored).toEqual({
      content: `put body ${REDACTED} end`, summary: `put summary ${REDACTED}`, trigger: `put trigger ${REDACTED}`,
    });

    // A PATCH commits only the fields in its body, so `stored` names only those.
    const patch = await authFetch("PATCH", `/Memory/${id}`, { summary: `patch summary ${SLACK_TOKEN}` });
    expect(patch.status).toBe(200);
    const patchBody = await patch.json();
    expect(patchBody.redactedValues).toBe(1);
    expect(patchBody.stored).toEqual({ summary: `patch summary ${REDACTED}` });

    const row = await readStored(id);
    expect(row?.content).toBe(`put body ${REDACTED} end`);
    expect(row?.summary).toBe(`patch summary ${REDACTED}`);
    expect(row?.trigger).toBe(`put trigger ${REDACTED}`);
  }, 60_000);

  it("a write with nothing to redact returns no `stored` and no count", async () => {
    const id = `r2467-rest-clean-${randomUUID()}`;
    const res = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: "a plain note", visibility: "shared" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redactedValues).toBeUndefined();
    expect("stored" in body).toBe(false);
  }, 60_000);

  it("a skill PUT that versions to a successor row reports the successor's id and its stored text", async () => {
    const root = `r2467-skill-${randomUUID()}`;
    const skill = { agentId: agent.id, tags: ["skill"], durability: "persistent", visibility: "shared" };
    const created = await authFetch("POST", "/Memory", { ...skill, id: root, content: "skill v1 procedure", trigger: "when deploying" });
    expect(created.status, await created.clone().text()).toBe(200);
    const res = await authFetch("PUT", `/Memory/${root}`, {
      ...skill, id: root, content: `skill v2 reads ${GITHUB_TOKEN}`, trigger: `when deploying with ${AWS_KEY}`,
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.redactedValues).toBe(2);
    expect(body.id).not.toBe(root);
    expect(body.stored).toEqual({ content: `skill v2 reads ${REDACTED}`, trigger: `when deploying with ${REDACTED}`, tags: ["skill"] });
    const successor = await readStored(body.id);
    expect(successor?.supersedes).toBe(root);
    expect(successor?.content).toBe(body.stored.content);
    expect(successor?.trigger).toBe(body.stored.trigger);
  }, 60_000);
});

describe("flair#2467 — the SDK write result and the MCP replies after a redaction", () => {
  let keyDir: string;
  let keyPath: string;
  let client: FlairClient;

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "flair-2467-sdk-"));
    keyPath = join(keyDir, "redact-agent-a.key");
    // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
    await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
    client = new FlairClient({ agentId: agent.id, url: harper.httpURL, keyPath });
  });

  afterAll(async () => {
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  const ctx = (flair: FlairClient = client) => ({ flair, agentId: agent.id, heartbeat: () => {}, rememberTask: () => {} });

  /** A row written through the admin surface, so its summary and trigger hold
   *  credential-shaped text the ordinary redacted Memory write paths would
   *  replace. */
  async function seedUnredactedRow(id: string): Promise<void> {
    const content = "seed row before the update";
    const res = await adminOp({
      operation: "insert", database: "flair", table: "Memory",
      records: [{
        id, agentId: agent.id, content, contentHash: computeContentHash(agent.id, content),
        summary: `seed summary ${SLACK_TOKEN}`, trigger: `seed trigger ${GITHUB_TOKEN}`,
        type: "session", durability: "standard", visibility: "shared", createdAt: new Date().toISOString(),
      }],
    });
    expect(res.status).toBe(200);
    const row = await readStored(id);
    expect(row?.summary).toBe(`seed summary ${SLACK_TOKEN}`);
    expect(row?.trigger).toBe(`seed trigger ${GITHUB_TOKEN}`);
  }

  it("memory.write returns the STORED (redacted) content and the count", async () => {
    const id = `r2467-sdk-write-${randomUUID()}`;
    const res: any = await client.memory.write(`sdk write ${GITHUB_TOKEN} note`, { id });
    expect(res.redactedValues).toBe(1);
    expect(res.content).toBe(`sdk write ${REDACTED} note`);
    expect(res.contentWithheld).toBeUndefined();
  }, 60_000);

  it("a same-id memory.update of a row whose summary and trigger hold credentials returns all three redacted", async () => {
    const id = `r2467-sdk-update-${randomUUID()}`;
    await seedUnredactedRow(id);
    const res: any = await client.memory.update(id, `sdk update ${AWS_KEY} note`);
    expect(res.id).toBe(id);
    expect(res.redactedValues).toBe(3);
    expect(res.content).toBe(`sdk update ${REDACTED} note`);
    expect(res.summary).toBe(`seed summary ${REDACTED}`);
    expect(res.trigger).toBe(`seed trigger ${REDACTED}`);
    const row = await readStored(id);
    expect([row?.content, row?.summary, row?.trigger]).toEqual([res.content, res.summary, res.trigger]);
  }, 60_000);

  it("a redacted memory.update with preserveHistory returns the successor's id, its stored text and the count", async () => {
    const id = `r2467-sdk-version-${randomUUID()}`;
    await seedUnredactedRow(id);
    const res: any = await client.memory.update(id, `sdk version ${AWS_KEY} note`, { preserveHistory: true });
    expect(res.id).not.toBe(id);
    expect(res.redactedValues).toBe(3);
    expect(res.content).toBe(`sdk version ${REDACTED} note`);
    expect(res.summary).toBe(`seed summary ${REDACTED}`);
    expect(res.trigger).toBe(`seed trigger ${REDACTED}`);
    const successor = await readStored(res.id);
    expect(successor?.supersedes).toBe(id);
    expect([successor?.content, successor?.summary, successor?.trigger]).toEqual([res.content, res.summary, res.trigger]);
  }, 60_000);

  it("memory_update with preserveHistory replies with the successor's id, its stored text and the count", async () => {
    const id = `r2467-mcp-version-${randomUUID()}`;
    await seedUnredactedRow(id);
    const res: any = await STDIO_TOOL_HANDLERS.memory_update(
      { id, content: `mcp version ${AWS_KEY} note`, preserveHistory: true }, ctx() as any,
    );
    const successorId = res.structuredContent.id;
    expect(successorId).not.toBe(id);
    expect(res.structuredContent.supersedes).toBe(id);
    expect(res.structuredContent.redactedValues).toBe(3);
    const text = res.content[0].text;
    expect(text).toContain(`Memory updated: new version stored (id: ${successorId}), supersedes ${id}.`);
    expect(text).toContain(`Preview: mcp version ${REDACTED} note`);
    expect(text).toContain("Redacted 3 credential-shaped value(s) before storing.");
    for (const secret of [AWS_KEY, SLACK_TOKEN, GITHUB_TOKEN]) expect(text).not.toContain(secret);
    expect((await readStored(successorId))?.content).toBe(`mcp version ${REDACTED} note`);
  }, 60_000);

  it("memory_store's reply previews the STORED text and reports the count", async () => {
    const res: any = await STDIO_TOOL_HANDLERS.memory_store({ content: `mcp store ${GITHUB_TOKEN} note`, tags: [] }, ctx() as any);
    const text = res.content[0].text;
    expect(text).toContain(`Preview: mcp store ${REDACTED} note`);
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(text).toContain("Redacted 1 credential-shaped value(s) before storing.");
    expect(res.structuredContent.redactedValues).toBe(1);
  }, 60_000);

  it("memory_update's reply previews the STORED text and reports the count", async () => {
    const id = `r2467-mcp-update-${randomUUID()}`;
    await client.memory.write("seed before the mcp redacted update", { id });
    const res: any = await STDIO_TOOL_HANDLERS.memory_update({ id, content: `mcp update ${AWS_KEY} note` }, ctx() as any);
    const text = res.content[0].text;
    expect(text).toContain(`Preview: mcp update ${REDACTED} note`);
    expect(text).toContain("Redacted 1 credential-shaped value(s) before storing.");
    expect(res.structuredContent.redactedValues).toBe(1);
  }, 60_000);

  /** A client whose first PUT is followed, before its response reaches the
   *  SDK, by another write to the same row with different text. */
  function clientWithInterveningWrite(id: string, laterContent: string): { flair: FlairClient; intervened: () => number } {
    const flair = new FlairClient({ agentId: agent.id, url: harper.httpURL, keyPath });
    const request = flair.request.bind(flair);
    let intervened = 0;
    (flair as any).request = async (method: string, path: string, ...rest: any[]) => {
      const response = await (request as any)(method, path, ...rest);
      if (method === "PUT" && intervened === 0) {
        intervened++;
        const later = await authFetch("PUT", `/Memory/${id}`, { id, agentId: agent.id, content: laterContent, visibility: "shared" });
        expect(later.status).toBe(200);
      }
      return response;
    };
    return { flair, intervened: () => intervened };
  }

  it("a write to the row after memory.write's PUT cannot change what memory.write reports", async () => {
    const id = `r2467-race-write-${randomUUID()}`;
    const { flair, intervened } = clientWithInterveningWrite(id, `later write ${SLACK_TOKEN} note`);
    const res: any = await flair.memory.write(`first write ${GITHUB_TOKEN} note`, { id });
    expect(intervened()).toBe(1);
    expect((await readStored(id))?.content).toBe(`later write ${REDACTED} note`);
    expect(res.id).toBe(id);
    expect(res.redactedValues).toBe(1);
    expect(res.content).toBe(`first write ${REDACTED} note`);
  }, 60_000);

  it("a write to the row after memory.update's PUT cannot change what memory.update reports", async () => {
    const id = `r2467-race-update-${randomUUID()}`;
    await client.memory.write("seed before the raced update", { id });
    const { flair, intervened } = clientWithInterveningWrite(id, `later update ${SLACK_TOKEN} note`);
    const res: any = await flair.memory.update(id, `first update ${AWS_KEY} note`);
    expect(intervened()).toBe(1);
    expect((await readStored(id))?.content).toBe(`later update ${REDACTED} note`);
    expect(res.redactedValues).toBe(1);
    expect(res.content).toBe(`first update ${REDACTED} note`);
  }, 60_000);
});
