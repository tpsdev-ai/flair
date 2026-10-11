/**
 * reembed-patch-only-2465.test.ts — a background re-embed does not lose a
 * concurrent edit to the same Memory row (flair#2465), real Harper.
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
 * `memory-put` holds an owner PUT inside its own transaction, after its first
 * read and before its write. An edit is started there (so its transaction opens
 * FIRST), the re-embed runs to completion while it is held, then the PUT is
 * released: the edit's write is ordered after the re-embed's.
 *
 * `memory-reembed-write` holds the re-embed's own owned transaction, after its
 * re-read and before its write. The third case commits a DELETE of the row
 * there: the re-embed must not resurrect the row from its patch fields (Harper's
 * audit-off commit path builds a record from an absent record's patch fields).
 * It re-reads the COMMITTED row before writing and skips with not_found, so no
 * row — and never a partial one carrying only id + the embedding fields — exists
 * after. Dropping that committed re-read makes this case fail (the re-embed
 * answers 2xx for a row it did not write).
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

const PUT_POINT = "memory-put";
// The re-embed's own in-transaction pause (resources/Memory.ts, reembedStoredRow).
const REEMBED_WRITE_POINT = "memory-reembed-write";
const CURRENT_MODEL_ID = getModelId();
const STALE_MODEL = "some-ancient-model-v0";
const STALE_EMBEDDING = [0.01, 0.02, 0.03];
const ORIGINAL = "the original text about a quiet walk through the produce market";
const EDITED = "an edit about quantum computing research grants and their deadlines";

interface TestAgent { id: string; publicKey: Uint8Array; secretKey: Uint8Array; }
const newAgent = (id: string): TestAgent => ({ id, ...nacl.sign.keyPair() });
const owner = newAgent("rpo-owner");

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

async function seedRow(id: string, agentId: string, extra: Record<string, unknown> = {}): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{ id, agentId, content: ORIGINAL, embedding: STALE_EMBEDDING, embeddingModel: STALE_MODEL, createdAt: new Date().toISOString(), ...extra }],
  });
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
    records: [{ id: owner.id, name: owner.id, role: "agent", publicKey: Buffer.from(owner.publicKey).toString("base64"), createdAt: now }],
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2465 — a re-embed keeps a concurrent owner edit (real Harper)", () => {
  it("an owner PUT that starts before the re-embed and commits after it keeps its edit", async () => {
    const id = "rpo-case-1";
    await seedRow(id, owner.id);

    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${PUT_POINT}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${PUT_POINT}`), "");
    // The PUT opens its transaction and reads the row, then is held before its write.
    const pendingPut = editAs(owner, id, EDITED);
    const paused = await waitFor(join(pauseDir, `paused.${PUT_POINT}`), 20_000);
    let reembedStatus = -1;
    try {
      if (paused) {
        // The re-embed runs to completion while the edit is held.
        const reembed = await reembedAs(owner, id);
        reembedStatus = reembed.status;
      }
    } finally {
      writeFileSync(join(pauseDir, `go.${PUT_POINT}`), "");
    }
    const putResponse = await pendingPut;
    const released = paused ? readFileSync(join(pauseDir, `released.${PUT_POINT}`), "utf8") : "never paused";

    expect(released, "the pause ended by timeout, not by this test").toBe("go");
    expect(reembedStatus, "the re-embed did not answer 2xx").toBeLessThan(300);
    expect(putResponse.status, await putResponse.clone().text()).toBe(200); // the PUT's 200 is true

    const row = await readRow(id);
    expect(row.content, "the re-embed reverted the owner's committed edit").toBe(EDITED);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID); // the re-embed landed
  }, 120_000);

  it("CONTROL: with no competitor the re-embed stamps the current model and leaves the text", async () => {
    const id = "rpo-case-2";
    await seedRow(id, owner.id);
    const res = await reembedAs(owner, id);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const row = await readRow(id);
    expect(row.content).toBe(ORIGINAL);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
  }, 120_000);

  it("a delete committed while the re-embed is paused leaves no row — never a partial one", async () => {
    const id = "rpo-case-3";
    await seedRow(id, owner.id);

    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${REEMBED_WRITE_POINT}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${REEMBED_WRITE_POINT}`), "");
    const pendingReembed = reembedAs(owner, id);
    const paused = await waitFor(join(pauseDir, `paused.${REEMBED_WRITE_POINT}`), 20_000);
    let deleteStatus = -1;
    try {
      if (paused) {
        // The row is deleted (committed) while the re-embed's owned transaction is held.
        deleteStatus = await deleteRow(id);
      }
    } finally {
      writeFileSync(join(pauseDir, `go.${REEMBED_WRITE_POINT}`), "");
    }
    const res = await pendingReembed;
    const released = paused ? readFileSync(join(pauseDir, `released.${REEMBED_WRITE_POINT}`), "utf8") : "never paused";

    expect(released, "the pause ended by timeout, not by this test").toBe("go");
    expect(deleteStatus, "the committed delete did not succeed").toBe(200);
    // The re-embed's write must not resurrect the row from its patch fields.
    const row = await readRow(id);
    expect(row, "the re-embed created a row (partial record) after a committed delete").toBeNull();
    // A gone row is a named refusal, never a silent 2xx.
    expect(res.status, await res.clone().text()).toBe(404);
  }, 120_000);
});
