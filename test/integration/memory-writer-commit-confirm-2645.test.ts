/**
 * memory-writer-commit-confirm-2645.test.ts — real-Harper interleavings for
 * Memory writers whose write loses to a NEWER full write of the same row
 * (flair#2645).
 *
 * Harper can resolve a transaction's commit while dropping a write that lost
 * to a newer full write, and still commit the rest of that transaction. These
 * cases record whether the writer refuses or retries instead of answering
 * success with its effect missing.
 *
 * Each case holds a writer at its own test-only pause point (one of the
 * existing points; see resources/txn-pause-point.ts), commits a newer full
 * record to the same row through the lock-bypassing operations API, releases
 * the writer, and reads the committed state back. The newer record is a copy
 * of the stored row with a new `content`, so the identity fields the writers
 * compare (instanceToken, contentHash, createdAt, agentId) do not move.
 *
 * Real Harper, ephemeral instance; every URL is asserted to be this test's own
 * instance before the first call.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`mwc-owner-${sfx}`);
const peerKeys = nacl.sign.keyPair();
const PEER = `mwc-peer-${sfx}`;
const now = () => new Date().toISOString();

let harper: HarperInstance;
let pauseDir = "";
let seq = 0;
const nextId = (label: string) => `mwc-${label}-${sfx}-${++seq}`;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function memoryRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"] });
  return (rows as any[])[0] ?? null;
}

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function call(auth: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(harper.httpURL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519(auth, method, path) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

async function seedRow(id: string, content: string, extra: Record<string, unknown> = {}): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id, agentId: A.id, content, contentHash: id, visibility: "shared", archived: false,
      durability: "persistent", instanceToken: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z", embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(),
      ...extra,
    }],
  });
}

/** Commit a NEWER full record to the row through the ops API (no write lock):
 *  a copy of the stored row with a new content, so identity fields do not move. */
async function commitNewerFullWrite(id: string, content: string): Promise<void> {
  const current = await memoryRow(id);
  expect(current, "the row is missing before the competing write").not.toBeNull();
  await ops({
    operation: "put", database: "flair", table: "Memory",
    records: [{ ...current, content, updatedAt: now() }],
  });
  expect((await memoryRow(id))?.content, "the competing write is not visible while the writer is paused").toBe(content);
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Arm `point`, start `trigger`, run `compete` once it is paused, release, await it. */
async function withPaused(point: string, trigger: () => Promise<Response>, compete: () => Promise<void>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, released, paused };
}

/** One signed FederationSync push of a single Memory record from PEER. */
async function federatedPush(record: Record<string, unknown>): Promise<Response> {
  const body = signBodyFresh(
    { instanceId: PEER, records: [{ table: "Memory", originatorInstanceId: PEER, ...record }], lamportClock: Date.now() },
    peerKeys.secretKey,
  );
  return fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2645-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [{ id: A.id, name: A.id, role: "agent", publicKey: A.publicKey, createdAt: now() }],
  });
  await ops({
    operation: "upsert", database: "flair", table: "Peer",
    records: [{ id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: now() }],
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2645 — Memory writers under a newer full write", () => {
  it("owner PUT: a newer full write committed after its staged write makes the PUT refuse by name", async () => {
    const id = nextId("put");
    await seedRow(id, "put v1");
    const NEWER = "put v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "memory-put-staged",
      () => call(A, "PUT", memPath(id), { id, agentId: A.id, content: "put v2-this-writer" }),
      () => commitNewerFullWrite(id, NEWER),
    );
    expect(paused, "the owner PUT was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    expect((await memoryRow(id))?.content, "the newer committed write was overwritten").toBe(NEWER);
  }, 120_000);

  it("owner PATCH: a content-declaring PATCH refuses by name when a newer full write commits after its read", async () => {
    const id = nextId("patch");
    await seedRow(id, "patch v1");
    const NEWER = "patch v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "memory-patch",
      () => call(A, "PATCH", memPath(id), { agentId: A.id, content: "patch v2-this-writer" }),
      () => commitNewerFullWrite(id, NEWER),
    );
    expect(paused, "the owner PATCH was not paused before its write").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    expect((await memoryRow(id))?.content, "the newer committed write was overwritten").toBe(NEWER);
  }, 120_000);

  it("supersede close: a newer full write committed after the close is staged makes the close retry and land", async () => {
    const target = nextId("supersede-target");
    const successor = nextId("supersede-successor");
    await seedRow(target, "supersede target v1");
    const NEWER = "supersede target v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "supersede-close-staged",
      () => call(A, "PUT", memPath(successor), {
        id: successor, agentId: A.id, supersedes: target,
        content: "successor written before the paused close",
      }),
      () => commitNewerFullWrite(target, NEWER),
    );
    expect(paused, "the supersede close was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBeLessThan(300);
    const row = await memoryRow(target);
    expect(row?.content, "the newer committed write was overwritten by the close").toBe(NEWER);
    expect(typeof row?.validTo, `the close did not land on the newer row: ${JSON.stringify(row)}`).toBe("string");
  }, 120_000);

  it("usage-count bump: a newer full write committed before its write is bumped on the committed row", async () => {
    const id = nextId("usage");
    await seedRow(id, "usage v1");
    const NEWER = "usage v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "usage-count",
      () => call(A, "POST", "/RecordUsage", { memoryIds: [id] }),
      () => commitNewerFullWrite(id, NEWER),
    );
    expect(paused, "the usage-count bump was not paused").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(200);
    const row = await memoryRow(id);
    expect(row?.content, "the newer committed write was overwritten by the bump").toBe(NEWER);
    expect(row?.usageCount, `the bump did not land on the committed row: ${JSON.stringify(row)}`).toBe(1);
  }, 120_000);

  it("re-embed PATCH: a newer full write committed after the vector is staged makes the PATCH refuse by name", async () => {
    const id = nextId("reembed");
    await seedRow(id, "reembed v1");
    const NEWER = "reembed v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "memory-reembed-staged",
      () => call(A, "PATCH", memPath(id), { id, embedding: null, embeddingModel: null }),
      () => commitNewerFullWrite(id, NEWER),
    );
    expect(paused, "the re-embed PATCH was not paused after staging its update").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    expect((await memoryRow(id))?.content, "the newer committed write was overwritten").toBe(NEWER);
  }, 120_000);

  it("re-embed PATCH: a newer full write committed in the confirmation-to-commit gap is retried and the vector lands on it", async () => {
    const id = nextId("reembed-gap");
    await seedRow(id, "reembed gap v1");
    const NEWER = "reembed gap v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "memory-reembed-commit",
      () => call(A, "PATCH", memPath(id), { id, embedding: null, embeddingModel: null }),
      () => commitNewerFullWrite(id, NEWER),
    );
    expect(paused, `the re-embed PATCH was not paused at its commit gap (status ${response.status}: ${(await response.clone().text()).slice(0, 200)})`).toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBeLessThan(300);
    const row = await memoryRow(id);
    expect(row?.content, "the newer committed write was reverted").toBe(NEWER);
    expect(row?.embeddingModel, "the retried re-embed did not stamp the current model").toBe(getModelId());
    expect(Array.isArray(row?.embedding) && row.embedding.length > 3, "the retried re-embed stored no usable vector").toBe(true);
  }, 120_000);

  it("re-embed PATCH: deletion after commit and before read-back retries to not_found", async () => {
    const id = nextId("reembed-deleted");
    await seedRow(id, "reembed deleted after commit");
    const { response, paused, released } = await withPaused(
      "memory-reembed-verify",
      () => call(A, "PATCH", memPath(id), { id, embedding: null, embeddingModel: null }),
      async () => {
        const committed = await memoryRow(id);
        expect(Array.isArray(committed?.embedding) && committed.embedding.length > 3).toBe(true);
        await ops({ operation: "delete", database: "flair", table: "Memory", hash_values: [id] });
        expect(await memoryRow(id)).toBeNull();
      },
    );
    expect(paused, "the re-embed PATCH was not paused before read-back").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text).toBe(404);
    expect(JSON.parse(text).error).toBe("not found");
    expect(await memoryRow(id)).toBeNull();
  }, 120_000);

  it("federation merge: a newer full write committed after its read is refused as merge_target_changed", async () => {
    const id = nextId("federation");
    await seedRow(id, "federation v1");
    const NEWER = "federation v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "federation-merge",
      () => federatedPush({ id, updatedAt: now(), data: { id, agentId: A.id, content: "federation v2-from-the-peer", visibility: "shared", createdAt: "2026-01-01T00:00:00.000Z" } }),
      () => commitNewerFullWrite(id, NEWER),
    );
    expect(paused, "the federation merge was not paused").toBe(true);
    expect(released).toBe("go");
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body).slice(0, 300)).toBe(200);
    expect(body.merged, JSON.stringify(body)).toBe(0);
    expect(body.skippedReasons?.merge_target_changed, JSON.stringify(body)).toBe(1);
    expect((await memoryRow(id))?.content, "the newer committed write was overwritten by the merge").toBe(NEWER);
  }, 120_000);
});

