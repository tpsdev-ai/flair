/**
 * reembed-patch-only-2465.test.ts — a background re-embed writes only the
 * embedding fields, and confirms the committed row after staging (flair#2465),
 * real Harper.
 *
 * Harper orders a transaction by its FIRST READ, not its write. The re-embed
 * (`Memory.patch()`'s re-embed branch, driven here by a genuine HTTP PATCH whose
 * body is `{"embedding": null, "embeddingModel": null}`) writes only
 * `embedding`, `embeddingModel`, `updatedAt` and (part 2) `embeddedContentHash`.
 * It used to write the whole row it re-read inside its transaction, so an owner
 * edit that committed while the vector was computed was reverted by the
 * re-embed's full-row put even though the edit's own PUT answered 200.
 *
 * The spawned Harper carries the test-only pause (resources/txn-pause-point.ts,
 * enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, set in
 * this process's environment while this file starts its Harper, then restored).
 *
 * The re-embed is an owner PATCH and the competitor is an owner PUT, so BOTH
 * writers are owner verbs and the per-id memory write lock (flair#2478 slice 1)
 * serializes them: the writer that takes the lock first holds it, and the second
 * is refused `503 memory_busy` when it cannot take the lock within its budget
 * (or `503 write_outcome_unknown` if an attempt observes an outcome-unknown
 * marker for the id), or,
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
 *     left exactly as re-created (its embedding fields are not patched onto it);
 *   - (part 2) a text-only edit: an owner PUT started there is refused 503
 *     memory_busy (the re-embed holds the lock across its staged write and its
 *     commit), and a raw table update, which takes no per-id lock, commits the
 *     edit; the re-embed's text confirmation aborts it with the named 409.
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
import { computeContentHash } from "../../resources/memory-feed-lib.ts";

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
/** A re-embed PATCH over the real HTTP route, as the Basic administrator. */
function reembedAsAdmin(id: string): Promise<Response> {
  return fetch(`${harper.httpURL}/Memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ embedding: null, embeddingModel: null }),
    signal: AbortSignal.timeout(60_000),
  });
}
/** A request over the real HTTP route, signed as `agent`. */
function signedSend(agent: TestAgent, method: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, method, path) },
    body: JSON.stringify(body),
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
async function withPausedStaged(
  id: string,
  compete: () => Promise<unknown>,
  start: () => Promise<Response> = () => reembedAs(owner, id),
): Promise<{ response: Response; released: string; paused: boolean }> {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${REEMBED_STAGED_POINT}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${REEMBED_STAGED_POINT}`), "");
  const pending = start();
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
    // id cannot take it, waits its whole budget and answers 503 memory_busy (no
    // outcome-unknown marker is set here, which would answer write_outcome_unknown). It
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

describe("flair#2465 part 2 — a server-computed re-embed stores the hash of the text it embedded (real Harper)", () => {
  it("CONTROL: a re-embed records the embedded-text hash of the text it embedded", async () => {
    const id = "rpo-hash-control";
    await seedRow(id, owner.id, ORIGINAL);
    const res = await reembedAs(owner, id);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const row = await readRow(id);
    expect(row.content).toBe(ORIGINAL);
    // The binding: the recorded hash is the content hash of the row's text.
    expect(row.embeddedContentHash).toBe(computeContentHash(owner.id, ORIGINAL));
  }, 120_000);

  it("a text edit committed after the re-embed stages its write aborts the staged re-embed; an owner PUT cannot commit there, and the stored vector and hash stay on the row, stale", async () => {
    const id = "rpo-hash-edit-staged";
    // Seed with an explicit binding for the ORIGINAL text and an incarnation
    // token, so the concurrent edit leaves both unchanged and only the TEXT
    // differs — the interleaving a plain identity check cannot see.
    // The seeded vector is the server's full-length vector for ORIGINAL, so the
    // auto-embed backfill (it fills only a vector of 100 entries or fewer) leaves
    // it alone and cannot race the read below.
    const seededHash = computeContentHash(owner.id, ORIGINAL);
    await seedRow(id, owner.id, ORIGINAL, {
      embedding: await serverEmbedding(ORIGINAL), embeddedContentHash: seededHash, instanceToken: randomUUID(),
    });

    let ownerPutStatus = -1;
    let ownerPutBody: any;
    let contentWhileHeld: unknown;
    const { response, released, paused } = await withPausedStaged(id, async () => {
      // The re-embed is an owner PATCH and holds the per-id write lock across its
      // staged write and its commit (flair#2478): an owner PUT of the text edit
      // here cannot take the lock within its budget, is refused 503 memory_busy
      // and writes nothing.
      const full = await readRow(id);
      const path = `/Memory/${encodeURIComponent(id)}`;
      const put = await fetch(`${harper.httpURL}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, "PUT", path) },
        body: JSON.stringify({ ...full, content: EDITED }),
        signal: AbortSignal.timeout(60_000),
      });
      ownerPutStatus = put.status;
      ownerPutBody = await put.json();
      contentWhileHeld = (await readRow(id))?.content;
      // A writer outside the per-id lock (a raw table update) can still commit in
      // this window. It changes ONLY the text: the incarnation token, the stored
      // vector and its hash are left as they are, so the row now holds a vector
      // and hash for the SUPERSEDED text. The re-embed's committed-row
      // confirmation must see the text change (flair#2465).
      await opsCall({ operation: "update", database: "flair", table: "Memory", records: [{ id, content: EDITED }] });
    });

    expect(paused, "the re-embed was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    expect(ownerPutStatus, JSON.stringify(ownerPutBody)).toBe(503);
    expect(ownerPutBody.error).toBe("memory_busy");
    expect(contentWhileHeld, "the owner PUT committed while the re-embed held the lock").toBe(ORIGINAL);
    // The re-embed's staged vector (computed for ORIGINAL) must be discarded by
    // the confirmation, which also requires the embedding text to be unchanged.
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");

    const row = await readRow(id);
    expect(row.content, "the edit did not survive").toBe(EDITED);
    // The re-embed's stamp did not land.
    expect(row.embeddingModel, "the re-embed's stamp landed despite the text change").toBe(SEED_MODEL_ID);
    // The stored binding is still the one for ORIGINAL, so it no longer matches
    // the current text -> the stamp migration's re-queue condition holds.
    expect(row.embeddedContentHash).toBe(seededHash);
    expect(row.embeddedContentHash).not.toBe(computeContentHash(owner.id, EDITED));
  }, 120_000);

  it("a row with no owner to hash with: a text edit committed after the re-embed stages its write still aborts it", async () => {
    const id = "rpo-hash-edit-staged-ownerless";
    // An empty agentId (the schema requires the field, not a non-empty value),
    // so no embedded-text hash exists for either text: only an exact-text
    // comparison tells ORIGINAL from EDITED at the confirmation.
    await seedRow(id, "", ORIGINAL, { instanceToken: randomUUID() });

    const { response, released, paused } = await withPausedStaged(
      id,
      // A text-only edit: every identity field (id, agentId, instanceToken,
      // contentHash, createdAt) is unchanged.
      () => opsCall({ operation: "update", database: "flair", table: "Memory", records: [{ id, content: EDITED }] }),
      () => reembedAsAdmin(id),
    );

    expect(paused, "the re-embed was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    const row = await readRow(id);
    expect(row.content, "the edit did not survive").toBe(EDITED);
    expect(row.embeddingModel, "the re-embed's stamp landed despite the text change").toBe(SEED_MODEL_ID);
    expect(row.embedding).toEqual(STALE_EMBEDDING);
  }, 120_000);
});

describe("flair#2465 part 2 — REST writes: a server-computed hash, a body hash dropped or refused, a carried hash retained (real Harper)", () => {
  const GITHUB_TOKEN = `ghp_${"a".repeat(24)}`;
  const CREDENTIAL_TEXT = `the deploy job reads token=${GITHUB_TOKEN} from the vault`;
  const REDACTED_TEXT = "the deploy job reads token=[redacted] from the vault";
  const TRIGGER = "when a nightly backup job fails to upload its archive";
  const PROCEDURE = "open the job log, find the failed step, and rerun that step once";
  const FORGED = "0123456789abcdef";
  const vectors = new Map<string, number[]>();
  const vectorOf = async (text: string): Promise<number[]> => {
    if (!vectors.has(text)) vectors.set(text, await serverEmbedding(text));
    return vectors.get(text)!;
  };
  /** The row holds the server's vector for `text` and the binding to `text`. */
  async function expectBoundTo(row: any, text: string, other?: string): Promise<void> {
    expect(row, "no stored row").toBeTruthy();
    expect(row.embeddedContentHash, "the binding is not the hash of the embedded text").toBe(computeContentHash(owner.id, text));
    expect(Array.isArray(row.embedding) && row.embedding.length > 100, "no server-computed vector").toBe(true);
    const own = cosine(row.embedding, await vectorOf(text));
    expect(own, "the stored vector is not the server's vector for the embedded text").toBeGreaterThan(0.9999);
    if (other !== undefined) expect(own).toBeGreaterThan(cosine(row.embedding, await vectorOf(other)));
  }
  const skillBody = (id: string, extra: Record<string, unknown> = {}) => ({
    id, agentId: owner.id, tags: ["skill"], trigger: TRIGGER, content: PROCEDURE, embeddedContentHash: FORGED, ...extra,
  });

  it("POST /Memory: a redacted input binds the redacted text; a submitted hash is not kept", async () => {
    const id = `rpo-rest-post-${randomUUID()}`;
    const res = await signedSend(owner, "POST", "/Memory", { id, agentId: owner.id, content: CREDENTIAL_TEXT, embeddedContentHash: FORGED });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const row = await readRow(id);
    expect(row.content).toBe(REDACTED_TEXT);
    await expectBoundTo(row, REDACTED_TEXT);
  }, 120_000);

  it("POST /Memory: a skill binds its trigger, not its content", async () => {
    const id = `rpo-rest-post-skill-${randomUUID()}`;
    const res = await signedSend(owner, "POST", "/Memory", skillBody(id));
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    await expectBoundTo(await readRow(id), TRIGGER, PROCEDURE);
  }, 120_000);

  it("PUT /Memory/<id>: a redacted update binds the redacted text; a submitted hash is not kept", async () => {
    const id = `rpo-rest-put-${randomUUID()}`;
    expect((await signedSend(owner, "POST", "/Memory", { id, agentId: owner.id, content: "the row before the update" })).status).toBeLessThan(300);
    const path = `/Memory/${encodeURIComponent(id)}`;
    const res = await signedSend(owner, "PUT", path, { id, agentId: owner.id, content: CREDENTIAL_TEXT, embeddedContentHash: FORGED });
    expect(res.status, await res.clone().text()).toBe(200);
    const row = await readRow(id);
    expect(row.content).toBe(REDACTED_TEXT);
    await expectBoundTo(row, REDACTED_TEXT);
  }, 120_000);

  it("PUT /Memory/<id>: a skill create binds its trigger, not its content", async () => {
    const id = `rpo-rest-put-skill-${randomUUID()}`;
    const res = await signedSend(owner, "PUT", `/Memory/${encodeURIComponent(id)}`, skillBody(id));
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    await expectBoundTo(await readRow(id), TRIGGER, PROCEDURE);
  }, 120_000);

  it("PATCH /Memory/<id>: a redacted text edit binds the redacted text; a submitted hash is not kept", async () => {
    const id = `rpo-rest-patch-${randomUUID()}`;
    expect((await signedSend(owner, "POST", "/Memory", { id, agentId: owner.id, content: "the row before the patch" })).status).toBeLessThan(300);
    const res = await signedSend(owner, "PATCH", `/Memory/${encodeURIComponent(id)}`, { content: CREDENTIAL_TEXT, embeddedContentHash: FORGED });
    expect(res.status, await res.clone().text()).toBe(200);
    const row = await readRow(id);
    expect(row.content).toBe(REDACTED_TEXT);
    await expectBoundTo(row, REDACTED_TEXT);
  }, 120_000);

  it("PATCH /Memory/<id>: a submitted hash alone is dropped and the stored binding stands", async () => {
    const id = `rpo-rest-patch-hash-${randomUUID()}`;
    const original = "a note about tuning the garden irrigation timer";
    expect((await signedSend(owner, "POST", "/Memory", { id, agentId: owner.id, content: original })).status).toBeLessThan(300);
    const res = await signedSend(owner, "PATCH", `/Memory/${encodeURIComponent(id)}`, { subject: "irrigation", embeddedContentHash: FORGED });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const row = await readRow(id);
    expect(row.subject).toBe("irrigation");
    await expectBoundTo(row, original);
  }, 120_000);

  it("PATCH /Memory/<id> on a skill is refused; its trigger binding stands", async () => {
    const id = `rpo-rest-patch-skill-${randomUUID()}`;
    expect((await signedSend(owner, "POST", "/Memory", skillBody(id))).status).toBeLessThan(300);
    const res = await signedSend(owner, "PATCH", `/Memory/${encodeURIComponent(id)}`, { trigger: "a different trigger", embeddedContentHash: FORGED });
    expect(res.status, await res.clone().text()).toBeGreaterThanOrEqual(400);
    const row = await readRow(id);
    expect(row.trigger).toBe(TRIGGER);
    await expectBoundTo(row, TRIGGER, PROCEDURE);
  }, 120_000);

  it("POST /FeedMemories refuses a submitted embeddedContentHash and stores nothing", async () => {
    const id = `rpo-feed-hash-${randomUUID()}`;
    const res = await signedSend(owner, "POST", "/FeedMemories", { id, agentId: owner.id, content: "a feed note", embeddedContentHash: FORGED });
    const text = await res.text();
    expect(res.status, text.slice(0, 200)).toBe(400);
    expect(JSON.parse(text).error).toBe("feed_embedding_not_writable");
    expect(await readRow(id)).toBeFalsy();
  }, 120_000);

  it("POST /FeedMemories refuses a submitted embeddedContentHash on a skill update; the stored skill is unchanged", async () => {
    const id = `rpo-feed-skill-hash-${randomUUID()}`;
    expect((await signedSend(owner, "POST", "/Memory", skillBody(id))).status).toBeLessThan(300);
    const before = await readRow(id);
    const res = await signedSend(owner, "POST", "/FeedMemories", { ...skillBody(id), content: "a revised procedure" });
    expect(res.status, (await res.clone().text()).slice(0, 200)).toBe(400);
    expect((await res.json()).error).toBe("feed_embedding_not_writable");
    const after = await readRow(id);
    expect(after.content).toBe(PROCEDURE);
    expect(after.validTo ?? null, "the skill was closed").toBeNull();
    expect(after.embeddedContentHash).toBe(before.embeddedContentHash);
  }, 120_000);

  it("a feed skill successor carries the stored vector and binding only over an unchanged trigger", async () => {
    const id = `rpo-feed-skill-${randomUUID()}`;
    expect((await signedSend(owner, "POST", "/Memory", skillBody(id))).status).toBeLessThan(300);
    const head = await readRow(id);
    await expectBoundTo(head, TRIGGER, PROCEDURE);

    // Same trigger, new content: the vector (computed for the trigger) is
    // carried, and so is its binding.
    const { embeddedContentHash: _omit, ...noHash } = skillBody(id);
    const kept = await signedSend(owner, "POST", "/FeedMemories", { ...noHash, content: "a revised procedure that still fits the trigger" });
    const keptBody = await kept.json();
    expect(kept.status, JSON.stringify(keptBody).slice(0, 200)).toBe(200);
    expect(keptBody.id).not.toBe(id);
    const keptRow = await readRow(keptBody.id);
    expect(keptRow.trigger).toBe(TRIGGER);
    expect(keptRow.embedding).toEqual(head.embedding);
    expect(keptRow.embeddedContentHash).toBe(computeContentHash(owner.id, TRIGGER));

    // New trigger: the stored vector is dropped, and with it the binding.
    const NEW_TRIGGER = "when the weekly report email bounces";
    const moved = await signedSend(owner, "POST", "/FeedMemories", { ...noHash, id: keptBody.id, trigger: NEW_TRIGGER });
    const movedBody = await moved.json();
    expect(moved.status, JSON.stringify(movedBody).slice(0, 200)).toBe(200);
    const movedRow = await readRow(movedBody.id);
    expect(movedRow.trigger).toBe(NEW_TRIGGER);
    expect(movedRow.embeddedContentHash, "the old trigger's binding was carried onto a new trigger").not.toBe(computeContentHash(owner.id, TRIGGER));
    if (movedRow.embedding == null) {
      expect(movedRow.embeddedContentHash ?? null).toBeNull();
    } else {
      // The stamp migration re-embedded the successor before this read.
      await expectBoundTo(movedRow, NEW_TRIGGER);
    }
  }, 180_000);

  /** A skill whose stored hash differs from its text's expected hash: created
   *  for TRIGGER (vector and hash for TRIGGER), then its trigger raw-edited. */
  async function staleSkill(id: string, newTrigger: string): Promise<any> {
    expect((await signedSend(owner, "POST", "/Memory", skillBody(id))).status).toBeLessThan(300);
    // Let the POST's auto-embed backfill read (and skip) the row first.
    await new Promise((r) => setTimeout(r, 1_000));
    await opsCall({ operation: "update", database: "flair", table: "Memory", records: [{ id, trigger: newTrigger }] });
    const row = await readRow(id);
    expect(row.trigger).toBe(newTrigger);
    expect(row.embeddedContentHash).toBe(computeContentHash(owner.id, TRIGGER));
    return row;
  }
  /** The successor carried the predecessor's vector AND kept its hash, so it
   *  still differs from the successor's own expected hash. */
  async function expectCarriedWithHash(successorId: string, predecessorId: string, trigger: string): Promise<void> {
    const successor = await readRow(successorId);
    const predecessor = await readRow(predecessorId);
    expect(successor.trigger).toBe(trigger);
    expect(successor.embedding, "the predecessor's vector was not carried").toEqual(predecessor.embedding);
    expect(successor.embeddedContentHash, "the carried vector lost its retained hash").toBe(predecessor.embeddedContentHash);
    expect(successor.embeddedContentHash).not.toBe(computeContentHash(owner.id, trigger));
  }

  it("POST with `supersedes` over a row whose hash differs from its text: the successor keeps the carried vector's hash", async () => {
    const id = `rpo-supersede-post-${randomUUID()}`;
    const NEW_TRIGGER = "when the weekly report email bounces";
    await staleSkill(id, NEW_TRIGGER);
    const nid = `rpo-supersede-post-succ-${randomUUID()}`;
    const res = await signedSend(owner, "POST", "/Memory", skillBody(nid, { supersedes: id, trigger: NEW_TRIGGER, content: "a revised procedure" }));
    expect(res.status, (await res.clone().text()).slice(0, 200)).toBeLessThan(300);
    await expectCarriedWithHash(nid, id, NEW_TRIGGER);
  }, 120_000);

  it("PUT to a new id with `supersedes` over a row whose hash differs from its text: the successor keeps the carried vector's hash", async () => {
    const id = `rpo-supersede-put-${randomUUID()}`;
    const NEW_TRIGGER = "when the weekly report email bounces";
    await staleSkill(id, NEW_TRIGGER);
    const nid = `rpo-supersede-put-succ-${randomUUID()}`;
    const res = await signedSend(owner, "PUT", `/Memory/${encodeURIComponent(nid)}`, skillBody(nid, { supersedes: id, trigger: NEW_TRIGGER, content: "a revised procedure" }));
    expect(res.status, (await res.clone().text()).slice(0, 200)).toBeLessThan(300);
    await expectCarriedWithHash(nid, id, NEW_TRIGGER);
  }, 120_000);

  it("a feed skill successor of a row with a hash but no vector carries no hash", async () => {
    const id = `rpo-feed-skill-novec-${randomUUID()}`;
    expect((await signedSend(owner, "POST", "/Memory", skillBody(id))).status).toBeLessThan(300);
    // The POST's auto-embed backfill reads the row as soon as the response is
    // sent (and skips it: the vector is full-length). Let that read finish, so
    // it cannot see the cleared vector below and refill it.
    await new Promise((r) => setTimeout(r, 1_000));
    // Clear only the vector. The current-space `embeddingModel` stays, so the
    // stamp migration does not select this row (or its successor) to re-embed.
    await opsCall({ operation: "update", database: "flair", table: "Memory", records: [{ id, embedding: null }] });
    const source = await readRow(id);
    expect(source.embedding ?? null).toBeNull();
    expect(source.embeddedContentHash).toBe(computeContentHash(owner.id, TRIGGER));

    // Same trigger, new content, no body `embedding`: the text is unchanged, but
    // there is no stored vector for the hash to describe.
    const { embeddedContentHash: _omit, ...noHash } = skillBody(id);
    const res = await signedSend(owner, "POST", "/FeedMemories", { ...noHash, content: "a revised procedure that still fits the trigger" });
    const body = await res.json();
    expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(200);
    expect(body.id).not.toBe(id);
    const successor = await readRow(body.id);
    expect(successor.trigger).toBe(TRIGGER);
    expect(successor.embedding ?? null).toBeNull();
    expect(successor.embeddedContentHash ?? null, "a hash was carried without a vector").toBeNull();
  }, 120_000);
});
