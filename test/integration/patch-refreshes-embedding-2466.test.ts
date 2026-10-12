/**
 * patch-refreshes-embedding-2466.test.ts — a PATCH that changes a memory's text
 * and supplies no vector refreshes the embedding (flair#2466), real Harper.
 *
 * Memory.patch() merges the write body into the stored row. Before this fix a
 * PATCH that changed `content` (or a skill row's `trigger`) without supplying a
 * vector left the stored vector — the one computed from the EARLIER text — in
 * place, so a redacted or edited memory still matched searches for the text it no
 * longer held. The fix recomputes the vector from the patched row inside the same
 * write, the way Memory.put() embeds a write that carries no vector.
 *
 * Cases:
 *   (a) a redacting PATCH of `content` with no vector stores the vector of the
 *       REDACTED text, not the pre-PATCH vector;
 *   (b) semantic search for the removed text no longer scores the memory by its
 *       old vector (the absolute `_score` collapses to the new text's similarity);
 *   (c) a PATCH of a non-embedding-input field (`summary`) keeps the vector;
 *   (d) a PATCH that SUPPLIES a vector stores that vector, unchanged.
 *
 * Throwaway HOME + data dir, ephemeral ports. The spawned Harper is this test's
 * own instance; see assertOwnInstance.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";

const CURRENT_MODEL_ID = getModelId();
// The current model's BARE (engine-prefix-stripped) equivalent. The boot
// embedding-stamp migration treats it as current-space, so it never re-embeds a
// seeded row and races the write under test (same stamp the re-embed tests use).
const SEED_MODEL_ID = stripEnginePrefix(CURRENT_MODEL_ID);
const STALE_EMBEDDING = [0.01, 0.02, 0.03];
// A credential-shaped value the shared redactor rewrites to `[redacted]`.
const SLACK_TOKEN = `xoxb-${"c".repeat(12)}`;
const REDACTED = "[redacted]";
const AGENT = "pre-agent";
const DIM = 768;
/** A one-hot vector, distinct from the corpus embeddings → no ranking pollution. */
const SUPPLIED = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

let harper: HarperInstance;
let home: string;
let authHeader: string;

function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  const httpPort = Number(http.port);
  const opsPort = Number(ops.port);
  for (const [label, u, port] of [["http", http, httpPort], ["ops", ops, opsPort]] as const) {
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (httpPort === opsPort || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

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

async function seedRow(id: string, content: string, extra: Record<string, unknown> = {}): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    // `visibility` is set so the boot visibility-backfill migration treats the
    // row as already-stamped and never re-puts it.
    records: [{
      id, agentId: AGENT, content, embedding: STALE_EMBEDDING, embeddingModel: SEED_MODEL_ID,
      visibility: "shared", createdAt: new Date().toISOString(), ...extra,
    }],
  });
}

/** A plain PATCH over the real HTTP route, as the Basic administrator. */
async function patch(id: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${harper.httpURL}/Memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

/** The server's own embedding of `text`, via an ordinary admin PUT of a probe row. */
async function serverEmbedding(text: string): Promise<number[]> {
  const id = `pre-probe-${Math.random().toString(36).slice(2)}`;
  const res = await fetch(`${harper.httpURL}/Memory/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ id, agentId: "probe-agent", content: text }),
    signal: AbortSignal.timeout(60_000),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const row = await readRow(id);
  expect(Array.isArray(row?.embedding) && row!.embedding.length > 0).toBe(true);
  return row!.embedding;
}

async function semanticSearch(queryEmbedding: number[], limit = 5): Promise<any> {
  const res = await fetch(`${harper.httpURL}/SemanticSearch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ agentId: AGENT, queryEmbedding, scoring: "raw", limit }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `SemanticSearch → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

function scoreOf(body: any, id: string): number | undefined {
  const row = (body?.results ?? []).find((r: any) => r.id === id);
  return row?._score;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2466-home-"));
  harper = await startHarper({ homeDir: home });
  assertOwnInstance(harper);
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("flair#2466 — a text-changing PATCH refreshes the embedding (real Harper)", () => {
  it("(a) a redacting PATCH of content with no vector stores the vector of the redacted text", async () => {
    const id = "pre-case-a";
    await seedRow(id, "the deploy checklist lived here before the patch");
    const redacted = `notify the on-call via ${REDACTED}`;
    const res = await patch(id, { content: `notify the on-call via ${SLACK_TOKEN}` });
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const row = await readRow(id);
    expect(row.content, "the stored content is not redacted").toBe(redacted);
    expect(row.embedding, "the PATCH kept the pre-PATCH vector").not.toEqual(STALE_EMBEDDING);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
    const expected = await serverEmbedding(redacted);
    expect(cosine(row.embedding, expected), "the stored vector is not the redacted text's vector")
      .toBeGreaterThan(0.9999);
  }, 120_000);

  it("(c) a PATCH of a non-embedding-input field keeps the vector", async () => {
    const id = "pre-case-c";
    await seedRow(id, "a note whose vector must survive a summary edit");
    const res = await patch(id, { summary: "an edited summary that mentions no credential" });
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const row = await readRow(id);
    expect(row.summary).toBe("an edited summary that mentions no credential");
    expect(row.embedding, "a non-input-field PATCH changed the vector").toEqual(STALE_EMBEDDING);
    expect(row.embeddingModel).toBe(SEED_MODEL_ID);
  }, 120_000);

  it("(b) semantic search for the removed text no longer scores the memory by its old vector", async () => {
    const id = "pre-case-b";
    const REMOVED = "the quarterly budget spreadsheet for the marketing team";
    const NEW = "a binary search tree rotation preserves the in-order traversal";
    const removedVector = await serverEmbedding(REMOVED);
    await seedRow(id, REMOVED, { embedding: removedVector, embeddingModel: CURRENT_MODEL_ID });

    const before = await semanticSearch(removedVector);
    expect(scoreOf(before, id), "the seeded old vector did not drive the ranking")
      .toBeGreaterThan(0.99);

    const res = await patch(id, { content: NEW });
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const newVector = await serverEmbedding(NEW);
    const expectedScore = cosine(removedVector, newVector);
    // A bounded wait for the embedding index to catch up with the patched row.
    // The assertion itself is absolute: the score must be the NEW text's cosine.
    let score: number | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      score = scoreOf(await semanticSearch(removedVector), id);
      if (score !== undefined && score < 0.9) break;
      await Bun.sleep(100);
    }
    expect(score, "the memory is still scored by the pre-PATCH vector").toBeLessThan(0.9);
    expect(Math.abs((score ?? 0) - expectedScore), "the score is not the new text's cosine")
      .toBeLessThan(0.02);
  }, 180_000);

  it("(d) a PATCH supplying a vector stores that vector", async () => {
    const id = "pre-case-d";
    await seedRow(id, "a note replaced by a client-supplied vector");
    const res = await patch(id, { content: "the replacement text", embedding: SUPPLIED });
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const row = await readRow(id);
    expect(row.content).toBe("the replacement text");
    expect(row.embedding, "the supplied vector was not stored").toEqual(SUPPLIED);
  }, 120_000);
});
