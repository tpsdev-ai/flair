/**
 * server-owned-vectors-2573.test.ts — flair#2573 slice 2 (real Harper).
 *
 * Non-admin Memory writes discard caller-supplied vectors and model stamps.
 * Embedding is computed when the resulting write needs one.
 * Administrator and trusted in-process writes are unchanged.
 * Empty-vector normalization and the re-embed request protocol are unchanged;
 * an ordinary non-admin write strips a supplied stamp even alongside a null or empty embedding.
 *
 * Cases (one Harper with a working embedding engine):
 *   (a) an agent POST, PUT and PATCH, each carrying a crafted all-ones vector,
 *       stores the SERVER's vector for the row's text with the server's
 *       `embeddingModel` — never the crafted one;
 *   (b) an administrator's POST keeps the supplied vector unchanged;
 *   (c) an agent POST of `embedding: []` stores no empty array;
 *   (d) an agent PATCH of `embedding: null` clears the stored vector;
 *   (e) an agent vector-only PATCH discards the supplied vector and retains the
 *       stored one (the PATCH changes no text, so it computes no vector).
 * On a second Harper whose embedding backend fails (its model file is absent, so
 * getEmbedding returns null):
 *   (f) an agent POST/PUT/PATCH of a crafted vector and a forged stamp stores NO
 *       vector and no stamp;
 *   (g) then copying the real model file to the path the instance registered, the
 *       auto-embed backfill embeds the vectorless row and stamps it.
 * A third Harper shows the vector-space control itself:
 *   (h) an agent stamp-only PATCH leaves a foreign-stamped (and an unstamped)
 *       stored vector's stamp unchanged, so the row stays excluded from vector
 *       recall;
 *   (i) an agent skill PUT that carries a stored vector keeps the vector's stored
 *       stamp, never the caller's;
 *   (j) a signed non-admin array POST is refused and stores no row;
 *   (k) an administrator stamp-only skill PUT keeps the administrator's stamp.
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
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

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
/** A crafted vector: every entry is 1. */
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
  /** Seed a Memory row directly, as a raw operator insert would: it bypasses the
   *  resource writers, so it can plant a stored vector with a foreign or absent
   *  stamp that no writer accepts from a non-admin. */
  async function seed(record: Record<string, unknown>): Promise<void> {
    const res = await adminOp({ operation: "insert", database: "flair", table: "Memory", records: [record] });
    expect(res.status, `seed ${record.id}: ${(await res.clone().text()).slice(0, 300)}`).toBe(200);
  }
  /** /Health carries the embedding-space guard's published verdict. */
  async function health(): Promise<any> {
    const res = await fetch(`${get().httpURL}/Health`, { signal: AbortSignal.timeout(15_000) });
    expect([200, 503]).toContain(res.status);
    return res.json();
  }
  /** A recall consult makes the guard rescan a stale or unknown count. */
  async function semanticSearch(body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${get().httpURL}/SemanticSearch`, {
      signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", "/SemanticSearch"), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, ...body }),
    });
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    return res.json();
  }
  async function consult(): Promise<void> {
    await semanticSearch({ queryEmbedding: CRAFTED(), limit: 1 });
  }
  /** Poll /Health, consulting the guard each round, until `want` holds or time is up. */
  async function waitGuard(want: (space: any) => boolean, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let space: any;
    while (Date.now() < deadline) {
      space = (await health()).embeddingSpace;
      if (space && want(space)) return space;
      await consult();
      await Bun.sleep(150);
    }
    return space;
  }
  return { agent, adminAgent, adminOp, write, basicWrite, row, serverVectorFor, register, seed, health, semanticSearch, consult, waitGuard };
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

  test("(e) an agent vector-only PATCH discards the supplied vector and retains the stored one", async () => {
    const id = `s2-vectoronly-${randomUUID()}`;
    const created = await h.write("POST", id, { id, agentId: h.agent.id, content: TXT("vector only"), visibility: "shared" });
    expect(created.status, await created.clone().text()).toBe(201);
    const seeded = await h.row(id);
    expect(Array.isArray(seeded.embedding) && seeded.embedding.length > 100, "the seed row carries a server vector").toBe(true);
    const res = await h.write("PATCH", id, { embedding: CRAFTED() });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const r = await h.row(id);
    expect(r.content, "the vector-only PATCH changed no text").toBe(TXT("vector only"));
    expect(r.embedding, "the stored vector is retained, not the caller's").toEqual(seeded.embedding);
    expect(r.embeddingModel).toBe(CURRENT_STAMP);
  }, 60_000);
});

describe("flair#2573 slice 2 — crafted-vector writes with a failed embedding backend (real Harper)", () => {
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

  test("(f) agent POST, PUT and PATCH of a crafted vector and a forged stamp each store no vector and no stamp", async () => {
    const post = `s2-nomodel-post-${randomUUID()}`;
    const put = `s2-nomodel-put-${randomUUID()}`;
    const patch = `s2-nomodel-patch-${randomUUID()}`;
    // Every write below forges BOTH a vector and its stamp, so the no-stamp
    // assertions detect a discarded-stamp line that lets the caller's stamp
    // through (blocker 2).
    const FORGED_STAMP = "forged-model-stamp";
    // Seed the PATCH target first: a PATCH to a missing id is refused for a
    // non-admin, so the crafted-vector PATCH must exercise an update.
    const seed = await h.write("POST", patch, { id: patch, agentId: h.agent.id, content: TXT("patch seed"), visibility: "shared" });
    expect(seed.status, await seed.clone().text()).toBe(201);
    const postRes = await h.write("POST", post, { id: post, agentId: h.agent.id, content: TXT("post"), visibility: "shared", embedding: CRAFTED(), embeddingModel: FORGED_STAMP });
    expect(postRes.status, await postRes.clone().text()).toBe(201);
    const putRes = await h.write("PUT", put, { id: put, agentId: h.agent.id, content: TXT("put"), visibility: "shared", embedding: CRAFTED(), embeddingModel: FORGED_STAMP });
    expect(putRes.status, await putRes.clone().text()).toBeLessThan(300);
    const patchRes = await h.write("PATCH", patch, { content: TXT("patch"), embedding: CRAFTED(), embeddingModel: FORGED_STAMP });
    expect(patchRes.status, await patchRes.clone().text()).toBeLessThan(300);
    for (const id of [post, put, patch]) {
      const r = await h.row(id);
      expect(r, `${id} was not stored`).not.toBeNull();
      expect(r.embedding ?? null, `${id}: no vector is stored when the model is unavailable`).toBeNull();
      expect(r.embeddingModel ?? null, `${id}: the caller's stamp is not stored`).toBeNull();
    }
  }, 120_000);

  (HAS_MODEL ? test : test.skip)("(g) the backfill embeds the vectorless row and stamps it once the model is available", async () => {
    const id = `s2-backfill-${randomUUID()}`;
    const post = await h.write("POST", id, { id, agentId: h.agent.id, content: TXT("backfill"), visibility: "shared", embedding: CRAFTED(), embeddingModel: "forged-model-stamp" });
    expect(post.status, await post.clone().text()).toBe(201);
    expect((await h.row(id)).embedding ?? null).toBeNull();
    expect((await h.row(id)).embeddingModel ?? null).toBeNull();

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

describe("flair#2573 slice 2 — a non-admin write cannot relabel a stored vector (real Harper)", () => {
  let harper: HarperInstance;
  let h: ReturnType<typeof makeHarness>;
  const FOREIGN_STAMP = "foreign-model-not-current";

  beforeAll(async () => {
    harper = await startHarper({ cwd: ROOT });
    assertOwnInstance(harper);
    h = makeHarness(() => harper);
    await h.register();
    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, HARPER_STOP_BUDGET_MS);

  /** Seed a foreign or unstamped vector through an administrator PUT using Basic auth. */
  async function seedVector(id: string, stamp: string | null): Promise<void> {
    const res = await h.basicWrite("PUT", id, {
      id, agentId: h.agent.id, content: `stored text for ${id}`, visibility: "shared", durability: "standard",
      embedding: CRAFTED(), ...(stamp === null ? {} : { embeddingModel: stamp }),
    });
    expect(res.status, `seed ${id}: ${(await res.clone().text()).slice(0, 300)}`).toBeLessThan(300);
  }

  test("(h) an agent stamp-only PATCH leaves a foreign-stamped stored vector's stamp unchanged and the row excluded", async () => {
    const id = `s2-relabel-foreign-${randomUUID()}`;
    await seedVector(id, FOREIGN_STAMP);
    const ids = (r: any) => (r.results ?? []).map((x: any) => x.id);
    expect(ids(await h.semanticSearch({ queryEmbedding: CRAFTED(), limit: 50 })), "the seeded foreign vector is not recalled").not.toContain(id);
    const res = await h.write("PATCH", id, { embeddingModel: CURRENT_STAMP });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const r = await h.row(id);
    expect(r.embedding, "the stored vector is unchanged").toEqual(CRAFTED());
    expect(r.embeddingModel, "the caller's stamp never relabels a stored vector").toBe(FOREIGN_STAMP);
    expect(ids(await h.semanticSearch({ queryEmbedding: CRAFTED(), limit: 50 })), "the row stays excluded from vector recall").not.toContain(id);
  }, 120_000);

  test("(h) an agent stamp-only PATCH leaves an unstamped stored vector's stamp absent and the row excluded", async () => {
    const id = `s2-relabel-unstamped-${randomUUID()}`;
    await seedVector(id, null);
    const ids = (r: any) => (r.results ?? []).map((x: any) => x.id);
    expect(ids(await h.semanticSearch({ queryEmbedding: CRAFTED(), limit: 50 })), "the seeded unstamped vector is not recalled").not.toContain(id);
    const res = await h.write("PATCH", id, { embeddingModel: CURRENT_STAMP });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const r = await h.row(id);
    expect(r.embedding, "the stored vector is unchanged").toEqual(CRAFTED());
    expect(r.embeddingModel ?? null, "the caller's stamp is not stored").toBeNull();
    expect(ids(await h.semanticSearch({ queryEmbedding: CRAFTED(), limit: 50 })), "the row stays excluded from vector recall").not.toContain(id);
  }, 120_000);

  test("(i) an agent skill PUT that carries a stored vector keeps the vector's stored stamp", async () => {
    const id = `s2-relabel-skill-${randomUUID()}`;
    const trigger = `when the stored skill ${id} runs`;
    await h.seed({
      id, agentId: h.agent.id, content: `skill body ${id}`, trigger, tags: ["skill"], durability: "persistent",
      visibility: "shared", skillSubjectId: id, createdAt: new Date().toISOString(), instanceToken: randomUUID(),
      embedding: CRAFTED(), embeddingModel: FOREIGN_STAMP,
    });
    const body = { id, agentId: h.agent.id, content: `skill body ${id}`, trigger, tags: ["skill"], durability: "persistent", embeddingModel: CURRENT_STAMP };
    // Right after boot the InstructionVersion per-key lock can answer 503; retry
    // that one status, bounded.
    let res: Response | null = null;
    let text = "";
    for (let attempt = 0; attempt < 60; attempt++) {
      res = await h.write("PUT", id, body);
      text = await res.clone().text();
      if (res.status !== 503 || !text.includes("instruction_version_lock_unavailable")) break;
      await Bun.sleep(500);
    }
    expect(res!.status, text.slice(0, 300)).toBeLessThan(300);
    const written = JSON.parse(text) as any;
    const target = typeof written.id === "string" ? written.id : id;
    const r = await h.row(target);
    expect(r.embedding, "the carried vector is stored unchanged").toEqual(CRAFTED());
    expect(r.embeddingModel, "a carried vector keeps its stored stamp, never the caller's").toBe(FOREIGN_STAMP);
  }, 180_000);

  test("(k) an administrator stamp-only skill PUT keeps the administrator's stamp", async () => {
    const id = `s2-admin-skill-${randomUUID()}`;
    await h.seed({
      id, agentId: h.agent.id, content: `skill body ${id}`, trigger: `when skill ${id} runs`,
      tags: ["skill"], durability: "persistent", visibility: "shared", skillSubjectId: id,
      createdAt: new Date().toISOString(), instanceToken: randomUUID(),
      embedding: CRAFTED(), embeddingModel: FOREIGN_STAMP,
    });
    const administratorStamp = "administrator-replacement-stamp";
    let res: Response | null = null;
    let text = "";
    for (let attempt = 0; attempt < 60; attempt++) {
      res = await h.basicWrite("PUT", id, { embeddingModel: administratorStamp });
      text = await res.clone().text();
      if (res.status !== 503 || !text.includes("instruction_version_lock_unavailable")) break;
      await Bun.sleep(500);
    }
    expect(res!.status, text.slice(0, 300)).toBeLessThan(300);
    const written = JSON.parse(text) as any;
    const r = await h.row(typeof written.id === "string" ? written.id : id);
    expect(r.embedding).toEqual(CRAFTED());
    expect(r.embeddingModel).toBe(administratorStamp);
  }, 180_000);

  test("(j) a signed non-admin array POST is refused and stores no row", async () => {
    const id = `s2-array-${randomUUID()}`;
    const path = "/Memory";
    const res = await fetch(`${harper.httpURL}${path}`, {
      signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: { Authorization: ed25519Header(h.agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify([{ id, agentId: h.agent.id, content: "array body", visibility: "shared" }]),
    });
    expect(res.status, `array POST returned ${res.status}: ${(await res.clone().text()).slice(0, 300)}`).toBeGreaterThanOrEqual(400);
    const rows = await h.adminOp({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "id", search_value: id, get_attributes: ["id"] });
    expect(rows.status).toBe(200);
    expect(await rows.json(), "the array POST stored nothing").toEqual([]);
  }, 60_000);
});
