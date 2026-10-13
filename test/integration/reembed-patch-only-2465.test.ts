/**
 * reembed-patch-only-2465.test.ts — a background re-embed writes only the
 * embedding fields, and confirms the committed row after staging (flair#2465),
 * real Harper.
 *
 * Harper orders a transaction by its FIRST READ, not its write. The re-embed
 * (`Memory.patch()`'s re-embed branch, driven here by a genuine HTTP PATCH whose
 * body is `{"embedding": null, "embeddingModel": null}`) writes only
 * `embedding`, `embeddingModel` and `updatedAt`. It used to write the whole row
 * it re-read inside its transaction, so an owner edit that committed while the
 * vector was computed was reverted by the re-embed's full-row put even though
 * the edit's own PUT answered 200.
 *
 * The spawned Harper carries the test-only pause (resources/txn-pause-point.ts,
 * enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, set in
 * this process's environment while this file starts its Harper, then restored).
 *
 * The re-embed is an owner PATCH and the competitor is an owner PUT, so BOTH
 * writers are owner verbs and the per-id memory write lock (flair#2478 slice 1)
 * serializes them: the writer that takes the lock first holds it, and the second
 * is refused `503 memory_busy` when it cannot take the lock within its budget or,
 * if the first releases inside that budget, waits and then commits on the first's
 * committed row. The two interleavings this file used to force at a pre-write
 * pause point are therefore impossible by design; the cases below pin the lock
 * contract instead.
 *
 * `memory-reembed` holds the re-embed (holding the lock) after its initial read
 * and before it embeds; the `(a)` case starts an owner PUT there and releases the
 * re-embed inside the PUT's budget, so the PUT waits and commits on the re-embed's
 * row. `memory-put` holds an owner PUT (holding the lock) after its first read and
 * before its write; the `(older PUT)` case starts the re-embed there, which waits
 * its whole budget and is refused — the committed edit stands untouched.
 *
 * `memory-reembed-staged` holds the re-embed's own owned transaction AFTER it
 * has STAGED its field-only update and BEFORE it confirms the committed row (and
 * commits). Cases commit a competitor there:
 *   - (a) a DELETE: the committed row is gone at the confirm, so the re-embed
 *     aborts (nothing is written) and answers the named 409 stored_row_changed;
 *     no row — and never a partial one — exists afterwards;
 *   - (b) a DELETE + same-id RE-CREATE by another owner: the committed row is a
 *     different incarnation, so the re-embed aborts and the replacement row is
 *     left exactly as re-created (its embedding fields are not patched onto it).
 * With audit logging on (Harper's default), dropping the post-staging confirm
 * changes the response from 409 to 2xx; the competitor's row state stands.
 *
 * Seeded rows carry an explicit `visibility` so the boot visibility-backfill
 * migration treats them as already-stamped and never re-puts them (a full-row put
 * with a newer transaction timestamp than a case's own write) while a case runs —
 * measured racing an earlier-started owner PUT (flair#2465 round 5).
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
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";

const PUT_POINT = "memory-put";
// The re-embed's pause AFTER its initial read and BEFORE it computes the vector
// (resources/Memory.ts, the re-embed branch of patch()).
const REEMBED_PAUSE_POINT = "memory-reembed";
// The re-embed's own in-transaction pause, AFTER its write is staged and BEFORE
// its committed-row confirm (resources/Memory.ts, reembedStoredRow).
const REEMBED_STAGED_POINT = "memory-reembed-staged";
const CURRENT_MODEL_ID = getModelId();
// The seed stamp is the CURRENT model's BARE (engine-prefix-stripped) equivalent
// — the same stamp test/integration/reembed-preserves-fields-2296.test.ts uses.
// The boot embedding-stamp migration treats it as current-space (see
// resources/migrations/embedding-stamp.ts's staleCondition), so none of its
// cycles — the boot pass or a delayed follow-up — ever re-embeds a seeded row
// and races the write under test. It is NOT the current id, so a re-embed under
// test (which stamps the engine-qualified `CURRENT_MODEL_ID`) is still visible.
const SEED_MODEL_ID = stripEnginePrefix(CURRENT_MODEL_ID);
const STALE_EMBEDDING = [0.01, 0.02, 0.03];
const ORIGINAL = "the original text about a quiet walk through the produce market";
const EDITED = "an edit about quantum computing research grants and their deadlines";
const REPLACEMENT = "a replacement row another owner re-created under the same id";

interface TestAgent { id: string; publicKey: Uint8Array; secretKey: Uint8Array; }
const newAgent = (id: string): TestAgent => ({ id, ...nacl.sign.keyPair() });
const owner = newAgent("rpo-owner");
const other = newAgent("rpo-other");

let harper: HarperInstance;
let pauseDir: string;
let home: string;
let authHeader: string;

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
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
/** A committed delete of `id` through the admin ops API (a competitor of the re-embed). */
async function deleteRow(id: string): Promise<number> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ operation: "delete", database: "flair", table: "Memory", ids: [id] }),
    signal: AbortSignal.timeout(20_000),
  });
  return res.status;
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
/** An owner PUT over the real HTTP route, signed as `agent`. */
function editAs(agent: TestAgent, id: string, content: string): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PUT", path) },
    body: JSON.stringify({ agentId: agent.id, content }),
    signal: AbortSignal.timeout(60_000),
  });
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
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function seedRow(id: string, agentId: string, content: string, extra: Record<string, unknown> = {}): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    // `visibility` is set so the boot visibility-backfill migration treats this
    // row as already-stamped and never re-puts it. A bare seeded row (no
    // visibility) is a migration candidate; its full-row put carries a newer
    // transaction timestamp than a case's own write, which was measured racing
    // an earlier-started owner PUT and dropping it (flair#2465 round 5).
    records: [{ id, agentId, content, embedding: STALE_EMBEDDING, embeddingModel: SEED_MODEL_ID, visibility: "shared", createdAt: new Date().toISOString(), ...extra }],
  });
}
/** The server's own embedding of `text`, via an ordinary admin PUT of a probe row. */
async function serverEmbedding(text: string): Promise<number[]> {
  const id = `rpo-probe-${randomUUID()}`;
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

/**
 * Arm the re-embed's staged pause, start the PATCH, and once it is paused (its
 * write staged), run `compete`, then release it. Returns the PATCH's response
 * and how the pause ended.
 */
async function withPausedStaged(id: string, compete: () => Promise<unknown>): Promise<{ response: Response; released: string; paused: boolean }> {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${REEMBED_STAGED_POINT}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${REEMBED_STAGED_POINT}`), "");
  const pending = reembedAs(owner, id);
  const paused = await waitFor(join(pauseDir, `paused.${REEMBED_STAGED_POINT}`), 20_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${REEMBED_STAGED_POINT}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${REEMBED_STAGED_POINT}`), "utf8") : "never paused";
  return { response, released, paused };
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2465-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2465-pause-"));
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
  for (const url of [http, ops]) {
    if (url.hostname !== "127.0.0.1" || !(Number(url.port) > 0) || url.port === "9925" || url.port === "9926") {
      throw new Error(`refusing to run against ${url.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
  // Warm the embedding engine once so a writer released inside another writer's
  // lock budget (case (a)) finishes its embed well within it.
  await serverEmbedding("warm-up: the embedding engine loads its model once per process");
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

describe("flair#2465 — a re-embed keeps a concurrent owner edit (real Harper)", () => {
  it("(a) an owner PUT on the re-embed's id waits out the lock and commits on the re-embed's row", async () => {
    const id = "rpo-case-a";
    await seedRow(id, owner.id, ORIGINAL);

    // Pins the LOCK contract for two owner verbs: the re-embed takes the lock
    // first (held here after its initial read, before it embeds and writes); the
    // PUT started while the lock is held waits and, released inside its budget,
    // commits on the re-embed's committed row. No interleaving, and the edit is
    // the committed row — the re-embed does not revert it.
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${REEMBED_PAUSE_POINT}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${REEMBED_PAUSE_POINT}`), "");
    const pendingReembed = reembedAs(owner, id);
    const paused = await waitFor(join(pauseDir, `paused.${REEMBED_PAUSE_POINT}`), 20_000);
    let pendingPut: Promise<Response> | undefined;
    if (paused) {
      pendingPut = editAs(owner, id, EDITED);
      // The re-embed holds the lock, so the PUT cannot commit until the re-embed
      // releases it: while the re-embed is still paused the row is unchanged.
      await Bun.sleep(250);
      expect((await readRow(id))?.content, "the PUT committed while the re-embed held the lock").toBe(ORIGINAL);
      // Release the re-embed: the PUT is waiting on the lock and takes it well
      // inside its 200 x 10 ms budget, then reads the re-embed's committed row.
      writeFileSync(join(pauseDir, `go.${REEMBED_PAUSE_POINT}`), "");
    }
    const reembed = await pendingReembed;
    const put = await pendingPut;
    const released = paused ? readFileSync(join(pauseDir, `released.${REEMBED_PAUSE_POINT}`), "utf8") : "never paused";

    expect(released, "the pause ended by timeout, not by this test").toBe("go");
    expect(reembed.status, await reembed.clone().text()).toBeLessThan(300);
    expect(put?.status, await put?.clone().text()).toBe(200);

    const row = await readRow(id);
    expect(row.content, "the re-embed did not leave the owner's committed edit").toBe(EDITED);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
    // The re-embed re-read the committed row, saw the edited text, and stored the
    // vector for THAT text — never the superseded original.
    const editedVector = await serverEmbedding(EDITED);
    const originalVector = await serverEmbedding(ORIGINAL);
    expect(cosine(row.embedding, editedVector), "the re-embed stored a vector for the superseded text").toBeGreaterThan(0.999);
    expect(cosine(row.embedding, editedVector)).toBeGreaterThan(cosine(row.embedding, originalVector));
  }, 120_000);

  it("(older PUT) a same-id re-embed is refused while the edit holds the lock, and the committed edit stands", async () => {
    const id = "rpo-case-older-put";
    await seedRow(id, owner.id, ORIGINAL);

    // Pins the LOCK contract in the other direction: the PUT takes the lock first
    // (held here after its first read, before its write); the re-embed on the same
    // id cannot take it, waits its whole budget and answers 503 memory_busy. It
    // never reads a snapshot that predates the edit, so it cannot revert it — the
    // edit is the committed row and carries the edit's vector.
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${PUT_POINT}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${PUT_POINT}`), "");
    const pendingPut = editAs(owner, id, EDITED);
    const paused = await waitFor(join(pauseDir, `paused.${PUT_POINT}`), 20_000);
    let reembedStatus = -1;
    let reembedBody: any;
    try {
      if (paused) {
        const refused = await reembedAs(owner, id);
        reembedStatus = refused.status;
        reembedBody = await refused.json();
      }
    } finally {
      writeFileSync(join(pauseDir, `go.${PUT_POINT}`), "");
    }
    const put = await pendingPut;
    const released = paused ? readFileSync(join(pauseDir, `released.${PUT_POINT}`), "utf8") : "never paused";

    expect(released, "the pause ended by timeout, not by this test").toBe("go");
    expect(put.status, await put.clone().text()).toBe(200);
    expect(reembedStatus, JSON.stringify(reembedBody)).toBe(503);
    expect(reembedBody.error).toBe("memory_busy");
    const row = await readRow(id);
    expect(row.content, "the re-embed reverted the committed edit").toBe(EDITED);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
    const editedVector = await serverEmbedding(EDITED);
    expect(cosine(row.embedding, editedVector), "the row's vector is not the edited text's").toBeGreaterThan(0.999);
  }, 120_000);

  it("CONTROL: with no competitor the re-embed stamps the current model and leaves the text", async () => {
    const id = "rpo-case-2";
    await seedRow(id, owner.id, ORIGINAL);
    const res = await reembedAs(owner, id);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const row = await readRow(id);
    expect(row.content).toBe(ORIGINAL);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
  }, 120_000);
});

describe("flair#2465 — the re-embed confirms the committed row after staging (real Harper)", () => {
  it("CONTROL: held at the staged write with no competitor, the re-embed lands", async () => {
    const id = "rpo-staged-ok";
    await seedRow(id, owner.id, ORIGINAL);
    const { response, released, paused } = await withPausedStaged(id, async () => {});
    expect(paused, "the re-embed was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    const row = await readRow(id);
    expect(row.content).toBe(ORIGINAL);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
  }, 120_000);

  it("(a) a delete committed after staging aborts the re-embed and leaves no row", async () => {
    const id = "rpo-staged-delete";
    await seedRow(id, owner.id, ORIGINAL);
    const { response, released, paused } = await withPausedStaged(id, async () => {
      expect(await deleteRow(id), "the committed delete did not succeed").toBe(200);
    });
    expect(paused, "the re-embed was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    // The re-embed's staged write must not resurrect the row from its patch fields.
    expect(await readRow(id), "the re-embed created a row after a committed delete").toBeNull();
    // A gone row is the named 409 refusal, never a silent 2xx.
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
  }, 120_000);

  it("(b) a same-id RE-CREATE by another owner after staging aborts the re-embed and is not overwritten", async () => {
    const id = "rpo-staged-recreate";
    await seedRow(id, owner.id, ORIGINAL);
    const { response, released, paused } = await withPausedStaged(id, async () => {
      expect(await deleteRow(id), "the committed delete did not succeed").toBe(200);
      // Another owner re-creates the same id: a fresh incarnation the re-embed
      // never read or authorized.
      await seedRow(id, other.id, REPLACEMENT);
    });
    expect(paused, "the re-embed was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    const row = await readRow(id);
    expect(row?.agentId, "the replacement row was replaced by the stale re-embed").toBe(other.id);
    expect(row?.content, "the replacement row's content was overwritten").toBe(REPLACEMENT);
    // The re-embed's staged field-only update must not be patched onto the
    // replacement: it keeps the (stale) stamp the re-create gave it.
    expect(row?.embeddingModel, "the stale re-embed's embedding fields were patched onto the replacement").toBe(SEED_MODEL_ID);
    expect(row?.embedding).toEqual(STALE_EMBEDDING);
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
  }, 120_000);
});
