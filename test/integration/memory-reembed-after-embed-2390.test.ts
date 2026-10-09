/**
 * memory-reembed-after-embed-2390.test.ts — flair#2390, real Harper.
 *
 * `Memory.patch()`'s re-embed branch (a PATCH whose body is `{"embedding":
 * null, "embeddingModel": null}` — `flair reembed` and direct PATCH requests)
 * reads the stored row, computes the embedding outside
 * the write, then writes. This file pins that the write is built from the row
 * re-read inside the transaction that writes, and re-checks the owner and the
 * text, so a change committed while the embedding was computed is neither lost
 * nor stamped with a vector for text the row no longer carries.
 *
 * The spawned Harper carries the test-only pause (resources/txn-pause-point.ts,
 * enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, set in
 * this process's environment while this file starts its Harper, then restored).
 * Each case arms it, starts the re-embed PATCH, waits until it is paused between
 * its read and its write, commits a competing write against the same row, then
 * releases it.
 *
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";

const POINT = "memory-reembed";
const CURRENT_MODEL_ID = getModelId();
const STALE_MODEL = "some-ancient-model-v0";
const STALE_EMBEDDING = [0.01, 0.02, 0.03];
const ORIGINAL = "the original text about a quiet walk through the produce market";
const EDITED = "an edit about quantum computing research grants and their deadlines";

interface TestAgent { id: string; publicKey: Uint8Array; secretKey: Uint8Array; }
const newAgent = (id: string): TestAgent => ({ id, ...nacl.sign.keyPair() });
const owner = newAgent("mre-owner");
const other = newAgent("mre-other");

let harper: HarperInstance;
let pauseDir: string;
let home: string;
let authHeader: string;

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}
async function readRow(id: string): Promise<any> {
  const rows = await opsCall({
    operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
/** A re-embed PATCH over the real HTTP route, signed as `agent`. */
function reembedAs(agent: TestAgent, id: string): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PATCH", path) },
    body: JSON.stringify({ embedding: null, embeddingModel: null }),
    signal: AbortSignal.timeout(60_000),
  });
}
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
/** The server's own embedding of `text`, via an ordinary admin PUT of a probe row. */
async function serverEmbedding(text: string): Promise<number[]> {
  const id = `mre-probe-${randomUUID()}`;
  const res = await fetch(`${harper.httpURL}/Memory/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ id, agentId: "probe-agent", content: text }),
    signal: AbortSignal.timeout(60_000),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const row = await readRow(id);
  expect(Array.isArray(row?.embedding)).toBe(true);
  return row.embedding;
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

/** Seed a stale-stamped row this file's re-embed PATCH targets. */
async function seedRow(id: string, agentId: string, extra: Record<string, unknown> = {}): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{ id, agentId, content: ORIGINAL, embedding: STALE_EMBEDDING, embeddingModel: STALE_MODEL, createdAt: new Date().toISOString(), ...extra }],
  });
}

/**
 * Arm the pause, start the re-embed PATCH, and once it is paused between its
 * read and its write run `compete`, then release it. Returns the PATCH's
 * response and how the pause ended.
 */
async function withPausedReembed(id: string, agent: TestAgent, compete: () => Promise<unknown>): Promise<{ response: Response; released: string }> {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${POINT}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${POINT}`), "");
  const pending = reembedAs(agent, id);
  const paused = await waitFor(join(pauseDir, `paused.${POINT}`), 20_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${POINT}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${POINT}`), "utf8") : "never paused";
  return { response, released };
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2390-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2390-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper({ homeDir: home });
  } finally {
    // The spawned Harper has its copy; no later Harper in this process inherits it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // Every request in this file goes to the ephemeral instance this test started.
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const url of [http, ops]) {
    if (url.hostname !== "127.0.0.1" || !(Number(url.port) > 0) || url.port === "9925" || url.port === "9926") {
      throw new Error(`refusing to run against ${url.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
  const now = new Date().toISOString();
  await opsCall({
    operation: "upsert", database: "flair", table: "Agent",
    records: [owner, other].map((a) => ({
      id: a.id, name: a.id, role: "agent", publicKey: Buffer.from(a.publicKey).toString("base64"), createdAt: now,
    })),
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2390 — a re-embed PATCH writes from the row it re-reads (real Harper)", () => {
  it("(1) a field committed while the PATCH was paused survives, alongside the re-embed", async () => {
    const id = "mre-case-1";
    await seedRow(id, owner.id, { source: "original-source" });
    const { response, released } = await withPausedReembed(id, owner, async () => {
      await opsCall({ operation: "update", database: "flair", table: "Memory", records: [{ id, source: "changed-source" }] });
    });
    expect(released, "the pause ended by timeout, not by this test").toBe("go");
    expect(response.status, await response.clone().text()).toBe(200);
    const row = await readRow(id);
    expect(row.source).toBe("changed-source"); // the competing field is kept
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID); // the re-embed landed
    expect(row.content).toBe(ORIGINAL);
  }, 120_000);

  it("(2) a content change while the PATCH awaits the embedding is not stamped with the superseded text", async () => {
    const id = "mre-case-2";
    await seedRow(id, owner.id);
    const { response, released } = await withPausedReembed(id, owner, async () => {
      await opsCall({ operation: "update", database: "flair", table: "Memory", records: [{ id, content: EDITED }] });
    });
    expect(released, "the pause ended by timeout, not by this test").toBe("go");
    expect(response.status, await response.clone().text()).toBe(200);
    const row = await readRow(id);
    expect(row.content).toBe(EDITED);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
    const editedVector = await serverEmbedding(EDITED);
    const originalVector = await serverEmbedding(ORIGINAL);
    expect(cosine(row.embedding, editedVector)).toBeGreaterThan(0.999); // matches the STORED content
    expect(cosine(row.embedding, editedVector)).toBeGreaterThan(cosine(row.embedding, originalVector)); // never the superseded text
  }, 120_000);

  it("(3) an owner change mid-PATCH is refused and the row is unchanged", async () => {
    const id = "mre-case-3";
    await seedRow(id, owner.id);
    const { response, released } = await withPausedReembed(id, owner, async () => {
      await opsCall({ operation: "update", database: "flair", table: "Memory", records: [{ id, agentId: other.id }] });
    });
    expect(released, "the pause ended by timeout, not by this test").toBe("go");
    expect(response.status, await response.clone().text()).toBe(403);
    const row = await readRow(id);
    expect(row.agentId).toBe(other.id);
    expect(row.embeddingModel).toBe(STALE_MODEL); // the re-embed did not land
    expect(row.embedding).toEqual(STALE_EMBEDDING);
  }, 120_000);
});
