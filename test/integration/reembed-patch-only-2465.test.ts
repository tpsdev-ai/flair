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
 * `memory-reembed` holds the re-embed AFTER its initial read and BEFORE it
 * embeds. The deterministic case starts an owner PUT there, lets it commit, then
 * releases the re-embed: the PUT's transaction opens after the re-embed's read,
 * so Harper orders the re-embed's (newer) field-only write after the PUT and the
 * edit survives — independent of the audit walk.
 *
 * `memory-put` holds an owner PUT inside its own transaction, after its first
 * read and before its write, so its transaction opens FIRST. The re-embed then
 * runs to completion while it is held, and the PUT is released: the PUT's full
 * update is OLDER than the re-embed's write. Harper's out-of-order reconciliation
 * of an older full update is best-effort (the audit walk folds the newer write
 * into it, or misses and drops it), so that ordering is documented, not asserted
 * — see the `(older PUT)` case.
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
  it("(a) an owner PUT that starts after the re-embed's read and commits while it runs keeps its edit", async () => {
    const id = "rpo-case-a";
    await seedRow(id, owner.id, ORIGINAL);

    // Hold the re-embed after its initial read, before it embeds and writes.
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${REEMBED_PAUSE_POINT}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${REEMBED_PAUSE_POINT}`), "");
    const pendingReembed = reembedAs(owner, id);
    const paused = await waitFor(join(pauseDir, `paused.${REEMBED_PAUSE_POINT}`), 20_000);
    let putStatus = -1;
    try {
      if (paused) {
        // This PUT's transaction opens AFTER the re-embed's read and commits while
        // the re-embed is still paused — the window this PR is about.
        putStatus = (await editAs(owner, id, EDITED)).status;
      }
    } finally {
      writeFileSync(join(pauseDir, `go.${REEMBED_PAUSE_POINT}`), "");
    }
    const reembed = await pendingReembed;
    const released = paused ? readFileSync(join(pauseDir, `released.${REEMBED_PAUSE_POINT}`), "utf8") : "never paused";

    expect(released, "the pause ended by timeout, not by this test").toBe("go");
    expect(putStatus, "the owner PUT did not answer 200").toBe(200);
    expect(reembed.status, await reembed.clone().text()).toBeLessThan(300);

    const row = await readRow(id);
    expect(row.content, "the re-embed reverted the owner's committed edit").toBe(EDITED);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
    // The re-embed re-read the committed row, saw the edited text, and stored the
    // vector for THAT text — never the superseded original.
    const editedVector = await serverEmbedding(EDITED);
    const originalVector = await serverEmbedding(ORIGINAL);
    expect(cosine(row.embedding, editedVector), "the re-embed stored a vector for the superseded text").toBeGreaterThan(0.999);
    expect(cosine(row.embedding, editedVector)).toBeGreaterThan(cosine(row.embedding, originalVector));
  }, 120_000);

  it("(older PUT) an owner PUT that starts before the re-embed and commits after it documents Harper's best-effort reconciliation; the edit's survival is not asserted", async () => {
    const id = "rpo-case-older-put";
    await seedRow(id, owner.id, ORIGINAL);

    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${PUT_POINT}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${PUT_POINT}`), "");
    // The PUT opens its transaction and reads the row, then is held before its write,
    // so its transaction opens BEFORE the re-embed's.
    const pendingPut = editAs(owner, id, EDITED);
    const paused = await waitFor(join(pauseDir, `paused.${PUT_POINT}`), 20_000);
    let reembedStatus = -1;
    try {
      if (paused) {
        // The re-embed runs to completion while the edit is held.
        reembedStatus = (await reembedAs(owner, id)).status;
      }
    } finally {
      writeFileSync(join(pauseDir, `go.${PUT_POINT}`), "");
    }
    const put = await pendingPut;
    const released = paused ? readFileSync(join(pauseDir, `released.${PUT_POINT}`), "utf8") : "never paused";

    expect(released, "the pause ended by timeout, not by this test").toBe("go");
    expect(reembedStatus, "the re-embed did not answer 2xx").toBeLessThan(300);
    expect(put.status, "the owner PUT did not answer 200").toBe(200);
    // Harper orders by first read: this PUT's transaction is OLDER than the
    // re-embed's write. Harper reconciles the older full update best-effort —
    // folding the newer write into it (the edit survives) or superseding it (the
    // edit does not). Both 200s above always hold. This case does not assert edit
    // survival: the result depends on the re-embed's write type and Harper's
    // reconciliation. The deterministic case above is what this PR guarantees.
    const row = await readRow(id);
    expect(row, "the row vanished entirely").not.toBeNull();
    expect([ORIGINAL, EDITED], `row.content was neither the original nor the edit: ${JSON.stringify(row?.content)}`).toContain(row?.content);
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

describe("flair#2465 part 2 — the stored vector is bound to its text (real Harper)", () => {
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

  it("a text edit committed after the re-embed stages its write aborts it: the vector for the superseded text is not stored, and the row is left stale", async () => {
    const id = "rpo-hash-edit-staged";
    // Seed with an explicit binding for the ORIGINAL text and an incarnation
    // token, so the concurrent PUT carries both unchanged and only the TEXT
    // differs — the interleaving a plain identity check cannot see.
    await seedRow(id, owner.id, ORIGINAL, { embeddedContentHash: computeContentHash(owner.id, ORIGINAL), instanceToken: randomUUID() });

    const { response, released, paused } = await withPausedStaged(id, async () => {
      // Change ONLY the text, but carry the stored vector (a supplied vector is
      // kept by the write path), so the row now holds a vector for the
      // SUPERSEDED text. This is the interleaving the re-embed cannot see with a
      // plain identity check, because the incarnation token and hash fields are
      // carried unchanged.
      const full = await readRow(id);
      const path = `/Memory/${encodeURIComponent(id)}`;
      const put = await fetch(`${harper.httpURL}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, "PUT", path) },
        body: JSON.stringify({ ...full, content: EDITED }),
        signal: AbortSignal.timeout(60_000),
      });
      expect(put.status, await put.clone().text()).toBe(200);
    });

    expect(paused, "the re-embed was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    // The re-embed's staged vector (computed for ORIGINAL) must be discarded by
    // the confirmation, which now also requires the embedding text to be unchanged.
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");

    const row = await readRow(id);
    expect(row.content, "the edit did not survive").toBe(EDITED);
    // The re-embed's stamp did not land.
    expect(row.embeddingModel, "the re-embed's stamp landed despite the text change").toBe(SEED_MODEL_ID);
    // The recorded binding no longer matches the current text -> the stamp
    // migration's re-queue condition holds.
    expect(row.embeddedContentHash).not.toBe(computeContentHash(owner.id, EDITED));
  }, 120_000);
});
