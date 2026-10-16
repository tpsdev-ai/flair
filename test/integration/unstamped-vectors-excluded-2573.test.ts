/**
 * unstamped-vectors-excluded-2573.test.ts — flair#2573 slice 1 (real Harper).
 *
 * A published scan counts stored vectors without trusted current-space stamps.
 * Raw operations-API inserts remain uncovered until a rescan. Covers signed
 * Memory PUT/PATCH, dedup, recall, /Health, and doctor's last published count
 * in the `excluded` state.
 * A separate instance runs with FLAIR_RETRIEVAL_MODE=vector-only to show
 * that branch falling back and naming the guard state.
 *
 * The always-on embedding-stamp migration would otherwise re-embed a no-stamp row
 * (which removes the very state under test), so its regen is held at the
 * test-only `embedding-stamp-regen-pre` point for the span of each describe
 * (released in afterAll). The fault-injection gate is the environment the spawned
 * Harper inherits.
 *
 * Mutation check (fails on an assertion): in resources/embedding-space-guard.ts,
 * make the scan not count a stored vector with no trusted stamp (skip the
 * `excluded++` for a missing stamp), leaving everything else — the store is then
 * read as uniform, the near-duplicate query compares vectors, and the excluded
 * count assertions go red. Restore with a file copy, never git.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV } from "../../resources/txn-pause-point.ts";

const REGEN_POINT = "embedding-stamp-regen-pre";
const AGENT = "agent-a"; // neutral fixture name (no fleet host/agent)
const CLI = join(process.cwd(), "dist", "cli.js");

/** The stamp the spawned instance writes when it embeds. Same env, same value. */
const CURRENT_STAMP = getModelId();

/** A vector the untrusted row stores and a query can target. */
const UNTRUSTED_VEC = [1, 0, 0, 0];
const STAMPED_VEC = [1, 1, 0, 0]; // cosine 0.7071 against UNTRUSTED_VEC

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

/** Spawn a Harper with the migration regen held, register the agent, return the harness. */
async function spawnWithHarness(env?: Record<string, string>):
  Promise<{ harper: HarperInstance; pauseDir: string; h: ReturnType<typeof makeHarness> }> {
  const pauseDir = mkdtempSync(join(tmpdir(), "flair-2573-pause-"));
  // Hold the stamp migration's regen so a no-stamp row keeps its state under test.
  writeFileSync(join(pauseDir, `arm.${REGEN_POINT}`), "");
  const saved: Record<string, string | undefined> = {
    [TEST_FAULT_INJECTION_ENV]: process.env[TEST_FAULT_INJECTION_ENV],
    [TEST_PAUSE_DIR_ENV]: process.env[TEST_PAUSE_DIR_ENV],
  };
  process.env[TEST_FAULT_INJECTION_ENV] = "1";
  process.env[TEST_PAUSE_DIR_ENV] = pauseDir;
  let harper: HarperInstance;
  try {
    harper = await startHarper(env ? { env } : {});
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
  return { harper, pauseDir, h };
}

async function releaseAndStop(harper: HarperInstance | undefined, pauseDir: string): Promise<void> {
  if (pauseDir) writeFileSync(join(pauseDir, `go.${REGEN_POINT}`), "");
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}

describe("flair#2573 slice 1 — signed unstamped vector writes close the guard (real Harper)", () => {
  let harper: HarperInstance | undefined;
  let pauseDir = "";
  let h: ReturnType<typeof makeHarness>;
  const A_ID = "mem-2573-stamped-a";
  const B_ID = "mem-2573-stamped-b";
  const C_ID = "mem-2573-stamped-c";
  const U_ID = "mem-2573-unstamped";

  beforeAll(async () => {
    const spawned = await spawnWithHarness();
    harper = spawned.harper;
    pauseDir = spawned.pauseDir;
    h = spawned.h;
  }, 180_000);

  afterAll(async () => {
    await releaseAndStop(harper, pauseDir);
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
  let pauseDir = "";
  let h: ReturnType<typeof makeHarness>;
  const A_ID = "mem-2573-patch";

  beforeAll(async () => {
    const spawned = await spawnWithHarness();
    harper = spawned.harper;
    pauseDir = spawned.pauseDir;
    h = spawned.h;
  }, 180_000);

  afterAll(async () => {
    await releaseAndStop(harper, pauseDir);
  }, 60_000);

  test("signed PATCH of an empty embedding stores null, preserves uniform, and removes the row from vector results", async () => {
    const id = "mem-2573-empty-patch";
    await h.putMemory(id, { content: "empty vector boundary fixture", embedding: UNTRUSTED_VEC, embeddingModel: CURRENT_STAMP });
    const before = await h.waitGuard((s) => s.state === "uniform", 60_000);
    expect(before?.state).toBe("uniform");
    expect((await h.semanticSearch({ queryEmbedding: UNTRUSTED_VEC, limit: 20 })).results.map((r: any) => r.id)).toContain(id);
    await h.patchMemory(id, { embedding: [] });
    const row = await h.memoryRow(id);
    expect(row.embedding ?? null).toBeNull();
    expect(row.embeddingModel).toBe(CURRENT_STAMP);
    expect((await h.health()).embeddingSpace).toEqual(before);
    await h.consult();
    expect((await h.health()).embeddingSpace).toEqual(before);
    const result = await h.semanticSearch({ queryEmbedding: UNTRUSTED_VEC, limit: 20 });
    expect(result.results.map((r: any) => r.id)).not.toContain(id);
  }, 120_000);

  test("the vector stamp condition filters an untrusted row while the guard stays uniform", async () => {
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

describe("flair#2573 slice 1 — vector-only mode falls back and names the guard state (real Harper)", () => {
  let harper: HarperInstance | undefined;
  let pauseDir = "";
  let h: ReturnType<typeof makeHarness>;
  const U_ID = "mem-2573-vo-unstamped";
  const A_ID = "mem-2573-vo-stamped";
  const TOKEN = "zqxvectorkeyword";

  beforeAll(async () => {
    const spawned = await spawnWithHarness({ FLAIR_RETRIEVAL_MODE: "vector-only" });
    harper = spawned.harper;
    pauseDir = spawned.pauseDir;
    h = spawned.h;
  }, 180_000);

  afterAll(async () => {
    await releaseAndStop(harper, pauseDir);
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
