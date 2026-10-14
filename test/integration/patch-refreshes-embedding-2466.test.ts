/**
 * patch-refreshes-embedding-2466.test.ts — ordinary PATCH embedding cases
 * (flair#2466), real Harper.
 *
 * Memory.patch() merges the write body into the stored row. Before this fix a
 * PATCH that changed `content` without supplying embedding fields could leave
 * the stored vector — the one computed from the EARLIER text — in place, so a redacted or
 * edited memory still matched searches for the text it no longer held. A
 * non-re-embed PATCH refreshes when its body changes the compared row's
 * effective embedding text (embedTextField/skillEmbedText), from that text as
 * its body carries it, and only when `embedding` is absent after redaction (an
 * own-property check; Memory.put() instead computes when `embedding` is falsy).
 * Both paths use the same embedding engine. A fresh committed-row
 * read runs only when the initial comparison selected no embedding, a stored
 * row exists, and the body omits `embedding` and carries the embedding-text field. Other
 * paths write without that confirmation. Skill writes are refused before this
 * branch, so every row here embeds from `content`.
 *
 * Cases (one Harper with a working embedding engine):
 *   (a) a redacting PATCH of `content` with no vector stores the vector of the
 *       REDACTED text, not the pre-PATCH vector;
 *   (b) semantic search for the removed text no longer yields the old vector's
 *       high score (the absolute `_score` collapses to the new text's similarity);
 *   (c) a PATCH of a field no embedding is computed from (`summary`) keeps the vector;
 *   (d) a PATCH that SUPPLIES a vector stores that vector, unchanged;
 *   (e) a `trigger`-only PATCH of an ordinary row — plain, or carrying a vector
 *       that redaction removes — keeps the stored vector and its stamps;
 *   (f) an edit of `content` (a PUT) that commits while a `trigger`-only PATCH
 *       of the same row is held before its write ends with the vector of the
 *       EDITED text, never one for the earlier content;
 *   (g) the same overlap with a `content` PATCH ends with the row's text and
 *       vector both from that PATCH;
 *   (i) a PATCH carrying the unchanged `content`, a credential in `trigger` and
 *       a supplied vector (which redaction removes) keeps the stored vector,
 *       `embeddingModel` and `updatedAt`;
 *   (k) the overlap of (f) with a PATCH whose `content` equals the text it read
 *       (plain, and as in (i)) ends with that text and its vector, never the
 *       edit's vector next to the PATCH's text.
 * On a second Harper whose embedding backend fails (its model file is absent,
 * so getEmbedding returns null):
 *   (h) a text-changing PATCH of a row with a stored, searchable vector clears
 *       `embedding`/`embeddingModel`, semantic search no longer gives the row
 *       the old vector's high score, and the null stamp is selected by the
 *       embedding-stamp re-embed's pending condition;
 *   (j) the PATCH of (i) keeps the valid stored vector, its stamp and
 *       `updatedAt` (the engine is never asked).
 *
 * (f), (g) and (k) use the test-only pauses (resources/txn-pause-point.ts,
 * enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, set in
 * this process's environment while this file starts its Harper, then restored):
 * `memory-put` holds the editing PUT (sent as the administrator) after its first
 * read and its embed and before its write, so its transaction opens FIRST;
 * `memory-patch` holds the PATCH after its stored-row read (which sees the
 * pre-edit text) and any embed, before the conditional committed-row read and
 * the write. The PUT is released and commits, then the PATCH. The PATCH's
 * transaction opened after the PUT's, so Harper orders its write after the
 * edit — the ordering flair#2465's deterministic case relies on.
 *
 * Throwaway HOME + data dir, ephemeral ports. Each spawned Harper is this test's
 * own instance; see assertOwnInstance.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
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
/** A caller-supplied one-hot vector. */
const SUPPLIED = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
/** Test-only pauses (resources/Memory.ts): the PUT's, and the PATCH's before its write. */
const PUT_POINT = "memory-put";
const PATCH_POINT = "memory-patch";

/** One spawned Harper and the admin credentials for it. */
interface Target { harper: HarperInstance; auth: string; }

let main: Target;
let failing: Target | undefined;
let home: string;
let failingHome: string | undefined;
let pauseDir: string;

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

/** Start an isolated Harper with `env` set in this process only for the spawn, then restored. */
async function startTarget(homeDir: string, env: Record<string, string>): Promise<Target> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let harper: HarperInstance;
  try {
    harper = await startHarper({ homeDir });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
  return { harper, auth: "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64") };
}

async function opsCall(body: Record<string, unknown>, t: Target = main): Promise<any> {
  const res = await fetch(t.harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: t.auth },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

async function readRow(id: string, t: Target = main): Promise<any> {
  const rows = await opsCall({
    operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"],
  }, t);
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}

async function seedRow(id: string, content: string, extra: Record<string, unknown> = {}, t: Target = main): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    // `visibility` is set so the boot visibility-backfill migration treats the
    // row as already-stamped and never re-puts it.
    records: [{
      id, agentId: AGENT, content, embedding: STALE_EMBEDDING, embeddingModel: SEED_MODEL_ID,
      visibility: "shared", createdAt: new Date().toISOString(), ...extra,
    }],
  }, t);
}

/** A plain PATCH over the real HTTP route, as the Basic administrator. */
async function patch(id: string, body: Record<string, unknown>, t: Target = main): Promise<Response> {
  return fetch(`${t.harper.httpURL}/Memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: t.auth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

/** An ordinary PUT edit of the row's text over the real HTTP route, as the Basic administrator. */
async function putEdit(id: string, content: string, t: Target = main): Promise<Response> {
  return fetch(`${t.harper.httpURL}/Memory/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: t.auth },
    body: JSON.stringify({ id, agentId: AGENT, content, visibility: "shared" }),
    signal: AbortSignal.timeout(60_000),
  });
}

/** The server's own embedding of `text`, via an ordinary admin PUT of a probe row. */
async function serverEmbedding(text: string): Promise<number[]> {
  const id = `pre-probe-${Math.random().toString(36).slice(2)}`;
  const res = await fetch(`${main.harper.httpURL}/Memory/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: main.auth },
    body: JSON.stringify({ id, agentId: "probe-agent", content: text }),
    signal: AbortSignal.timeout(60_000),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const row = await readRow(id);
  expect(Array.isArray(row?.embedding) && row!.embedding.length > 0).toBe(true);
  return row!.embedding;
}

async function semanticSearch(queryEmbedding: number[], limit = 5, t: Target = main): Promise<any> {
  const res = await fetch(`${t.harper.httpURL}/SemanticSearch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: t.auth },
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

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function armPause(point: string): void {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
}

function releasePause(point: string): void {
  writeFileSync(join(pauseDir, `go.${point}`), "");
}

function pauseEnding(point: string): string {
  const path = join(pauseDir, `released.${point}`);
  return existsSync(path) ? readFileSync(path, "utf8") : "never paused";
}

/**
 * Hold a PUT of `edited` (its transaction opens first), start `patchBody`
 * as a PATCH and hold it before its write (its stored-row read sees the pre-edit
 * text), let the PUT commit, then release the PATCH so its write is the newer
 * one. Returns both responses and how each pause ended.
 */
async function overlapEditWithPatch(id: string, edited: string, patchBody: Record<string, unknown>) {
  armPause(PUT_POINT);
  const pendingPut = putEdit(id, edited);
  const putPaused = await waitFor(join(pauseDir, `paused.${PUT_POINT}`), 30_000);
  let pendingPatch: Promise<Response> | undefined;
  let patchPaused = false;
  let put: Response | undefined;
  try {
    if (putPaused) {
      armPause(PATCH_POINT);
      pendingPatch = patch(id, patchBody);
      patchPaused = await waitFor(join(pauseDir, `paused.${PATCH_POINT}`), 30_000);
    }
  } finally {
    releasePause(PUT_POINT);
    put = await pendingPut;
    releasePause(PATCH_POINT);
  }
  const patched = pendingPatch ? await pendingPatch : undefined;
  return { put, patched, putEnded: pauseEnding(PUT_POINT), patchEnded: pauseEnding(PATCH_POINT), putPaused, patchPaused };
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2466-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2466-pause-"));
  main = await startTarget(home, { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir });
}, 180_000);

afterAll(async () => {
  // flair#2568: both instances concurrently (one stop deadline for the pair);
  // best effort, as before.
  await stopHarpers([main?.harper, failing?.harper]).catch(() => {});
  if (home) rmSync(home, { recursive: true, force: true });
  if (failingHome) rmSync(failingHome, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2466 — ordinary PATCH embedding cases (real Harper)", () => {
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

  it("(c) a summary-only PATCH keeps the vector", async () => {
    const id = "pre-case-c";
    await seedRow(id, "a note whose vector must survive a summary edit");
    const res = await patch(id, { summary: "an edited summary that mentions no credential" });
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const row = await readRow(id);
    expect(row.summary).toBe("an edited summary that mentions no credential");
    expect(row.embedding, "a summary-only PATCH changed the vector").toEqual(STALE_EMBEDDING);
    expect(row.embeddingModel).toBe(SEED_MODEL_ID);
  }, 120_000);

  it("(b) semantic search for the removed text no longer yields the old vector's high score", async () => {
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

  it("a text-changing PATCH with explicit null embedding clears it over HTTP", async () => {
    for (const pairedNulls of [false, true]) {
      const id = `pre-null-${pairedNulls}`;
      await seedRow(id, "the earlier text");
      const body: Record<string, unknown> = { content: "the replacement text", embedding: null };
      if (pairedNulls) body.embeddingModel = null;
      const res = await patch(id, body);
      expect(res.status, await res.clone().text()).toBeLessThan(300);
      const row = await readRow(id);
      expect(row.content).toBe("the replacement text");
      expect(row.embedding).toBeNull();
      expect(row.embeddingModel).toBe(pairedNulls ? null : SEED_MODEL_ID);
    }
  }, 120_000);

  it("an overlapping content edit leaves an ordinary PATCH's explicit null embedding cleared", async () => {
    const id = "pre-null-overlap";
    const original = "the text echoed by the PATCH";
    await seedRow(id, original);
    const overlap = await overlapEditWithPatch(id, "the concurrent edit", { content: original, embedding: null });
    expect(overlap.putPaused).toBe(true);
    expect(overlap.patchPaused).toBe(true);
    expect(overlap.put?.status).toBe(200);
    expect(overlap.patched?.status).toBeLessThan(300);
    const row = await readRow(id);
    expect(row.content).toBe(original);
    expect(row.embedding).toBeNull();
  }, 180_000);

  it("(e) a trigger-only PATCH omitting embedding after redaction keeps the stored vector and its stamps", async () => {
    // An ordinary row embeds from `content`; a `trigger` edit does not change
    // that text, so the PATCH computes nothing — with or without a supplied
    // vector that redaction removes from the body.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["pre-case-e-plain", { trigger: "when the deploy job fails on a weekend" }, "when the deploy job fails on a weekend"],
      ["pre-case-e-redacted", { trigger: `when ${SLACK_TOKEN} expires`, embedding: SUPPLIED, embeddingModel: "client-model" }, `when ${REDACTED} expires`],
    ];
    for (const [id, body, storedTrigger] of cases) {
      await seedRow(id, `an ordinary note whose text the ${id} PATCH leaves alone`, { updatedAt: "2026-01-01T00:00:00.000Z" });
      const res = await patch(id, body);
      expect(res.status, `${id}: ${await res.clone().text()}`).toBeLessThan(300);

      const row = await readRow(id);
      expect(row.trigger, `${id}: the trigger was not stored`).toBe(storedTrigger);
      expect(row.embedding, `${id}: a trigger-only PATCH replaced the stored vector`).toEqual(STALE_EMBEDDING);
      expect(row.embeddingModel, `${id}: a trigger-only PATCH re-stamped the model`).toBe(SEED_MODEL_ID);
      expect(row.updatedAt, `${id}: a trigger-only PATCH re-stamped updatedAt`).toBe("2026-01-01T00:00:00.000Z");
    }
  }, 120_000);

  it("(f) an edit committed while a trigger-only PATCH is held ends with the edited text's vector", async () => {
    const id = "pre-case-f";
    const EARLIER = "the earlier text: a walking tour of the old harbour district";
    const EDITED = "the edited text: compiler register allocation by graph colouring";
    await seedRow(id, EARLIER, { embedding: await serverEmbedding(EARLIER), embeddingModel: CURRENT_MODEL_ID });

    const run = await overlapEditWithPatch(id, EDITED, { trigger: "when someone asks about the harbour" });
    expect(run.putPaused && run.patchPaused, `pauses reached: put=${run.putPaused} patch=${run.patchPaused}`).toBe(true);
    expect(run.putEnded, "the PUT's pause ended by timeout, not by this test").toBe("go");
    expect(run.patchEnded, "the PATCH's pause ended by timeout, not by this test").toBe("go");
    expect(run.put?.status, await run.put?.clone().text()).toBe(200);
    expect(run.patched?.status, await run.patched?.clone().text()).toBeLessThan(300);

    const row = await readRow(id);
    expect(row.content, "the committed edit was lost").toBe(EDITED);
    expect(row.trigger).toBe("when someone asks about the harbour");
    const editedVector = await serverEmbedding(EDITED);
    const earlierVector = await serverEmbedding(EARLIER);
    expect(cosine(row.embedding, earlierVector), "the row ended with a vector for the earlier content")
      .toBeLessThan(0.99);
    expect(cosine(row.embedding, editedVector), "the row's vector is not the edited text's").toBeGreaterThan(0.9999);
  }, 180_000);

  it("(g) an edit committed while a content PATCH is held ends with the PATCH's text and its vector", async () => {
    const id = "pre-case-g";
    const EARLIER = "the earlier text: notes on sourdough starter hydration";
    const EDITED = "the edited text: a survey of lattice-based signature schemes";
    const PATCHED = "the patched text: migrating a lighthouse lens to LED";
    await seedRow(id, EARLIER, { embedding: await serverEmbedding(EARLIER), embeddingModel: CURRENT_MODEL_ID });

    const run = await overlapEditWithPatch(id, EDITED, { content: PATCHED });
    expect(run.putPaused && run.patchPaused, `pauses reached: put=${run.putPaused} patch=${run.patchPaused}`).toBe(true);
    expect(run.putEnded, "the PUT's pause ended by timeout, not by this test").toBe("go");
    expect(run.patchEnded, "the PATCH's pause ended by timeout, not by this test").toBe("go");
    expect(run.put?.status, await run.put?.clone().text()).toBe(200);
    expect(run.patched?.status, await run.patched?.clone().text()).toBeLessThan(300);

    const row = await readRow(id);
    expect(row.content, "the newer PATCH's text was not stored").toBe(PATCHED);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
    expect(cosine(row.embedding, await serverEmbedding(PATCHED)), "the stored vector is not the stored text's")
      .toBeGreaterThan(0.9999);
  }, 180_000);

  it("(i) unchanged content with a redaction-removed vector keeps the stored vector and its stamps", async () => {
    // Redaction removes the supplied vector (the trigger changed), but the row's
    // embedding text — its content — does not change, so nothing is computed.
    const id = "pre-case-i";
    const TEXT = "an ordinary note echoed unchanged by a PATCH that edits its trigger";
    await seedRow(id, TEXT, { updatedAt: "2026-01-01T00:00:00.000Z" });
    const res = await patch(id, { content: TEXT, trigger: `when ${SLACK_TOKEN} expires`, embedding: SUPPLIED, embeddingModel: "client-model" });
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const row = await readRow(id);
    expect(row.content).toBe(TEXT);
    expect(row.trigger, "the trigger was not redacted").toBe(`when ${REDACTED} expires`);
    expect(row.embedding, "an unchanged-text PATCH replaced the stored vector").toEqual(STALE_EMBEDDING);
    expect(row.embeddingModel, "an unchanged-text PATCH re-stamped the model").toBe(SEED_MODEL_ID);
    expect(row.updatedAt, "an unchanged-text PATCH re-stamped updatedAt").toBe("2026-01-01T00:00:00.000Z");
  }, 120_000);

  it("(k) an edit committed while a PATCH carrying the read-time text is held ends with the PATCH's text and its vector", async () => {
    // The PATCH's content equals the text it read, and differs from the text
    // the edit commits before the PATCH writes; the row must not end with the
    // edit's vector next to the PATCH's text. Plain, and with a credential in
    // trigger and a supplied vector that redaction removes.
    const bodies: Array<[string, (text: string) => Record<string, unknown>]> = [
      ["pre-case-k-plain", (text) => ({ content: text })],
      ["pre-case-k-redacted", (text) => ({ content: text, trigger: `when ${SLACK_TOKEN} expires`, embedding: SUPPLIED, embeddingModel: "client-model" })],
    ];
    const READ = "the text both reads see: a field guide to tidal pools";
    const EDITED = "the edit's text: scheduling cron jobs across time zones";
    const readVector = await serverEmbedding(READ);
    for (const [id, bodyFor] of bodies) {
      await seedRow(id, READ, { embedding: readVector, embeddingModel: CURRENT_MODEL_ID });
      const run = await overlapEditWithPatch(id, EDITED, bodyFor(READ));
      expect(run.putPaused && run.patchPaused, `${id}: pauses reached: put=${run.putPaused} patch=${run.patchPaused}`).toBe(true);
      expect(run.putEnded, `${id}: the PUT's pause ended by timeout, not by this test`).toBe("go");
      expect(run.patchEnded, `${id}: the PATCH's pause ended by timeout, not by this test`).toBe("go");
      expect(run.put?.status, await run.put?.clone().text()).toBe(200);
      expect(run.patched?.status, await run.patched?.clone().text()).toBeLessThan(300);

      const row = await readRow(id);
      expect(row.content, `${id}: the newer PATCH's text was not stored`).toBe(READ);
      expect(cosine(row.embedding, readVector), `${id}: the row's vector is not the stored text's`).toBeGreaterThan(0.9999);
      expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
    }
  }, 180_000);
});

describe("flair#2466 — ordinary PATCH cases with a failing backend (real Harper)", () => {
  beforeAll(async () => {
    failingHome = mkdtempSync(join(tmpdir(), "flair-2466-nomodel-home-"));
    // resources/embeddings-boot.ts registers the embedding backend from this
    // absolute model path (its bench-only model-path override); the file does
    // not exist, so every embed fails and resources/embeddings-provider.ts
    // getEmbedding returns null.
    failing = await startTarget(failingHome, {
      FLAIR_RECALL_HARNESS_MODEL_PATH: join(failingHome, "absent-model", "nomic-embed-text-absent.gguf"),
    });
  }, 180_000);

  it("(h) a text-changing PATCH clears a stored, searchable vector and leaves a null stamp the re-embed selects", async () => {
    const t = failing!;
    const id = "pre-case-h";
    // A stored vector in the current space, distinct from every other row's.
    const OLD = Array.from({ length: DIM }, (_, i) => (i === 7 ? 1 : 0));
    await seedRow(id, "the text before the engine went down", { embedding: OLD, embeddingModel: CURRENT_MODEL_ID }, t);
    const before = await semanticSearch(OLD, 5, t);
    expect(scoreOf(before, id), "the seeded vector is not searchable").toBeGreaterThan(0.99);

    const res = await patch(id, { content: "the text after the edit, while the engine is down" }, t);
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const row = await readRow(id, t);
    expect(row.content).toBe("the text after the edit, while the engine is down");
    expect(row.embedding ?? null, "the PATCH kept the vector of the earlier text").toBeNull();
    expect(row.embeddingModel ?? null, "the PATCH kept the earlier model stamp").toBeNull();

    // A bounded wait for the vector index to drop the cleared vector; the
    // assertion is that the old vector no longer yields a high score.
    let score: number | undefined = 1;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      score = scoreOf(await semanticSearch(OLD, 5, t), id);
      if (score === undefined || score < 0.5) break;
      await Bun.sleep(100);
    }
    expect(score === undefined || score < 0.5, `the row is still scored by the old vector (_score ${score})`).toBe(true);

    // The embedding-stamp re-embed (resources/migrations/embedding-stamp.ts)
    // selects pending rows with this leg of its condition: embeddingModel equals null.
    const pending = await opsCall({
      operation: "search_by_conditions", database: "flair", table: "Memory",
      conditions: [{ search_attribute: "embeddingModel", search_type: "equals", search_value: null }],
      get_attributes: ["id"],
    }, t);
    const pendingIds = (Array.isArray(pending) ? pending : pending?.results ?? []).map((r: any) => r.id);
    expect(pendingIds, "the null stamp is not selected by the re-embed's pending condition").toContain(id);
  }, 180_000);

  it("(j) unchanged content with a redaction-removed vector keeps a valid stored vector", async () => {
    const t = failing!;
    const id = "pre-case-j";
    const TEXT = "a note whose text a PATCH echoes while the engine is down";
    const STORED = Array.from({ length: DIM }, (_, i) => (i === 11 ? 1 : 0));
    await seedRow(id, TEXT, { embedding: STORED, embeddingModel: CURRENT_MODEL_ID, updatedAt: "2026-01-01T00:00:00.000Z" }, t);
    const res = await patch(id, { content: TEXT, trigger: `when ${SLACK_TOKEN} expires`, embedding: SUPPLIED, embeddingModel: "client-model" }, t);
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const row = await readRow(id, t);
    expect(row.trigger, "the trigger was not redacted").toBe(`when ${REDACTED} expires`);
    expect(row.embedding, "an unchanged-text PATCH cleared or replaced the stored vector").toEqual(STORED);
    expect(row.embeddingModel, "an unchanged-text PATCH changed the model stamp").toBe(CURRENT_MODEL_ID);
    expect(row.updatedAt, "an unchanged-text PATCH re-stamped updatedAt").toBe("2026-01-01T00:00:00.000Z");
  }, 120_000);
});
