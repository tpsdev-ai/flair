/**
 * unstamped-vectors-excluded-2573.test.ts — flair#2573 slice 1 (real Harper).
 *
 * A published scan counts arrays and typed arrays without trusted stamps, including empty ones.
 * Raw operations-API inserts remain uncovered until a rescan. Covers signed
 * Memory PUT/PATCH, dedup, recall, /Health, and doctor's last published count
 * in the `excluded` state.
 * A separate instance runs with FLAIR_RETRIEVAL_MODE=vector-only to show
 * that branch falling back and naming the guard state.
 *
 * Each instance runs from a copy of the built component without
 * `migration-boot.js` (test/helpers/component-without-migration-boot.ts), so the
 * always-on embedding-stamp migration never runs: it would re-embed a no-stamp
 * row and remove the very state under test.
 *
 * Fixture vectors have 768 entries. After a signed Memory write, the auto-embed
 * backfill (resources/auth-middleware.ts) re-embeds from its text a row whose
 * stored vector has at most 100 entries, when an embedding model is available;
 * a shorter fixture vector would be replaced by a server-computed one. Every
 * case outside the vector-only describe holds with and without a model; that
 * describe embeds query text, so it runs only when the model file is present.
 *
 * Mutation checks (each fails on an assertion; restore with a file copy, never
 * git):
 *  - in resources/embedding-space-guard.ts, make the scan not count a stored
 *    vector with no trusted stamp (skip the `excluded++` for a missing stamp),
 *    leaving everything else — the store is then read as uniform, the
 *    near-duplicate query compares vectors, and the excluded count assertions
 *    go red;
 *  - in noteWriteStamp, invalidate the count on every trusted write while the
 *    verdict is non-uniform (drop the known-previous-row exemption) — the
 *    trusted write before the doctor case turns the state `unverified`, and the
 *    doctor case goes red;
 *  - in resources/Memory.ts put(), remove the empty-embedding normalization
 *    before the dedup gate (the later one stays) — the rescan case never
 *    returns to `uniform`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithoutMigrationBoot, type ComposedComponent } from "../helpers/component-without-migration-boot";
import { getModelId } from "../../resources/embeddings-provider.ts";

const AGENT = "agent-a"; // neutral fixture name (no fleet host/agent)
const CLI = join(process.cwd(), "dist", "cli.js");

/** The stamp the spawned instance writes when it embeds. Same env, same value. */
const CURRENT_STAMP = getModelId();

const MODEL_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";
function modelPresent(): boolean {
  const dirs = [process.env.FLAIR_MODELS_DIR, join(process.cwd(), "models")].filter(Boolean) as string[];
  return dirs.some((d) => existsSync(join(d, MODEL_FILE)));
}
const HAS_MODEL = modelPresent();

/** A 768-entry vector with 1 at each `hot` index: longer than the 100 entries
 *  below which the auto-embed backfill replaces a stored vector (header). */
function basis(...hot: number[]): number[] {
  const v = new Array<number>(768).fill(0);
  for (const i of hot) v[i] = 1;
  return v;
}

/** A vector the untrusted row stores and a query can target. */
const UNTRUSTED_VEC = basis(0);
const STAMPED_VEC = basis(0, 1); // cosine 0.7071 against UNTRUSTED_VEC
/** A similarity floor only a near-exact match of UNTRUSTED_VEC clears. */
const EXACT_MATCH = 0.9;

const KEYWORD = "zqxuntrustedkeyword"; // lexical-only token, absent from the stamped rows
const STAMPED_TEXT = "a row the server-stamped vector space covers for the dedup control";

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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A harness around one spawned Harper: agent writes, agent search, /Health. */
function makeHarness(get: () => HarperInstance) {
  const agent = mkAgent(AGENT);
  const basicAuth = () => "Basic " + btoa(`${get().admin.username}:${get().admin.password}`);
  async function adminOp(op: Record<string, unknown>): Promise<Response> {
    return fetch(get().opsURL, {
      signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth() },
      body: JSON.stringify(op),
    });
  }
  async function putMemory(id: string, body: Record<string, unknown>): Promise<any> {
    const path = `/Memory/${id}`;
    const res = await fetch(`${get().httpURL}${path}`, {
      signal: AbortSignal.timeout(15_000),
      method: "PUT",
      headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id, agentId: AGENT, visibility: "shared", ...body }),
    });
    const text = await res.text();
    expect(res.status, `PUT ${path} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    return JSON.parse(text);
  }
  async function memoryRow(id: string): Promise<any> {
    const res = await adminOp({
      operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"],
    });
    expect(res.status).toBe(200);
    const rows = await res.json() as any[];
    expect(rows.length).toBe(1);
    return rows[0];
  }
  async function patchMemory(id: string, body: Record<string, unknown>): Promise<void> {
    const path = `/Memory/${id}`;
    const res = await fetch(`${get().httpURL}${path}`, {
      signal: AbortSignal.timeout(15_000),
      method: "PATCH",
      headers: { Authorization: ed25519Header(agent, "PATCH", path), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    expect(res.status, `PATCH ${path}: ${text.slice(0, 300)}`).toBeLessThan(300);
  }
  async function semanticSearch(body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${get().httpURL}/SemanticSearch`, {
      signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", "/SemanticSearch"), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT, ...body }),
    });
    const text = await res.text();
    expect(res.status, `SemanticSearch returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    return JSON.parse(text);
  }
  async function health(): Promise<any> {
    const res = await fetch(`${get().httpURL}/Health`, { signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    // /Health is 200 once serving and 503 during the boot window; both carry the
    // guard's field (flair#2530).
    expect([200, 503]).toContain(res.status);
    return JSON.parse(text);
  }
  /** A recall consult: any query embedding makes the guard consult and rescans
   *  when the count is stale or unknown. */
  async function consult(): Promise<void> {
    await semanticSearch({ queryEmbedding: UNTRUSTED_VEC, limit: 1 });
  }
  async function waitGuard(want: (space: any) => boolean, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let space: any;
    while (Date.now() < deadline) {
      space = (await health()).embeddingSpace;
      if (space && want(space)) return space;
      await consult();
      await delay(150);
    }
    return space;
  }
  async function doctor(): Promise<string> {
    const home = mkdtempSync(join(tmpdir(), "flair-2573-home-"));
    try {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        HOME: home,
        FLAIR_URL: "",
        FLAIR_TOKEN: "",
        FLAIR_OPS_PORT: String(new URL(get().opsURL).port),
        NO_COLOR: "1",
      };
      delete env.FLAIR_ADMIN_PASS;
      delete env.FLAIR_AGENT_ID;
      const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, "doctor", "--port", String(new URL(get().httpURL).port)], {
          env, timeout: 90_000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
          if (signal !== null) { reject(new Error(`flair doctor overran: ${signal}\n${stdout}`)); return; }
          resolve({ code, stdout, stderr });
        });
      });
      return out.stdout;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  return { agent, adminOp, putMemory, patchMemory, memoryRow, semanticSearch, health, consult, waitGuard, doctor };
}

/** Spawn a Harper from a component copy without migration-boot (header),
 *  register the agent, return the harness. */
async function spawnWithHarness(env?: Record<string, string>):
  Promise<{ harper: HarperInstance; component: ComposedComponent; h: ReturnType<typeof makeHarness> }> {
  const component = componentWithoutMigrationBoot();
  let harper: HarperInstance;
  try {
    harper = await startHarper({ cwd: component.dir, harperBinDir: component.sourceRoot, ...(env ? { env } : {}) });
  } catch (err) {
    component.cleanup();
    throw err;
  }
  expect(harper.external).toBe(false);
  expect(harper.ownsInstallDir).toBe(true);
  const h = makeHarness(() => harper);
  // Register the agent (publicKey) so the ed25519 write/search paths accept it.
  const insert = await h.adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: AGENT, name: AGENT, role: "agent", publicKey: h.agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(insert.status).toBe(200);
  return { harper, component, h };
}

async function stopAndClean(harper: HarperInstance | undefined, component: ComposedComponent | undefined): Promise<void> {
  try {
    if (harper) await stopHarper(harper);
  } finally {
    component?.cleanup();
  }
}

/** `[]` stores no empty array: the row holds no vector, or, with an embedding
 *  model, one the server computed from the row's text (the auto-embed backfill
 *  after a PATCH, the write's own embed after a PUT), recorded with the hash of
 *  that text. */
function expectNoVectorOrServerComputed(row: any): void {
  expect(row.embedding).not.toEqual([]);
  if (row.embedding == null) return;
  expect(Array.isArray(row.embedding)).toBe(true);
  expect(row.embedding.length).toBeGreaterThan(100);
  expect(row.embedding).not.toEqual(UNTRUSTED_VEC);
  expect(typeof row.embeddedContentHash).toBe("string");
}

describe("flair#2573 slice 1 — signed unstamped vector writes close the guard (real Harper)", () => {
  let harper: HarperInstance | undefined;
  let component: ComposedComponent | undefined;
  let h: ReturnType<typeof makeHarness>;
  const A_ID = "mem-2573-stamped-a";
  const B_ID = "mem-2573-stamped-b";
  const C_ID = "mem-2573-stamped-c";
  const U_ID = "mem-2573-unstamped";

  beforeAll(async () => {
    const spawned = await spawnWithHarness();
    harper = spawned.harper;
    component = spawned.component;
    h = spawned.h;
  }, 180_000);

  afterAll(async () => {
    await stopAndClean(harper, component);
  }, 60_000);

  test("control: while the store is uniform the write-time near-duplicate query compares vectors", async () => {
    const space = await h.waitGuard((s) => s.state === "uniform", 60_000);
    expect(space?.state, "the boot scan should verify an empty store uniform").toBe("uniform");
    // The first write has nothing to match.
    await h.putMemory(A_ID, { content: STAMPED_TEXT, embedding: STAMPED_VEC, embeddingModel: CURRENT_STAMP });
    // A near-duplicate of A: same content, same vector. The dedup cosine leg
    // matches it (the store is uniform).
    const b = await h.putMemory(B_ID, { content: STAMPED_TEXT, embedding: STAMPED_VEC, embeddingModel: CURRENT_STAMP });
    expect(b.deduplicated).toBe(true);
    expect(b.matchedId).toBe(A_ID);
  }, 120_000);

  test("a signed PUT of an unstamped vector makes the verdict non-uniform: excluded count, no vector recall, a matching lexical query finds the row", async () => {
    const u = await h.putMemory(U_ID, { content: `a caller-supplied vector of unknown space ${KEYWORD}`, embedding: UNTRUSTED_VEC });
    expect(u.id).toBe(U_ID);
    // The write stored a vector with no stamp: the guard's count is stale, and a
    // consult republishes it as non-uniform.
    const space = await h.waitGuard((s) => s.state === "excluded" && s.excluded === 1, 60_000);
    expect(space?.state, "a signed PUT of an unstamped vector makes the verdict non-uniform").toBe("excluded");
    expect(space?.excluded, "the unstamped vector row must be counted").toBe(1);

    // A vector-only query (a query embedding, no `q`): the embedding leg is
    // refused, so nothing comes back — the untrusted row's perfect cosine match
    // included.
    const vectorOnly = await h.semanticSearch({ queryEmbedding: UNTRUSTED_VEC, limit: 20 });
    expect(vectorOnly.results.length, "the refused embedding leg returns no rows").toBe(0);

    // A matching lexical query finds the same row.
    const lexical = await h.semanticSearch({ q: KEYWORD, limit: 20 });
    const lexIds = lexical.results.map((r: any) => r.content as string);
    expect(lexIds.some((c: string) => c.includes(KEYWORD)), "the matching lexical query finds the row").toBe(true);
  }, 120_000);

  test("the write-time near-duplicate query does not compare vectors while the verdict is non-uniform", async () => {
    const c = await h.putMemory(C_ID, { content: STAMPED_TEXT, embedding: STAMPED_VEC, embeddingModel: CURRENT_STAMP });
    expect(c.written).toBe(true); // the write never stops
    expect(c.deduplicated, "the dedup leg must not use vectors while the verdict is non-uniform").toBe(false);
    expect(c.matchedId).toBeUndefined();
  }, 60_000);

  test("the real flair doctor prints the last published count in excluded", async () => {
    const stdout = await h.doctor();
    expect(stdout).toContain("the last scan found a stored vector with no trusted current-space stamp");
    expect(stdout).toContain("excluded from the vector leg: 1 row(s) with no trusted model stamp");
  }, 120_000);

  test("a trusted repair followed by a consult makes Health and doctor report uniform", async () => {
    expect((await h.health()).embeddingSpace.state).toBe("excluded");
    await h.patchMemory(U_ID, { embedding: STAMPED_VEC, embeddingModel: CURRENT_STAMP });
    const repaired = await h.memoryRow(U_ID);
    expect(repaired.embedding).toEqual(STAMPED_VEC);
    expect(repaired.embeddingModel).toBe(CURRENT_STAMP);
    await h.consult();
    const space = await h.waitGuard((s) => s.state === "uniform" && s.excluded === 0, 60_000);
    expect(space).toEqual({ state: "uniform", reason: null, excluded: 0 });
    const stdout = await h.doctor();
    expect(stdout).toContain("embedding model stamps verified uniform");
    expect(stdout).not.toContain("excluded from the vector leg:");
  }, 240_000);

});

describe("flair#2573 slice 1 — PATCH guard notifications (real Harper)", () => {
  let harper: HarperInstance | undefined;
  let component: ComposedComponent | undefined;
  let h: ReturnType<typeof makeHarness>;
  const A_ID = "mem-2573-patch";

  beforeAll(async () => {
    const spawned = await spawnWithHarness();
    harper = spawned.harper;
    component = spawned.component;
    h = spawned.h;
  }, 180_000);

  afterAll(async () => {
    await stopAndClean(harper, component);
  }, 60_000);

  test("signed PATCH of an empty embedding clears the stored vector, preserves uniform, and removes the row from the vector's matches", async () => {
    const id = "mem-2573-empty-patch";
    await h.putMemory(id, { content: "empty vector boundary fixture", embedding: UNTRUSTED_VEC, embeddingModel: CURRENT_STAMP });
    const before = await h.waitGuard((s) => s.state === "uniform", 60_000);
    expect(before?.state).toBe("uniform");
    const exactMatches = async () =>
      (await h.semanticSearch({ queryEmbedding: UNTRUSTED_VEC, limit: 20, minScore: EXACT_MATCH })).results.map((r: any) => r.id);
    expect(await exactMatches()).toContain(id);
    // PATCH `embedding: []` is `embedding: null`: the stored vector is cleared,
    // never kept. With a model, the auto-embed backfill then recomputes one from
    // the row's text; the PATCH leaves the stamp as it was (current).
    await h.patchMemory(id, { embedding: [] });
    const row = await h.memoryRow(id);
    expectNoVectorOrServerComputed(row);
    expect(row.embeddingModel).toBe(CURRENT_STAMP);
    expect((await h.health()).embeddingSpace).toEqual(before);
    await h.consult();
    expect((await h.health()).embeddingSpace).toEqual(before);
    expect(await exactMatches()).not.toContain(id);
    // Read again after the consult and search: a backfill that landed since holds.
    const later = await h.memoryRow(id);
    expectNoVectorOrServerComputed(later);
    expect(later.embeddingModel).toBe(CURRENT_STAMP);
    expect((await h.health()).embeddingSpace).toEqual(before);
  }, 120_000);

  test("the returned-set filter admits qualified and bare current stamps and rejects a null stamp while uniform", async () => {
    const id = "mem-2573-filter";
    const control = "mem-2573-filter-control";
    await h.putMemory(control, { content: "vector condition control fixture", embedding: STAMPED_VEC, embeddingModel: CURRENT_STAMP });
    const rawRow = { id, agentId: AGENT, content: "raw vector condition fixture", createdAt: new Date().toISOString(),
      visibility: "shared", embedding: UNTRUSTED_VEC, embeddingModel: CURRENT_STAMP };
    const inserted = await h.adminOp({
      operation: "insert", database: "flair", table: "Memory", records: [rawRow],
    });
    expect(inserted.status).toBe(200);
    expect((await h.waitGuard((s) => s.state === "uniform", 60_000))?.state).toBe("uniform");
    const before = await h.semanticSearch({ queryEmbedding: UNTRUSTED_VEC, limit: 20 });
    expect(before.results.map((r: any) => r.id)).toContain(id);
    const bare = CURRENT_STAMP.slice(CURRENT_STAMP.indexOf(":") + 1);
    expect(bare).not.toBe(CURRENT_STAMP);
    const bareUpdate = await h.adminOp({
      operation: "update", database: "flair", table: "Memory", records: [{ ...rawRow, embeddingModel: bare }],
    });
    expect(bareUpdate.status).toBe(200);
    expect((await h.memoryRow(id)).embeddingModel).toBe(bare);
    const bareResult = await h.semanticSearch({ queryEmbedding: UNTRUSTED_VEC, limit: 20 });
    expect((await h.health()).embeddingSpace.state).toBe("uniform");
    expect(bareResult.results.map((r: any) => r.id)).toContain(id);
    const updated = await h.adminOp({
      operation: "update", database: "flair", table: "Memory", records: [{ ...rawRow, embeddingModel: null }],
    });
    expect(updated.status).toBe(200);
    expect((await h.memoryRow(id)).embedding).toEqual(UNTRUSTED_VEC);
    const after = await h.semanticSearch({ queryEmbedding: UNTRUSTED_VEC, limit: 20 });
    expect((await h.health()).embeddingSpace.state).toBe("uniform");
    expect(after.results.map((r: any) => r.id)).toContain(control);
    expect(after.results.map((r: any) => r.id)).not.toContain(id);
    const removed = await h.adminOp({ operation: "delete", database: "flair", table: "Memory", ids: [id] });
    expect(removed.status).toBe(200);
  }, 120_000);

  test("signed federation normalizes an empty Memory embedding before storage", async () => {
    const id = "mem-2573-federated-empty";
    const peer = "peer-2573-empty";
    const keys = nacl.sign.keyPair();
    const createdAt = new Date().toISOString();
    const paired = await h.adminOp({
      operation: "insert", database: "flair", table: "Peer",
      records: [{ id: peer, publicKey: Buffer.from(keys.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt }],
    });
    expect(paired.status).toBe(200);
    const signed = signBodyFresh({
      instanceId: peer, lamportClock: Date.now(),
      records: [{ table: "Memory", id, updatedAt: createdAt,
        data: { id, agentId: AGENT, content: "federated empty embedding", createdAt, visibility: "shared", embedding: [] } }],
    }, keys.secretKey);
    const response = await fetch(`${harper!.httpURL}/FederationSync`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signed),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.merged).toBe(1);
    expect((await h.memoryRow(id)).embedding).toBeNull();
    const space = await h.waitGuard((s) => s.state === "uniform" && s.excluded === 0, 60_000);
    expect(space?.state).toBe("uniform");
    expect(space?.excluded).toBe(0);
    expect(await h.doctor()).toContain("embedding model stamps verified uniform");
    const result = await h.semanticSearch({ queryEmbedding: UNTRUSTED_VEC, limit: 20 });
    expect(result.results.map((r: any) => r.id)).toContain("mem-2573-filter-control");
    expect(result.results.map((r: any) => r.id)).not.toContain(id);
  }, 240_000);

  test("a rescan counts a raw unstamped empty array and Health and doctor report non-uniform", async () => {
    const id = "mem-2573-raw-empty";
    const trigger = "mem-2573-rescan-trigger";
    const putEmpty = "mem-2573-put-empty";
    const inserted = await h.adminOp({
      operation: "insert", database: "flair", table: "Memory",
      records: [{ id, agentId: AGENT, content: "raw empty embedding", createdAt: new Date().toISOString(),
        visibility: "shared", embedding: [] }],
    });
    expect(inserted.status).toBe(200);
    const raw = await h.memoryRow(id);
    expect(raw.embedding).toEqual([]);
    expect(raw.embeddingModel ?? null).toBeNull();
    // A signed PUT of `[]` stores no empty array: no vector, or (with a model)
    // the write's own embed of the text under the current stamp.
    await h.putMemory(putEmpty, { content: "a signed empty embedding is not stored as an empty array", embedding: [] });
    const expectPutEmptyRow = async () => {
      const putRow = await h.memoryRow(putEmpty);
      expectNoVectorOrServerComputed(putRow);
      if (putRow.embedding != null) expect(putRow.embeddingModel).toBe(CURRENT_STAMP);
    };
    await expectPutEmptyRow();
    // The raw insert is not notified. A signed write storing an unstamped vector
    // is, so the count goes stale and the consult rescans; the rescan counts both
    // rows — two only because the raw empty array is counted.
    await h.putMemory(trigger, { content: "a rescan trigger that stores a caller-supplied vector", embedding: UNTRUSTED_VEC });
    const space = await h.waitGuard((s) => s.state === "excluded" && s.excluded === 2, 60_000);
    expect(space?.state).toBe("excluded");
    expect(space?.excluded).toBe(2);
    expect(await h.doctor()).toContain("excluded from the vector leg: 2 row(s) with no trusted model stamp");
    const result = await h.semanticSearch({ queryEmbedding: UNTRUSTED_VEC, limit: 20 });
    expect(result.results).toEqual([]);
    expect((await h.memoryRow(id)).embedding).toEqual([]);
    const removed = await h.adminOp({ operation: "delete", database: "flair", table: "Memory", ids: [id] });
    expect(removed.status).toBe(200);
    // A trusted PUT replacing the trigger's untrusted vector marks the count
    // stale; the rescan finds neither row.
    await h.putMemory(trigger, { content: "a rescan trigger that stores a caller-supplied vector", embedding: STAMPED_VEC, embeddingModel: CURRENT_STAMP });
    expect((await h.waitGuard((s) => s.state === "uniform" && s.excluded === 0, 60_000))?.state).toBe("uniform");
    // Re-read after the doctor run and rescans above: a later write to the row
    // (the auto-embed backfill) left no vector without the current stamp.
    await expectPutEmptyRow();
  }, 180_000);

  test("metadata-only PATCH preserves a uniform verdict; an unstamped vector PATCH closes it", async () => {
    await h.putMemory(A_ID, { content: STAMPED_TEXT, embedding: STAMPED_VEC, embeddingModel: CURRENT_STAMP });
    expect((await h.waitGuard((s) => s.state === "uniform", 60_000))?.state).toBe("uniform");
    await h.patchMemory(A_ID, { tags: ["metadata-only"] });
    const metadataPatched = await h.memoryRow(A_ID);
    expect(metadataPatched.tags).toEqual(["metadata-only"]);
    expect(metadataPatched.embedding).toEqual(STAMPED_VEC);
    expect(metadataPatched.embeddingModel).toBe(CURRENT_STAMP);
    expect((await h.health()).embeddingSpace.state).toBe("uniform");
    await h.consult();
    expect((await h.health()).embeddingSpace.state).toBe("uniform");
    await h.patchMemory(A_ID, { embedding: UNTRUSTED_VEC, embeddingModel: null });
    const vectorPatched = await h.memoryRow(A_ID);
    expect(vectorPatched.embedding).toEqual(UNTRUSTED_VEC);
    expect(vectorPatched.embeddingModel ?? null).toBeNull();
    expect((await h.health()).embeddingSpace.state).not.toBe("uniform");
    expect((await h.waitGuard((s) => s.state === "excluded" && s.excluded === 1, 60_000))?.state).toBe("excluded");
  }, 180_000);
});

// The vector-only branch embeds the query text, so this describe needs the model.
(HAS_MODEL ? describe : describe.skip)("flair#2573 slice 1 — vector-only mode falls back and names the guard state (real Harper)", () => {
  let harper: HarperInstance | undefined;
  let component: ComposedComponent | undefined;
  let h: ReturnType<typeof makeHarness>;
  const U_ID = "mem-2573-vo-unstamped";
  const A_ID = "mem-2573-vo-stamped";
  const TOKEN = "zqxvectorkeyword";

  beforeAll(async () => {
    const spawned = await spawnWithHarness({ FLAIR_RETRIEVAL_MODE: "vector-only" });
    harper = spawned.harper;
    component = spawned.component;
    h = spawned.h;
  }, 180_000);

  afterAll(async () => {
    await stopAndClean(harper, component);
  }, 60_000);

  test("a signed unstamped-vector PUT makes the vector-only branch fall back, reporting the guard state", async () => {
    await h.putMemory(A_ID, { content: `a stamped row mentioning ${TOKEN}`, embedding: STAMPED_VEC, embeddingModel: CURRENT_STAMP });
    await h.putMemory(U_ID, { content: `an untrusted vector row ${KEYWORD}`, embedding: UNTRUSTED_VEC });
    const space = await h.waitGuard((s) => s.state === "excluded" && s.excluded === 1, 60_000);
    expect(space?.state).toBe("excluded");

    // vector-only mode: the query text is embedded, then the guard refuses the
    // embedding leg. The response falls back to keyword-only and names the state.
    const res = await h.semanticSearch({ q: TOKEN, limit: 20 });
    expect(String(res._warning ?? "")).toContain("semantic search unavailable");
    expect(String(res._warning ?? "")).toContain("stored vector with no trusted current-space stamp");
    expect(res.results.map((r: any) => r.content as string).some((c: string) => c.includes(TOKEN))).toBe(true);
  }, 120_000);
});
