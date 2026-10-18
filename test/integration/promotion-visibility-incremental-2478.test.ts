/**
 * promotion-visibility-incremental-2478.test.ts — flair#2478 slice 2, real Harper.
 *
 * The visibility backfill and both promotion stamps write incremental updates
 * under the per-memory-id write lock. These cases race owner PUT/PATCH against
 * the backfill and automatic stamp; manual promotion is tested for its bound
 * verdict:
 *
 * - The backfill holds its id's lock at a pause point (before its write, or
 *   after its commit while still locked); an owner PUT/PATCH to that id is
 *   refused `503 memory_busy`, then succeeds after release, and the owner's
 *   content and visibility are stored.
 * - An owner PUT that commits first is left untouched: the backfill only
 *   fills a missing visibility.
 * - Both promotion stamps write a `promotionContentHash` bound to the stored
 *   text; an owner PUT/PATCH racing the automatic stamp is refused while the
 *   stamp holds the lock, and the verdict lands on release.
 * - A client cannot set the hash; a raw (guard-bypassing) content change makes
 *   the binding mismatch, and GET/search/SemanticSearch/AdminMemory suppress
 *   the verdict.
 *
 * Home-isolated ephemeral Harper; no external instance.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";

/** The boot migration cycle finished cleanly (same guard as the #2470 file). */
function cycleCompletedCleanly(migrations: any): boolean {
  if (migrations?.cyclePhase !== "done" || migrations?.lastCycleError) return false;
  if (!Array.isArray(migrations?.migrations)) return false;
  return migrations.migrations.length > 0 && migrations.migrations.every((m: any) => m?.state === "completed");
}
async function waitForCycleDone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
    if (res.ok) {
      const detail: any = await res.json();
      if (cycleCompletedCleanly(detail?.migrations)) return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

interface TestAgent { id: string; publicKey: Uint8Array; secretKey: Uint8Array; }
const newAgent = (id: string): TestAgent => ({ id, ...nacl.sign.keyPair() });
const owner = newAgent("pvi-owner");

const SEED_MODEL_ID = stripEnginePrefix(getModelId());
const V1 = "pvi-v1";
const V2 = "pvi-v2";
const V3 = "pvi-v3";
const V1_OWNER = "owner PUT committed before the backfill";
const V2_OWNER = "owner edit kept after the backfill released its lock";
const V3_OWNER = "owner patch kept after the backfill committed";
const AUTO_CLAIM = "Auto promotion claim about release verification for slice two.";
const MANUAL_CLAIM = "Manual promotion claim about deploy verification for slice two.";
const AUTO_TAG = "adk:app:alice";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

let harper: HarperInstance;
let installDir: string;
let home: string;
let pauseDir: string;
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
  const rows = await opsCall({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}
async function seedMemory(row: Record<string, unknown>): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      agentId: owner.id, content: "seed", durability: "standard",
      embedding: [0.1, 0.2, 0.3], embeddingModel: SEED_MODEL_ID,
      instanceToken: randomUUID(), createdAt: new Date().toISOString(), ...row,
    }],
  });
}
async function seedCandidate(id: string, claim: string, scopeTag?: string): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "MemoryCandidate",
    records: [{
      id, agentId: owner.id, claim, status: "pending",
      generatedAt: new Date().toISOString(), generatedBy: "test-seed",
      sourceMemoryIds: [], ...(scopeTag ? { scopeTag } : {}),
    }],
  });
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${agent.id}:${ts}:${nonce}:${method}:${path}`), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
function memoryWrite(agent: TestAgent, method: "PUT" | "PATCH", id: string, body: Record<string, unknown>): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, method, path) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}
function promote(candidateId: string): Promise<Response> {
  const path = "/PromoteMemoryCandidate";
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, "POST", path) },
    body: JSON.stringify({ candidateId, rationale: "reviewed the claim" }),
    signal: AbortSignal.timeout(60_000),
  });
}
function autoPromote(): Promise<Response> {
  const path = "/AutoPromoteCandidates";
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, "POST", path) },
    body: JSON.stringify({ agentId: owner.id }),
    signal: AbortSignal.timeout(120_000),
  });
}
function semanticSearch(body: Record<string, unknown>): Promise<Response> {
  const path = "/SemanticSearch";
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, "POST", path) },
    body: JSON.stringify({ agentId: owner.id, limit: 100, ...body }),
    signal: AbortSignal.timeout(60_000),
  });
}
async function feedRow(id: string, authorization: string): Promise<any> {
  const ctrl = new AbortController();
  try {
    const res = await fetch(`${harper.httpURL}/FeedMemories/${encodeURIComponent(id)}`, {
      headers: { Accept: "text/event-stream", Authorization: authorization },
      signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)]),
    });
    expect(res.status).toBe(200);
    if (!res.body) throw new Error("feed response has no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`feed ended before row ${id}`);
      raw += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = raw.indexOf("\n\n")) >= 0) {
        const frame = raw.slice(0, cut);
        raw = raw.slice(cut + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        if (String(event.id) === id && event.value) return event.value;
      }
    }
  } finally {
    ctrl.abort();
  }
}
function expectSuppressed(row: any): void {
  expect(row).toBeTruthy();
  for (const field of ["promotionStatus", "promotedAt", "promotedBy", "promotionContentHash"]) {
    expect(row[field], field).toBeNull();
  }
}
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
function clearMarkers(point: string): void {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
}
function arm(point: string): void {
  clearMarkers(point);
  writeFileSync(join(pauseDir, `arm.${point}`), "");
}
async function assertPaused(point: string): Promise<void> {
  expect(await waitFor(join(pauseDir, `paused.${point}`), 30_000), `${point} was never paused`).toBe(true);
}
async function release(point: string): Promise<void> {
  writeFileSync(join(pauseDir, `go.${point}`), "");
  const path = join(pauseDir, `released.${point}`);
  const deadline = Date.now() + 30_000;
  let text = "";
  while (Date.now() < deadline) {
    if (existsSync(path)) text = readFileSync(path, "utf8");
    if (text) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(text, "the pause ended by timeout").toBe("go");
}
async function waitForField(id: string, field: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await readRow(id);
    if (row?.[field] != null) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return readRow(id);
}
function assertOwnInstance(): void {
  for (const u of [new URL(harper.httpURL), new URL(harper.opsURL)]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!harper.installDir.startsWith(tmpdir())) throw new Error("refusing to run: not a temp install");
}

async function bootFirst(): Promise<void> {
  harper = await startHarper({ homeDir: home });
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
  assertOwnInstance();
  expect(await waitForCycleDone(60_000), "the first boot migration cycle did not finish").toBe(true);
  await opsCall({
    operation: "upsert", database: "flair", table: "Agent",
    records: [{
      id: owner.id, name: owner.id, role: "agent",
      publicKey: Buffer.from(owner.publicKey).toString("base64"), createdAt: new Date().toISOString(),
    }],
  });
  await seedMemory({ id: V1, content: "owner-first seed" });
  await seedMemory({ id: V2, content: "writer-first seed" });
  // Owner first: this visibility makes V1 ineligible for the backfill.
  const put = await memoryWrite(owner, "PUT", V1, { agentId: owner.id, content: V1_OWNER, visibility: "shared" });
  expect(put.status, await put.clone().text()).toBe(200);
  installDir = harper.installDir;
  await stopHarper(harper, { keepInstallDir: true });
}

async function bootWithFaultInjection(point: string): Promise<void> {
  clearMarkers(point);
  arm(point);
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper({ installDir, homeDir: home });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
  assertOwnInstance();
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478s2-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478s2-pause-"));
  await bootFirst();
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("visibility backfill is incremental and locked (real Harper)", () => {
  it("owner PUT and PATCH are refused while the backfill holds the id, then the owner's values are stored", async () => {
    await bootWithFaultInjection("visibility-backfill");
    await assertPaused("visibility-backfill");

    const putDenied = await memoryWrite(owner, "PUT", V2, { agentId: owner.id, content: V2_OWNER, visibility: "shared" });
    expect(putDenied.status, await putDenied.clone().text()).toBe(503);
    expect((await putDenied.json() as any).error).toBe("memory_busy");
    const patchDenied = await memoryWrite(owner, "PATCH", V2, { agentId: owner.id, content: V2_OWNER, visibility: "shared" });
    expect(patchDenied.status, await patchDenied.clone().text()).toBe(503);

    await release("visibility-backfill");
    const backfilled = await waitForField(V2, "visibility", 30_000);
    expect(backfilled?.visibility).toBe("private");

    const put = await memoryWrite(owner, "PUT", V2, { agentId: owner.id, content: V2_OWNER, visibility: "shared" });
    expect(put.status, await put.clone().text()).toBe(200);
    const stored = await readRow(V2);
    expect(stored.content).toBe(V2_OWNER);
    expect(stored.visibility).toBe("shared");

    // Owner-first row V1: the backfill was never eligible for it.
    const untouched = await readRow(V1);
    expect(untouched.content).toBe(V1_OWNER);
    expect(untouched.visibility).toBe("shared");
  }, 180_000);

  it("a PATCH is refused while the backfill holds its id after committing, then lands", async () => {
    // A migration this data dir already completed does not run again, so this
    // phase needs its own fresh install with one eligible row.
    await stopHarper(harper, { keepInstallDir: true }).catch(() => {});
    home = mkdtempSync(join(tmpdir(), "flair-2478s2-committed-home-"));
    harper = await startHarper({ homeDir: home });
    authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
    expect(await waitForCycleDone(60_000), "the seed boot migration cycle did not finish").toBe(true);
    await opsCall({
      operation: "upsert", database: "flair", table: "Agent",
      records: [{
        id: owner.id, name: owner.id, role: "agent",
        publicKey: Buffer.from(owner.publicKey).toString("base64"), createdAt: new Date().toISOString(),
      }],
    });
    await seedMemory({ id: V3, content: "committed-pause seed" });
    installDir = harper.installDir;
    await stopHarper(harper, { keepInstallDir: true });

    await bootWithFaultInjection("visibility-backfill-committed");
    await assertPaused("visibility-backfill-committed");

    const patchDenied = await memoryWrite(owner, "PATCH", V3, { agentId: owner.id, content: V3_OWNER, visibility: "shared" });
    expect(patchDenied.status, await patchDenied.clone().text()).toBe(503);
    expect((await patchDenied.json() as any).error).toBe("memory_busy");
    await release("visibility-backfill-committed");

    const patch = await memoryWrite(owner, "PATCH", V3, { agentId: owner.id, content: V3_OWNER, visibility: "shared" });
    expect(patch.status, await patch.clone().text()).toBe(204);
    const stored = await readRow(V3);
    expect(stored.content).toBe(V3_OWNER);
    expect(stored.visibility).toBe("shared");
  }, 180_000);
});

describe("promotion stamps are locked, incremental and bound (real Harper)", () => {
  it.each(["matching", "mismatched", "legacy"])("admin selections check a %s promotion binding", async (binding) => {
    const id = `pvi-selected-${binding}`;
    const content = "selected promotion content";
    await seedMemory({
      id, content, promotionStatus: "approved", promotedAt: new Date().toISOString(), promotedBy: owner.id,
      ...(binding === "legacy" ? {} : { promotionContentHash: sha256(binding === "matching" ? content : "old content") }),
    });
    const status = binding === "matching" ? "approved" : null;
    const get = async (path: string) => {
      const response = await fetch(`${harper.httpURL}${path}`, {
        headers: { Authorization: authHeader }, signal: AbortSignal.timeout(30_000),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    };
    const path = `/Memory/${encodeURIComponent(id)}`;
    expect(await get(`${path}.promotionStatus`)).toBe(status);
    expect(await get(`${path}?select(promotionStatus)`)).toBe(status);
    expect(await get(`${path}?select(id,promotionStatus)`)).toEqual({ id, promotionStatus: status });
    expect(await get(`/Memory/?id=${encodeURIComponent(id)}&select(id,promotionStatus)`)).toEqual([{ id, promotionStatus: status }]);
    expect(await get(`/Memory/?id=${encodeURIComponent(id)}&select(promotionStatus)`)).toEqual([status]);
  }, 120_000);

  it("the automatic stamp holds the id; owner PUT/PATCH are refused, then the bound verdict lands", async () => {
    await seedCandidate("pvi-auto-cand", AUTO_CLAIM, AUTO_TAG);
    arm("promotion-stamp");
    const sweep = autoPromote();
    await assertPaused("promotion-stamp");

    const rows = await opsCall({
      operation: "search_by_value", database: "flair", table: "Memory",
      search_attribute: "agentId", search_value: owner.id, get_attributes: ["*"],
    });
    const promoted = (rows as any[]).find((r) => r.content === AUTO_CLAIM);
    expect(promoted, "the promoted row was not committed before the stamp").toBeTruthy();

    const putDenied = await memoryWrite(owner, "PUT", promoted.id, { agentId: owner.id, content: "denied put", visibility: "private" });
    expect(putDenied.status, await putDenied.clone().text()).toBe(503);
    const patchDenied = await memoryWrite(owner, "PATCH", promoted.id, { agentId: owner.id, content: "denied patch", visibility: "private" });
    expect(patchDenied.status, await patchDenied.clone().text()).toBe(503);

    await release("promotion-stamp");
    const res = await sweep;
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);

    const stored = await readRow(promoted.id);
    expect(stored.promotionStatus).toBe("approved");
    expect(stored.promotedBy).toBe("machine:adk-auto-promote");
    expect(stored.promotionContentHash).toBe(sha256(AUTO_CLAIM));

    // The later owner PUT clears the verdict when content changes.
    const put = await memoryWrite(owner, "PUT", promoted.id, { agentId: owner.id, content: "owner edit after the verdict", visibility: "private" });
    expect(put.status, await put.clone().text()).toBe(200);
    const edited = await readRow(promoted.id);
    expect(edited.content).toBe("owner edit after the verdict");
    expect(edited.promotionStatus ?? null).toBeNull();
    expect(edited.promotionContentHash ?? null).toBeNull();
  }, 180_000);

  it("the manual stamp binds its verdict; Memory GET/search, feeds, SemanticSearch and AdminMemory suppress a mismatch", async () => {
    await seedCandidate("pvi-manual-cand", MANUAL_CLAIM);
    const res = await promote("pvi-manual-cand");
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    const { memoryId } = await res.json() as { memoryId: string };
    const stored = await readRow(memoryId);
    expect(stored.promotionStatus).toBe("approved");
    expect(stored.promotedBy).toBe(owner.id);
    expect(stored.promotionContentHash).toBe(sha256(MANUAL_CLAIM));

    // A raw writer bypasses the authority guard and changes the text while the
    // old hash stays.
    await opsCall({
      operation: "upsert", database: "flair", table: "Memory",
      records: [{ ...stored, content: "raw replacement after the verdict" }],
    });
    expect((await readRow(memoryId)).promotionContentHash).toBe(sha256(MANUAL_CLAIM));

    const path = `/Memory/${encodeURIComponent(memoryId)}`;
    const byId = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(owner, "GET", path) }, signal: AbortSignal.timeout(30_000),
    });
    expect(byId.status, await byId.clone().text()).toBe(200);
    const byIdRow: any = await byId.json();
    expect(byIdRow.promotionStatus ?? null).toBeNull();
    expect(byIdRow.promotedBy ?? null).toBeNull();

    const collectionPath = `/Memory?agentId=${encodeURIComponent(owner.id)}`;
    const collection = await fetch(`${harper.httpURL}${collectionPath}`, {
      headers: { Authorization: ed25519Header(owner, "GET", collectionPath) }, signal: AbortSignal.timeout(30_000),
    });
    expect(collection.status, await collection.clone().text()).toBe(200);
    const listed: any = await collection.json();
    const listedRow = (Array.isArray(listed) ? listed : listed.results ?? []).find((r: any) => r.id === memoryId);
    expect(listedRow, "the row was not listed").toBeTruthy();
    expect(listedRow.promotionStatus ?? null).toBeNull();

    const adminCollection = await fetch(`${harper.httpURL}/Memory`, {
      headers: { Authorization: authHeader }, signal: AbortSignal.timeout(30_000),
    });
    expect(adminCollection.status, await adminCollection.clone().text()).toBe(200);
    const adminListed: any = await adminCollection.json();
    expectSuppressed((Array.isArray(adminListed) ? adminListed : adminListed.results ?? []).find((r: any) => r.id === memoryId));

    const feedPath = `/FeedMemories/${encodeURIComponent(memoryId)}`;
    expectSuppressed(await feedRow(memoryId, ed25519Header(owner, "GET", feedPath)));
    expectSuppressed(await feedRow(memoryId, authHeader));

    const search = await semanticSearch({});
    expect(search.status, (await search.clone().text()).slice(0, 300)).toBe(200);
    const searchBody: any = await search.json();
    const found = (searchBody.results ?? []).find((r: any) => r.id === memoryId);
    expect(found, "the row was not retrieved").toBeTruthy();
    expect(found.promotionStatus ?? null).toBeNull();

    const admin = await fetch(`${harper.httpURL}/AdminMemory?id=${encodeURIComponent(memoryId)}`, {
      headers: { Authorization: authHeader }, signal: AbortSignal.timeout(30_000),
    });
    expect(admin.status, await admin.clone().text()).toBe(200);
    expect(await admin.text()).toContain("not promoted");
  }, 180_000);

  it("the automatic stamp skips a binding-only change before its transaction opens", async () => {
    const claim = "A claim whose binding changes before the stamp transaction.";
    await seedCandidate("pvi-auto-binding-stale", claim, AUTO_TAG);
    arm("promotion-stamp-pre");
    const sweep = autoPromote();
    await assertPaused("promotion-stamp-pre");
    try {
      const rows = await opsCall({
        operation: "search_by_value", database: "flair", table: "Memory",
        search_attribute: "agentId", search_value: owner.id, get_attributes: ["*"],
      });
      const pending = (rows as any[]).find((r) => r.content === claim);
      expect(pending, "the promoted row was not committed before the stamp").toBeTruthy();
      const changedHash = sha256("different reviewed content");
      await opsCall({
        operation: "upsert", database: "flair", table: "Memory",
        records: [{ ...pending, promotionContentHash: changedHash }],
      });
      expect(await readRow(pending.id)).toMatchObject({
        id: pending.id, agentId: pending.agentId, content: pending.content,
        instanceToken: pending.instanceToken, promotionContentHash: changedHash,
      });
      await release("promotion-stamp-pre");
      const res = await sweep;
      expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
      const stored = await readRow(pending.id);
      expect(stored.promotionStatus ?? null).toBeNull();
      expect(stored.promotedAt ?? null).toBeNull();
      expect(stored.promotedBy ?? null).toBeNull();
      expect(stored.promotionContentHash).toBe(changedHash);
    } finally {
      writeFileSync(join(pauseDir, "go.promotion-stamp-pre"), "");
      await sweep;
    }
  }, 120_000);

  it("a verdict is not stamped when the text changed while the stamp held the lock", async () => {
    await seedCandidate("pvi-auto-stale", "A claim whose text changes during the stamp.", AUTO_TAG);
    arm("promotion-stamp");
    const sweep = autoPromote();
    await assertPaused("promotion-stamp");
    const rows = await opsCall({
      operation: "search_by_value", database: "flair", table: "Memory",
      search_attribute: "agentId", search_value: owner.id, get_attributes: ["*"],
    });
    const pending = (rows as any[]).find((r) => r.content === "A claim whose text changes during the stamp.");
    expect(pending, "the promoted row was not committed before the stamp").toBeTruthy();
    await opsCall({
      operation: "upsert", database: "flair", table: "Memory",
      records: [{ ...pending, content: "the text changed while the stamp held the lock" }],
    });
    await release("promotion-stamp");
    const res = await sweep;
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    const stored = await readRow(pending.id);
    expect(stored.content).toBe("the text changed while the stamp held the lock");
    expect(stored.promotionStatus ?? null).toBeNull();
    expect(stored.promotionContentHash ?? null).toBeNull();
  }, 120_000);

  it("a client cannot set the hash on PUT", async () => {
    const fresh = "pvi-client-set";
    const put = await memoryWrite(owner, "PUT", fresh, {
      agentId: owner.id, content: "client content",
      promotionContentHash: sha256("client content"),
    });
    expect(put.status, await put.clone().text()).toBe(403);
  }, 60_000);

  it("a client cannot set the hash on PATCH", async () => {
    const patch = await memoryWrite(owner, "PATCH", V1, { agentId: owner.id, promotionContentHash: "a".repeat(64) });
    expect(patch.status, await patch.clone().text()).toBe(403);
  }, 60_000);

  it("a client cannot set the hash on feed ingest", async () => {
    const path = "/FeedMemories";
    const feedId = "pvi-feed-client-set";
    const feed = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, "POST", path) },
      body: JSON.stringify({ id: feedId, agentId: owner.id, content: "feed client content", promotionContentHash: sha256("feed client content") }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(feed.status, await feed.clone().text()).toBe(403);
    expect(await readRow(feedId)).toBeNull();
  }, 60_000);
});
