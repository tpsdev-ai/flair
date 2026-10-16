/**
 * write-stored-supplied-fields-2561.test.ts — a Memory write's `stored` reports
 * only the string-valued text fields (`content`, `summary`, `trigger`) the
 * write's own request supplied, as stored, and the POST /FeedMemories response
 * only the allowlisted primitive Memory attributes its request supplied plus the listed
 * response fields of the row and `redactedValues` when present (flair#2561).
 *
 * Runs against a REAL Harper (test/helpers/harper-lifecycle.ts). A skill
 * successor row carries over the text fields its request omits from the row it
 * supersedes; these cases check that the response reports the fields the
 * request supplied and none of the carried-over ones, for a successor written
 * through PUT /Memory/<id>, POST /Memory and POST /FeedMemories by an agent
 * other than the skill's author that may write the author's memories (seeded
 * below), and that a write supplying every text field gets all three back,
 * redacted, and a PATCH gets back only the field it sent. No Memory or feed
 * write response carries an embedding field: the re-embed PATCH answers
 * `{ id, updatedAt }`, and the admin `_reindex` re-PUT answers without one.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
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
const author = mkAgent("s2561-author");
const writer = mkAgent("s2561-writer");
const admin = mkAgent("s2561-admin");
const AUTHOR_CONTENT = "s2561 author skill procedure body";
const AUTHOR_SUMMARY = "s2561 author skill summary";
const AUTHOR_TRIGGER = "s2561 author skill trigger";
const AUTHOR_NAME = "s2561-author-skill-name";
const AUTHOR_DESCRIPTION = "s2561 author skill description";
const AUTHOR_SUBJECT = "s2561-author-subject";
const AUTHOR_SOURCE = "s2561-author-source";
const AUTHOR_SESSION = "s2561-author-session";
/** The descriptive fields the author's skill holds besides its text. */
const AUTHOR_DESCRIPTIVE = {
  metadata: JSON.stringify({ name: AUTHOR_NAME, description: AUTHOR_DESCRIPTION }),
  subject: AUTHOR_SUBJECT,
  source: AUTHOR_SOURCE,
  sessionId: AUTHOR_SESSION,
};
const EMBEDDING_FIELDS = ["embedding", "embeddingModel"];
/** The fields a feed response reports whether or not the request sent them. */
const FEED_WRITE_FIELDS = [
  "id", "written", "agentId", "durability", "visibility", "createdAt", "updatedAt", "expiresAt", "archived",
  "supersedes", "skillSubjectId", "instanceToken", "originatorInstanceId", "provenance",
];
const TOKEN = `ghp_${"a".repeat(24)}`;
const AWS_KEY = `AKIA${"B".repeat(16)}`;
const SLACK_TOKEN = `xoxb-${"c".repeat(12)}`;
const REDACTED = "[redacted]";

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    if (u.hostname !== "127.0.0.1" || u.port === "9925" || u.port === "9926") throw new Error(`refusing ${url}`);
  }
  if (!h.installDir.startsWith(tmpdir())) throw new Error("refusing: not a test-owned instance");
}
async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function send(agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
/** The whole stored row through the admin surface, Harper's own metadata dropped. */
async function readStored(id: string): Promise<Record<string, any> | null> {
  const res = await adminOp({ operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"] });
  const text = await res.text();
  expect(res.status, text.slice(0, 200)).toBe(200);
  const record = (JSON.parse(text) as any[])[0];
  if (!record) return null;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith("__")));
}
/** A skill written by `author` with all three text fields and AUTHOR_DESCRIPTIVE. */
async function makeAuthorSkill(id: string): Promise<void> {
  const res = await send(author, "PUT", `/Memory/${id}`, {
    id, agentId: author.id, content: AUTHOR_CONTENT, summary: AUTHOR_SUMMARY, trigger: AUTHOR_TRIGGER,
    ...AUTHOR_DESCRIPTIVE, tags: ["skill"], durability: "persistent", visibility: "private",
  });
  const text = await res.text();
  expect(res.status, `author skill create ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
}
/** The response carries none of the text fields the request did not supply. */
function expectNoAuthorText(text: string): void {
  expect(text.includes(AUTHOR_CONTENT), `response carries content the request did not supply: ${text.slice(0, 400)}`).toBe(false);
  expect(text.includes(AUTHOR_TRIGGER), `response carries a trigger the request did not supply: ${text.slice(0, 400)}`).toBe(false);
  expect(text.includes(AUTHOR_SUMMARY), `response carries a summary the request did not supply: ${text.slice(0, 400)}`).toBe(false);
  for (const value of [AUTHOR_NAME, AUTHOR_DESCRIPTION, AUTHOR_SUBJECT, AUTHOR_SOURCE, AUTHOR_SESSION]) {
    expect(text.includes(value), `response carries ${value}, which the request did not supply: ${text.slice(0, 400)}`).toBe(false);
  }
}
/** The successor row holds the fields it carried over, so the response's omission is a choice of what to report. */
async function expectSuccessorCarriesAuthorText(successorId: string, predecessorId: string): Promise<void> {
  const row = await readStored(successorId);
  expect(row?.supersedes).toBe(predecessorId);
  expect(row?.content).toBe(AUTHOR_CONTENT);
  expect(row?.trigger).toBe(AUTHOR_TRIGGER);
  expect(row?.metadata).toBe(AUTHOR_DESCRIPTIVE.metadata);
  expect(row?.subject).toBe(AUTHOR_SUBJECT);
}
/** No embedding field in a write response. */
function expectNoEmbedding(label: string, body: unknown): void {
  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value as object)) {
      if (EMBEDDING_FIELDS.includes(key)) found.push(`${path}${key}`);
      walk(item, `${path}${key}.`);
    }
  };
  walk(body, "");
  expect(found, `${label} response carries an embedding key at any depth`).toEqual([]);
}

beforeAll(async () => {
  harper = await startHarper({ cwd: ROOT });
  assertOwnInstance(harper);
  const seed = await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [author, writer].map((a) => ({ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() })),
  });
  expect(seed.status).toBe(200);
  const adminSeed = await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: admin.id, name: admin.id, role: "admin", publicKey: admin.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(adminSeed.status).toBe(200);
  const permission = await adminOp({
    operation: "insert", database: "flair", table: "MemoryGrant",
    records: [{ id: `${author.id}:${writer.id}:write`, ownerId: author.id, granteeId: writer.id, scope: "write", createdAt: new Date().toISOString() }],
  });
  expect(permission.status).toBe(200);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair#2561 — a skill successor that omits content and trigger gets neither back", () => {
  it("precondition: a GET of the skill by the second agent is refused with 404 and returns none of its text", async () => {
    const id = `s2561-pre-${randomUUID()}`;
    await makeAuthorSkill(id);
    const res = await send(writer, "GET", `/Memory/${id}`);
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(404);
    expectNoAuthorText(text);
  }, 60_000);

  it("PUT /Memory/<id>: `stored` is the redacted summary the request supplied, and nothing else", async () => {
    const id = `s2561-put-${randomUUID()}`;
    await makeAuthorSkill(id);
    const succ = `s2561-put-succ-${randomUUID()}`;
    const res = await send(writer, "PUT", `/Memory/${succ}`, {
      id: succ, agentId: writer.id, supersedes: id, tags: ["skill"], durability: "persistent", summary: `rotated ${TOKEN}`,
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const body = JSON.parse(text);
    expect(body.id).toBe(succ);
    expect(body.redactedValues).toBe(1);
    expect(body.stored).toEqual({ summary: `rotated ${REDACTED}` });
    expectNoAuthorText(text);
    await expectSuccessorCarriesAuthorText(succ, id);
  }, 60_000);

  it("POST /Memory: `stored` is the redacted summary the request supplied, and nothing else", async () => {
    const id = `s2561-post-${randomUUID()}`;
    await makeAuthorSkill(id);
    const res = await send(writer, "POST", `/Memory`, {
      agentId: writer.id, supersedes: id, tags: ["skill"], durability: "persistent", summary: `rotated ${TOKEN}`,
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBeLessThan(300);
    const body = JSON.parse(text);
    expect(body.redactedValues).toBe(1);
    expect(body.stored).toEqual({ summary: `rotated ${REDACTED}` });
    expectNoAuthorText(text);
    await expectSuccessorCarriesAuthorText(String(body.id), id);
  }, 60_000);

  it("POST /FeedMemories: the response holds the redacted summary the request supplied, no content and no trigger", async () => {
    const id = `s2561-feed-${randomUUID()}`;
    await makeAuthorSkill(id);
    const res = await send(writer, "POST", `/FeedMemories`, {
      agentId: writer.id, supersedes: id, tags: ["skill"], durability: "persistent", summary: `rotated ${TOKEN}`,
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const body = JSON.parse(text);
    expect(body.redactedValues).toBe(1);
    expect(body.summary).toBe(`rotated ${REDACTED}`);
    expect("content" in body).toBe(false);
    expect("trigger" in body).toBe(false);
    expectNoAuthorText(text);
    await expectSuccessorCarriesAuthorText(String(body.id), id);
  }, 60_000);

  it("POST /FeedMemories with nothing to redact: of the text fields, the response still holds only the one the request supplied", async () => {
    const id = `s2561-feed-clean-${randomUUID()}`;
    await makeAuthorSkill(id);
    const res = await send(writer, "POST", `/FeedMemories`, {
      agentId: writer.id, supersedes: id, tags: ["skill"], durability: "persistent", summary: "rotated, plain",
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const body = JSON.parse(text);
    expect(body.redactedValues).toBeUndefined();
    expect(body.summary).toBe("rotated, plain");
    expect("content" in body).toBe(false);
    expect("trigger" in body).toBe(false);
    expectNoAuthorText(text);
    await expectSuccessorCarriesAuthorText(String(body.id), id);
  }, 60_000);
});

describe("flair#2561 — a write that supplies every text field gets all three back, as stored", () => {
  const all = (tag: string) => ({
    content: `${tag} content ${TOKEN} end`, summary: `${tag} summary ${AWS_KEY}`, trigger: `${tag} trigger ${SLACK_TOKEN}`,
  });
  const allRedacted = (tag: string) => ({
    content: `${tag} content ${REDACTED} end`, summary: `${tag} summary ${REDACTED}`, trigger: `${tag} trigger ${REDACTED}`,
  });

  it("POST /Memory and PUT /Memory/<id> of the author's own memory", async () => {
    const id = `s2561-own-${randomUUID()}`;
    const post = await send(author, "POST", "/Memory", { id, agentId: author.id, ...all("post"), visibility: "shared" });
    expect(post.status).toBe(201);
    const postBody = await post.json();
    expect(postBody.redactedValues).toBe(3);
    expect(postBody.stored).toEqual(allRedacted("post"));

    const put = await send(author, "PUT", `/Memory/${id}`, { id, agentId: author.id, ...all("put"), visibility: "shared" });
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.redactedValues).toBe(3);
    expect(putBody.stored).toEqual(allRedacted("put"));
    const row = await readStored(id);
    expect({ content: row?.content, summary: row?.summary, trigger: row?.trigger }).toEqual(putBody.stored);
  }, 60_000);

  it("PUT /Memory/<id> of the author's own skill successor", async () => {
    const id = `s2561-own-skill-${randomUUID()}`;
    await makeAuthorSkill(id);
    const succ = `s2561-own-skill-succ-${randomUUID()}`;
    const res = await send(author, "PUT", `/Memory/${succ}`, {
      id: succ, agentId: author.id, supersedes: id, tags: ["skill"], durability: "persistent", ...all("skill"),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.redactedValues).toBe(3);
    expect(body.stored).toEqual(allRedacted("skill"));
    const row = await readStored(succ);
    expect(row?.supersedes).toBe(id);
    expect({ content: row?.content, summary: row?.summary, trigger: row?.trigger }).toEqual(body.stored);
  }, 60_000);

  it("POST /FeedMemories of the author's own memory", async () => {
    const tag = `feed-${randomUUID()}`;
    const res = await send(author, "POST", "/FeedMemories", { agentId: author.id, ...all(tag), durability: "permanent" });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.redactedValues).toBe(3);
    expect({ content: body.content, summary: body.summary, trigger: body.trigger }).toEqual(allRedacted(tag));
    const row = await readStored(String(body.id));
    expect({ content: row?.content, summary: row?.summary, trigger: row?.trigger }).toEqual(allRedacted(tag));
  }, 60_000);
});

describe("flair#2561 — a write that supplies one text field gets back only that field", () => {
  it("PATCH /Memory/<id> of one field over a row holding all three", async () => {
    const id = `s2561-patch-${randomUUID()}`;
    const put = await send(author, "PUT", `/Memory/${id}`, {
      id, agentId: author.id, content: "patch base content", summary: "patch base summary", trigger: "patch base trigger", visibility: "shared",
    });
    expect(put.status).toBe(200);
    const res = await send(author, "PATCH", `/Memory/${id}`, { content: `patched ${TOKEN}` });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.redactedValues).toBe(1);
    expect(body.stored).toEqual({ content: `patched ${REDACTED}` });
    const row = await readStored(id);
    expect([row?.content, row?.summary, row?.trigger]).toEqual([`patched ${REDACTED}`, "patch base summary", "patch base trigger"]);
  }, 60_000);

  it("PUT /Memory/<id> that supplies only content over a row that held a summary and a trigger", async () => {
    const id = `s2561-put-one-${randomUUID()}`;
    const first = await send(author, "PUT", `/Memory/${id}`, {
      id, agentId: author.id, content: "put base content", summary: "put base summary", trigger: "put base trigger", visibility: "shared",
    });
    expect(first.status).toBe(200);
    const res = await send(author, "PUT", `/Memory/${id}`, { id, agentId: author.id, content: `replaced ${TOKEN}`, visibility: "shared" });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.redactedValues).toBe(1);
    expect(body.stored).toEqual({ content: `replaced ${REDACTED}` });
  }, 60_000);
});

describe("flair#2561 — the feed response reports the allowlisted primitive Memory attributes the request supplied plus the listed response fields and `redactedValues` when present, and no write response holds an embedding key", () => {
  it("a feed skill successor that omits the descriptive fields gets none of them, and no embedding", async () => {
    const id = `s2561-feed-desc-${randomUUID()}`;
    await makeAuthorSkill(id);
    const request = { agentId: writer.id, supersedes: id, tags: ["skill"], durability: "persistent", summary: "rotated, plain" };
    const res = await send(writer, "POST", `/FeedMemories`, request);
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const body = JSON.parse(text);
    const allowed = new Set([...Object.keys(request), ...FEED_WRITE_FIELDS]);
    expect(Object.keys(body).filter((key) => !allowed.has(key)), "fields the request did not supply").toEqual([]);
    for (const field of ["metadata", "subject", "source", "sessionId", "content", "trigger", "contentHash", "_safetyFlags"]) {
      expect(field in body, field).toBe(false);
    }
    expectNoEmbedding("feed successor", body);
    expectNoAuthorText(text);
    expect(body.summary).toBe("rotated, plain");
    expect(body.tags).toBeUndefined();
    await expectSuccessorCarriesAuthorText(String(body.id), id);
    expect(Array.isArray((await readStored(String(body.id)))?.embedding)).toBe(true);
  }, 60_000);

  it("no Memory or feed write response carries an embedding field", async () => {
    const seen: Array<[string, unknown]> = [];
    const call = async (label: string, who: TestAgent, method: string, path: string, body: unknown): Promise<any> => {
      const res = await send(who, method, path, body);
      const text = await res.text();
      expect(res.status, `${label} ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
      const parsed = text ? JSON.parse(text) : {};
      seen.push([label, parsed]);
      return parsed;
    };
    const id = `s2561-emb-${randomUUID()}`;
    await call("POST", author, "POST", "/Memory", { id, agentId: author.id, content: "an embedded note", visibility: "shared" });
    await call("PUT update", author, "PUT", `/Memory/${id}`, { id, agentId: author.id, content: "an embedded note, changed", visibility: "shared" });
    await call("PUT redacted", author, "PUT", `/Memory/${id}`, { id, agentId: author.id, content: `an embedded note ${TOKEN}`, visibility: "shared" });
    await call("PATCH redacted", author, "PATCH", `/Memory/${id}`, { content: `patched ${TOKEN}` });
    expect(Array.isArray((await readStored(id))?.embedding)).toBe(true);
    const skill = `s2561-emb-skill-${randomUUID()}`;
    await call("skill PUT", author, "PUT", `/Memory/${skill}`, {
      id: skill, agentId: author.id, content: "skill body", trigger: "when embedding", tags: ["skill"], durability: "persistent",
    });
    await call("skill successor PUT", author, "PUT", `/Memory/${skill}-next`, {
      id: `${skill}-next`, agentId: author.id, supersedes: skill, content: `skill body ${TOKEN}`, tags: ["skill"], durability: "persistent",
    });
    await call("skill POST", author, "POST", "/Memory", { agentId: author.id, content: "skill three", trigger: "t3", tags: ["skill"], durability: "persistent" });
    const feedContent = `a feed note ${randomUUID()}`;
    await call("feed", author, "POST", "/FeedMemories", { agentId: author.id, content: feedContent, durability: "permanent" });
    await call("feed match", author, "POST", "/FeedMemories", { agentId: author.id, content: feedContent, durability: "permanent" });
    const owned = `s2561-emb-owned-${randomUUID()}`;
    await makeAuthorSkill(owned);
    await call("feed successor", writer, "POST", "/FeedMemories", { agentId: writer.id, supersedes: owned, tags: ["skill"], durability: "persistent", summary: "s" });
    expect(seen.length).toBe(10);
    for (const [label, body] of seen) expectNoEmbedding(label, body);
  }, 60_000);
});

describe("flair#2561 — the re-embed PATCH and the admin `_reindex` re-PUT answer with no embedding field", () => {
  it("a re-embed PATCH answers { id, updatedAt }; the stored row holds the new embedding and its model", async () => {
    const id = `s2561-reembed-${randomUUID()}`;
    const post = await send(author, "POST", "/Memory", { id, agentId: author.id, content: "a note to re-embed", visibility: "shared" });
    expect(post.status).toBe(201);
    const res = await send(author, "PATCH", `/Memory/${id}`, { embedding: null, embeddingModel: null });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["id", "updatedAt"]);
    expect(body.id).toBe(id);
    expectNoEmbedding("re-embed PATCH", body);
    const row = await readStored(id);
    expect(Array.isArray(row?.embedding)).toBe(true);
    expect(typeof row?.embeddingModel).toBe("string");
    expect(row?.updatedAt).toBe(body.updatedAt);
  }, 60_000);

  it("an admin `_reindex` re-PUT answers with no embedding field; the stored row keeps its embedding", async () => {
    const id = `s2561-reindex-${randomUUID()}`;
    const post = await send(author, "POST", "/Memory", { id, agentId: author.id, content: "a note to reindex", visibility: "shared" });
    expect(post.status).toBe(201);
    const before = await readStored(id);
    expect(Array.isArray(before?.embedding)).toBe(true);
    // The stored row as the MemoryReindex write-back sends it, embedding included.
    const res = await send(admin, "PUT", `/Memory/${id}`, { ...before, _reindex: true });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBeLessThan(300);
    const body = text ? JSON.parse(text) : {};
    expectNoEmbedding("_reindex re-PUT", body);
    const after = await readStored(id);
    expect(after?.embedding).toEqual(before?.embedding);
    expect(after?.embeddingModel).toBe(before?.embeddingModel);
  }, 60_000);
});
