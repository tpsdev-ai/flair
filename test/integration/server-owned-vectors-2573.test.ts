/**
 * server-owned-vectors-2573.test.ts — flair#2573 slice 2 (real Harper).
 *
 * A non-admin agent's Memory write never stores a vector the caller supplied. A
 * non-admin POST, PUT or PATCH that carries a non-empty `embedding` discards the vector and
 * its `embeddingModel` stamp before the write, so the write stores the vector the
 * server computes for the row's own post-redaction text, or none when the model is
 * unavailable — exactly as a write that sent no vector. An administrator keeps the
 * vector it carries. `embedding: null` and `[]` are unchanged.
 *
 * Cases (one Harper with a working embedding engine):
 *   (a) an agent POST, PUT and PATCH, each carrying a crafted all-ones vector,
 *       stores the SERVER's vector for the row's text with the server's
 *       `embeddingModel` — never the crafted one;
 *   (b) an administrator's POST keeps the supplied vector unchanged;
 *   (c) an agent POST of `embedding: []` stores no empty array;
 *   (d) an agent PATCH of `embedding: null` clears the stored vector.
 * On a second Harper whose embedding backend fails (its model file is absent, so
 * getEmbedding returns null):
 *   (e) an agent POST/PUT/PATCH of a crafted vector stores NO vector and no stamp;
 * then copying the real model file to the path the instance registered, the
 *   (f) auto-embed backfill embeds the vectorless row and stamps it.
 *
 * Throwaway HOME, ephemeral ports. Each spawned Harper is this test's own
 * instance; see assertOwnInstance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The stamp the spawned instance writes when it embeds. Same env, same value. */
const CURRENT_STAMP = getModelId();

const MODEL_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";
function modelFile(): string | null {
  const dirs = [process.env.FLAIR_MODELS_DIR, join(process.cwd(), "models")].filter(Boolean) as string[];
  for (const d of dirs) {
    const p = join(d, MODEL_FILE);
    if (existsSync(p)) return p;
  }
  return null;
}
const HAS_MODEL = modelFile() !== null;

const DIM = 768;
/** A crafted vector: every entry 1. Never the server's vector for any text. */
const CRAFTED = () => new Array<number>(DIM).fill(1);

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
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** A harness around one spawned Harper: signed agent/admin writes, an admin read. */
function makeHarness(get: () => HarperInstance) {
  const agent = mkAgent("agent-a");
  const adminAgent = mkAgent("agent-admin-a");
  const basicAuth = () => "Basic " + btoa(`${get().admin.username}:${get().admin.password}`);
  async function adminOp(op: Record<string, unknown>): Promise<Response> {
    return fetch(get().opsURL, {
      signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth() },
      body: JSON.stringify(op),
    });
  }
  async function write(method: "POST" | "PUT" | "PATCH", id: string, body: Record<string, unknown>, who: TestAgent = agent): Promise<Response> {
    const path = method === "POST" ? "/Memory" : `/Memory/${id}`;
    return fetch(`${get().httpURL}${path}`, {
      signal: AbortSignal.timeout(15_000),
      method,
      headers: { Authorization: ed25519Header(who, method, path), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function basicWrite(method: "POST" | "PUT", id: string, body: Record<string, unknown>): Promise<Response> {
    const path = method === "POST" ? "/Memory" : `/Memory/${id}`;
    return fetch(`${get().httpURL}${path}`, {
      signal: AbortSignal.timeout(15_000),
      method,
      headers: { Authorization: basicAuth(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function row(id: string): Promise<any> {
    const res = await adminOp({
      operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"],
    });
    expect(res.status).toBe(200);
    const rows = await res.json() as any[];
    return rows.find((r: any) => r.id === id) ?? null;
  }
  /** The server's own vector for `text`: an administrator's full-row write of a
   *  probe row that carries no embedding, which the write's embed step computes. */
  async function serverVectorFor(text: string): Promise<number[]> {
    const id = `probe-${randomUUID()}`;
    const res = await basicWrite("PUT", id, { id, agentId: agent.id, content: text, visibility: "shared" });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const r = await row(id);
    expect(Array.isArray(r?.embedding), "the probe row carries no server vector").toBe(true);
    return r.embedding as number[];
  }
  async function register(): Promise<void> {
    const insert = await adminOp({
      operation: "insert", database: "flair", table: "Agent",
      records: [
        { id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() },
        { id: adminAgent.id, name: adminAgent.id, role: "admin", publicKey: adminAgent.publicKey, createdAt: new Date().toISOString() },
      ],
    });
    expect(insert.status).toBe(200);
  }
  return { agent, adminAgent, adminOp, write, basicWrite, row, serverVectorFor, register };
}

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

(HAS_MODEL ? describe : describe.skip)("flair#2573 slice 2 — a non-admin write never stores a caller-supplied vector (real Harper)", () => {
  let harper: HarperInstance;
  let h: ReturnType<typeof makeHarness>;
  const TXT = (tag: string) => `a note about scheduling cron jobs across time zones ${tag}`;

  beforeAll(async () => {
    harper = await startHarper({ cwd: ROOT });
    assertOwnInstance(harper);
    h = makeHarness(() => harper);
    await h.register();
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, HARPER_STOP_BUDGET_MS);

  test("(a-post) an agent POST of a crafted vector stores the server's vector for the text", async () => {
    const id = `s2-post-${randomUUID()}`;
    const res = await h.write("POST", id, { id, agentId: h.agent.id, content: TXT("post"), visibility: "shared", embedding: CRAFTED() });
    expect(res.status, await res.clone().text()).toBe(201);
    const r = await h.row(id);
    expect(r.embedding).not.toEqual(CRAFTED());
    expect(r.embeddingModel, "the stored stamp is the server's model").toBe(CURRENT_STAMP);
    expect(Array.isArray(r.embedding) && r.embedding.length > 100, "the server embedded the text").toBe(true);
    const expected = await h.serverVectorFor(TXT("post"));
    expect(cosine(r.embedding, expected), "the stored vector is the server's vector for the text").toBeGreaterThan(0.9999);
  }, 60_000);

  test("(a-put) an agent PUT of a crafted vector stores the server's vector for the text", async () => {
    const id = `s2-put-${randomUUID()}`;
    const res = await h.write("PUT", id, { id, agentId: h.agent.id, content: TXT("put"), visibility: "shared", embedding: CRAFTED() });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const r = await h.row(id);
    expect(r.embedding).not.toEqual(CRAFTED());
    expect(r.embeddingModel).toBe(CURRENT_STAMP);
    const expected = await h.serverVectorFor(TXT("put"));
    expect(cosine(r.embedding, expected)).toBeGreaterThan(0.9999);
  }, 60_000);

  test("(a-patch) an agent PATCH of a crafted vector stores the server's vector for the new text", async () => {
    const id = `s2-patch-${randomUUID()}`;
    const created = await h.write("POST", id, { id, agentId: h.agent.id, content: TXT("before"), visibility: "shared" });
    expect(created.status, await created.clone().text()).toBe(201);
    const res = await h.write("PATCH", id, { content: TXT("after"), embedding: CRAFTED() });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const r = await h.row(id);
    expect(r.content).toBe(TXT("after"));
    expect(r.embedding).not.toEqual(CRAFTED());
    expect(r.embeddingModel).toBe(CURRENT_STAMP);
    const expected = await h.serverVectorFor(TXT("after"));
    expect(cosine(r.embedding, expected)).toBeGreaterThan(0.9999);
  }, 60_000);

  test("(b) an administrator's write keeps the vector it carries", async () => {
    const crafted = CRAFTED();
    const id = `s2-admin-${randomUUID()}`;
    const res = await h.write("POST", id, { id, agentId: h.agent.id, content: TXT("admin"), visibility: "shared", embedding: crafted }, h.adminAgent);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const r = await h.row(id);
    expect(r.embedding, "an administrator's supplied vector is stored unchanged").toEqual(crafted);
  }, 60_000);

  test("(c) an agent POST of `embedding: []` stores no empty array", async () => {
    const id = `s2-empty-${randomUUID()}`;
    const res = await h.write("POST", id, { id, agentId: h.agent.id, content: TXT("empty"), visibility: "shared", embedding: [] });
    expect(res.status, await res.clone().text()).toBe(201);
    const r = await h.row(id);
    expect(r.embedding).not.toEqual([]);
  }, 60_000);

  test("(d) an agent PATCH of `embedding: null` clears the stored vector", async () => {
    const id = `s2-null-${randomUUID()}`;
    const created = await h.write("POST", id, { id, agentId: h.agent.id, content: TXT("null patch"), visibility: "shared" });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(Array.isArray((await h.row(id)).embedding)).toBe(true);
    const res = await h.write("PATCH", id, { embedding: null });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const r = await h.row(id);
    expect(r.embedding ?? null, "`embedding: null` clears the stored vector").toBeNull();
  }, 60_000);
});

describe("flair#2573 slice 2 — a crafted vector with no embedding model stores no vector (real Harper)", () => {
  let harper: HarperInstance;
  let h: ReturnType<typeof makeHarness>;
  let homeDir = "";
  let absentPath = "";
  const TXT = (tag: string) => `a note the model cannot embed yet ${tag}`;

  beforeAll(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "flair-2573s2-nomodel-"));
    // resources/embeddings-boot.ts registers the embedding backend from this
    // absolute path (its bench-only model-path override); the file does not exist
    // yet, so every embed fails and getEmbedding returns null.
    absentPath = join(homeDir, "absent-model", "nomic-embed-text-absent.gguf");
    harper = await startHarper({ cwd: ROOT, env: { FLAIR_RECALL_HARNESS_MODEL_PATH: absentPath } });
    assertOwnInstance(harper);
    h = makeHarness(() => harper);
    await h.register();
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  }, HARPER_STOP_BUDGET_MS);

  test("(e) agent POST, PUT and PATCH of a crafted vector each store no vector", async () => {
    const post = `s2-nomodel-post-${randomUUID()}`;
    const put = `s2-nomodel-put-${randomUUID()}`;
    const patch = `s2-nomodel-patch-${randomUUID()}`;
    // Seed the PATCH target first: a PATCH to a missing id is refused for a
    // non-admin, so the crafted-vector PATCH must exercise an update.
    const seed = await h.write("POST", patch, { id: patch, agentId: h.agent.id, content: TXT("patch seed"), visibility: "shared" });
    expect(seed.status, await seed.clone().text()).toBe(201);
    const postRes = await h.write("POST", post, { id: post, agentId: h.agent.id, content: TXT("post"), visibility: "shared", embedding: CRAFTED() });
    expect(postRes.status, await postRes.clone().text()).toBe(201);
    const putRes = await h.write("PUT", put, { id: put, agentId: h.agent.id, content: TXT("put"), visibility: "shared", embedding: CRAFTED() });
    expect(putRes.status, await putRes.clone().text()).toBeLessThan(300);
    const patchRes = await h.write("PATCH", patch, { content: TXT("patch"), embedding: CRAFTED() });
    expect(patchRes.status, await patchRes.clone().text()).toBeLessThan(300);
    for (const id of [post, put, patch]) {
      const r = await h.row(id);
      expect(r, `${id} was not stored`).not.toBeNull();
      expect(r.embedding ?? null, `${id}: no vector is stored when the model is unavailable`).toBeNull();
      expect(r.embeddingModel ?? null, `${id}: no model stamp is stored`).toBeNull();
    }
  }, 120_000);

  (HAS_MODEL ? test : test.skip)("(f) the backfill embeds the vectorless row and stamps it once the model is available", async () => {
    const id = `s2-backfill-${randomUUID()}`;
    const post = await h.write("POST", id, { id, agentId: h.agent.id, content: TXT("backfill"), visibility: "shared", embedding: CRAFTED() });
    expect(post.status, await post.clone().text()).toBe(201);
    expect((await h.row(id)).embedding ?? null).toBeNull();

    // Make the registered model path resolvable now: copy the real model file to
    // exactly where this instance resolves it, so its next load attempt succeeds.
    const real = modelFile()!;
    mkdirSync(dirname(absentPath), { recursive: true });
    copyFileSync(real, absentPath);

    // A further agent write to the id in the URL starts the auto-embed backfill.
    const trigger = await h.write("PATCH", id, { tags: ["embed-now"] });
    expect(trigger.status, await trigger.clone().text()).toBeLessThan(300);
    const deadline = Date.now() + 60_000;
    let r = await h.row(id);
    while ((r.embedding ?? null) === null && Date.now() < deadline) {
      await Bun.sleep(200);
      r = await h.row(id);
    }
    expect(Array.isArray(r.embedding) && r.embedding.length > 100, "the backfill did not embed the vectorless row").toBe(true);
    expect(r.embeddingModel).toBe(CURRENT_STAMP);
    expect(r.embedding).not.toEqual(CRAFTED());
  }, 180_000);
});
