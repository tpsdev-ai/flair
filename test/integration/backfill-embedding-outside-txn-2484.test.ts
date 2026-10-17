/**
 * backfill-embedding-outside-txn-2484.test.ts — concurrent text edits after
 * vector computation, before or during the write transaction (flair#2484),
 * real Harper.
 *
 * The backfill computes the vector before its owned write transaction opens,
 * from the row's embedding text (flair#2465: a skill's non-empty `trigger`,
 * else `content`). Rows without that text or with an embedding longer than 100
 * entries skip before the text comparison. For eligible rows, the fields that
 * select the text (`content`, `trigger`, `tags`) are compared before staging
 * and the committed row is confirmed afterward. Drift observed by either check
 * aborts the attempt; remaining outer attempts re-read and may recompute.
 * Changes after confirmation and before commit are not detected by these
 * checks.
 *
 * The spawned Harper carries the test-only pause (resources/txn-pause-point.ts,
 * enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR).
 *
 * Throwaway HOME + data dir, ephemeral ports; every request goes to this
 * file's own instance.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { computeContentHash } from "../../resources/memory-feed-lib.ts";

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
function adminAuth(harper: HarperInstance): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth(harper) },
    body: JSON.stringify(op),
  });
}
async function authSend(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  // The short-vector skill fixture uses this administrator to store its supplied vector.
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "admin", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `seed agent returned ${res.status}`).toBe(200);
}
async function readRow(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_hash returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}
/** Seed a Memory row whose 3-value embedding is below the backfill's length
 *  threshold, so a following write triggers the backfill. */
async function insertRow(harper: HarperInstance, row: Record<string, unknown>): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      visibility: "shared", archived: false, createdAt: "2026-01-01T00:00:00.000Z",
      embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(), ...row,
    }],
  });
  expect(res.status, `raw insert of ${String(row.id)} returned ${res.status}`).toBe(200);
}
async function updateRow(harper: HarperInstance, row: Record<string, unknown>): Promise<number> {
  const res = await adminOp(harper, { operation: "update", database: "flair", table: "Memory", records: [row] });
  return res.status;
}
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
/** The server's own embedding of `text`, via an ordinary admin PUT of a probe row. */
async function serverEmbedding(harper: HarperInstance, text: string): Promise<number[]> {
  const id = `bfx-probe-${randomUUID()}`;
  const res = await fetch(`${harper.httpURL}/Memory/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: adminAuth(harper) },
    body: JSON.stringify({ id, agentId: "probe-agent", content: text }),
    signal: AbortSignal.timeout(60_000),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  const row = await readRow(harper, id);
  expect(Array.isArray(row?.embedding)).toBe(true);
  return row.embedding;
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

/**
 * Arm `point`, start the Memory write that triggers the backfill, run
 * `compete` once the backfill is paused, release, and await the write
 * response. Returns how the pause ended.
 */
async function withPaused(point: string, trigger: () => Promise<Response>, compete: () => Promise<unknown>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  let competed: unknown;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  // The backfill is not awaited by the write request, so the release marker can
  // land after `pending` resolves: read it until it is written.
  let released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  for (const until = Date.now() + 5_000; paused && !released && Date.now() < until;) {
    await new Promise((r) => setTimeout(r, 25));
    try { released = readFileSync(join(pauseDir, `released.${point}`), "utf8"); } catch { released = ""; }
  }
  return { response, competed, released, paused };
}

/** Wait for an embedding longer than 100 entries (or the deadline). */
async function waitForEmbedding(id: string): Promise<any> {
  const deadline = Date.now() + 120_000;
  let row = await readRow(harper, id);
  while (!(Array.isArray(row?.embedding) && row.embedding.length > 100) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    row = await readRow(harper, id);
  }
  return row;
}

const OLD_TEXT = "a note about baking sourdough bread with rye flour and a long cold overnight proof";
const NEW_TEXT = "a record concerning orbital mechanics, satellite telemetry windows and launch margins";

let harper: HarperInstance;
let pauseDir: string;
let home: string;
const agent = mkAgent("bfx-agent");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "flair-2484-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2484-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper({ homeDir: home });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // Every request in this file goes to the ephemeral instance this test started.
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
  await seedAgent(harper, agent);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2484 — the embedding backfill and a concurrent text change (real Harper)", () => {
  for (const point of ["backfill-embedding-pre", "backfill-embedding"]) {
    it(`stores a vector for the NEW text after a concurrent change (${point})`, async () => {
      const id = `bfx-drift-${point}`;
      await insertRow(harper, { id, agentId: agent.id, content: OLD_TEXT, contentHash: id, instanceToken: randomUUID() });

      const { response, competed, released, paused } = await withPaused(
        point,
        () => authSend(harper, agent, "PATCH", `/Memory/${id}`, { subject: "drift-subject" }),
        () => updateRow(harper, { id, content: NEW_TEXT }),
      );

      expect(paused, `the backfill was not paused at ${point}`).toBe(true);
      expect(released, "the pause ended by timeout, not by this test").toBe("go");
      expect(competed, "the competing content edit was not applied").toBe(200);
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);

      const row = await waitForEmbedding(id);
      expect(row?.content, "the competing content edit is kept").toBe(NEW_TEXT);
      expect(row?.embedding?.length, "the backfill wrote a computed embedding").toBeGreaterThan(100);

      // The edit commits after computation, before or during the write
      // transaction. Check that the stored vector matches the NEW text.
      const newVector = await serverEmbedding(harper, NEW_TEXT);
      const oldVector = await serverEmbedding(harper, OLD_TEXT);
      console.log(`${point} cosines:`, JSON.stringify({
        to_new: Number(cosine(row.embedding, newVector).toFixed(6)),
        to_old: Number(cosine(row.embedding, oldVector).toFixed(6)),
        new_vs_old: Number(cosine(newVector, oldVector).toFixed(6)),
      }));
      expect(cosine(row.embedding, newVector), "the backfill stored a vector for the superseded text").toBeGreaterThan(0.999);
      expect(cosine(row.embedding, newVector), "the stored vector matches the old text better than the new").toBeGreaterThan(cosine(row.embedding, oldVector));
    }, 180_000);
  }

  it("CONTROL: with no competing change the backfill stores the row's own vector", async () => {
    const id = "bfx-control";
    await insertRow(harper, { id, agentId: agent.id, content: "a control text about quiet walks", contentHash: id, instanceToken: randomUUID() });

    const res = await authSend(harper, agent, "PATCH", `/Memory/${id}`, { subject: "control-subject" });
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const row = await waitForEmbedding(id);
    expect(row?.content).toBe("a control text about quiet walks");
    const vector = await serverEmbedding(harper, "a control text about quiet walks");
    expect(cosine(row.embedding, vector), "the stored vector is not the row's own text vector").toBeGreaterThan(0.999);
  }, 120_000);
});

describe("flair#2465 — the embedding backfill embeds a skill's trigger and binds it (real Harper)", () => {
  const TRIGGER = "when the nightly backup job fails to upload its archive";
  const PROCEDURE = "open the job log, find the failed step, and rerun that step once";
  const NEW_TRIGGER = "when a satellite telemetry window closes before the downlink completes";

  /** PUT-create a skill whose supplied vector has fewer than 100 entries, so the
   *  write's backfill embeds it. The writer is the administrator (seedAgent): from
   *  flair#2573 slice 2 a non-admin write discards a supplied vector. */
  function putShortVectorSkill(id: string): Promise<Response> {
    return authSend(harper, agent, "PUT", `/Memory/${id}`, {
      id, agentId: agent.id, tags: ["skill"], trigger: TRIGGER, content: PROCEDURE,
      embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(),
    });
  }

  it("stores the trigger's vector, not the content's, and records the trigger's hash", async () => {
    const id = "bfx-skill-control";
    const res = await putShortVectorSkill(id);
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBeLessThan(300);

    const row = await waitForEmbedding(id);
    expect(row?.trigger).toBe(TRIGGER);
    expect(row?.content).toBe(PROCEDURE);
    expect(row?.embedding?.length, "the backfill wrote a computed embedding").toBeGreaterThan(100);
    const triggerVector = await serverEmbedding(harper, TRIGGER);
    const contentVector = await serverEmbedding(harper, PROCEDURE);
    expect(cosine(row.embedding, triggerVector), "the backfill did not embed the trigger").toBeGreaterThan(0.999);
    expect(cosine(row.embedding, triggerVector)).toBeGreaterThan(cosine(row.embedding, contentVector));
    expect(row.embeddedContentHash).toBe(computeContentHash(agent.id, TRIGGER));
  }, 180_000);

  for (const point of ["backfill-embedding-pre", "backfill-embedding"]) {
    it(`stores the NEW trigger's vector after a concurrent trigger-only change (${point})`, async () => {
      const id = `bfx-skill-drift-${point}`;
      const { response, competed, released, paused } = await withPaused(
        point,
        () => putShortVectorSkill(id),
        () => updateRow(harper, { id, trigger: NEW_TRIGGER }),
      );

      expect(paused, `the backfill was not paused at ${point}`).toBe(true);
      expect(released, "the pause ended by timeout, not by this test").toBe("go");
      expect(competed, "the competing trigger edit was not applied").toBe(200);
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);

      const row = await waitForEmbedding(id);
      expect(row?.trigger, "the competing trigger edit is kept").toBe(NEW_TRIGGER);
      expect(row?.content).toBe(PROCEDURE);
      const newVector = await serverEmbedding(harper, NEW_TRIGGER);
      const oldVector = await serverEmbedding(harper, TRIGGER);
      expect(cosine(row.embedding, newVector), "the backfill stored a vector for the superseded trigger").toBeGreaterThan(0.999);
      expect(cosine(row.embedding, newVector)).toBeGreaterThan(cosine(row.embedding, oldVector));
      expect(row.embeddedContentHash).toBe(computeContentHash(agent.id, NEW_TRIGGER));
    }, 180_000);
  }
});
