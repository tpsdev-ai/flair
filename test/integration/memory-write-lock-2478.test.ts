/**
 * memory-write-lock-2478.test.ts — the per-id memory write lock serializes the
 * ordinary owner PUT/PATCH (flair#2478 slice 1, part 1), real Harper.
 *
 * Ordinary owner row PUT/PATCH acquire the per-id lock before their first
 * stored read and commit their owned transaction before releasing it. Re-embed
 * PATCH uses an inner owned transaction. Composed promotion and an admin
 * `_reindex` joining an open transaction can commit after release.
 * A same-id writer waits within its budget (200 attempts, 10 ms apart), then
 * acquires the lock or answers 503 memory_busy without writing, unless an attempt
 * observes an outcome-unknown marker (503 write_outcome_unknown; the fence test).
 *
 * PUT and PATCH require an id before entering the lock helper.
 *
 * DETERMINISTIC ORDERING via the `memory-put-committed` / `memory-patch-committed`
 * pause points (resources/txn-pause-point.ts, enabled by
 * FLAIR_ENABLE_TEST_FAULT_INJECTION / FLAIR_TEST_PAUSE_DIR): each holds a writer
 * AFTER its owned transaction committed and while the write lock is still held.
 * `memory-put-pre` holds a PUT under the lock before its first read;
 * `memory-put-verify` / `memory-patch-verify` hold a write after its commit and
 * before its verification read.
 *
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: Uint8Array; secretKey: Uint8Array; }
const newAgent = (id: string): TestAgent => ({ id, ...nacl.sign.keyPair() });
const owner = newAgent("wlk-owner");

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
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
/** A signed owner PUT over the real HTTP route. */
function editAs(agent: TestAgent, id: string, content: string): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PUT", path) },
    body: JSON.stringify({ agentId: agent.id, content }),
    signal: AbortSignal.timeout(60_000),
  });
}
/** A signed owner PATCH over the real HTTP route. */
function patchAs(agent: TestAgent, id: string, content: string): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PATCH", path) },
    body: JSON.stringify({ agentId: agent.id, content }),
    signal: AbortSignal.timeout(60_000),
  });
}
function patchBodyAs(agent: TestAgent, id: string, body: Record<string, unknown>): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PATCH", path) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}
/** An UNSIGNED (anonymous) PUT over the real HTTP route. */
function anonymousPut(id: string, body: Record<string, unknown>): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
async function assertReleased(point: string): Promise<void> {
  const path = join(pauseDir, `released.${point}`);
  const deadline = Date.now() + 30_000;
  let released = "";
  while (Date.now() < deadline) {
    if (existsSync(path)) released = readFileSync(path, "utf8");
    if (released) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(released, "the pause ended by timeout, not by this test").toBe("go");
}
function clearMarkers(point: string): void {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
}
function arm(point: string): void {
  clearMarkers(point);
  writeFileSync(join(pauseDir, `arm.${point}`), "");
}
function release(point: string): void {
  writeFileSync(join(pauseDir, `go.${point}`), "");
}
async function seedMemory(id: string, content: string, extra: Record<string, unknown> = {}): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id, agentId: owner.id, content, durability: "standard", visibility: "shared",
      embedding: [0.1, 0.2, 0.3], instanceToken: randomUUID(),
      usageCount: 0, createdAt: new Date().toISOString(), ...extra,
    }],
  });
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478-pause-"));
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
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
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
  await opsCall({
    operation: "upsert", database: "flair", table: "Agent",
    records: [{
      id: owner.id, name: owner.id, role: "agent",
      publicKey: Buffer.from(owner.publicKey).toString("base64"), createdAt: new Date().toISOString(),
    }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

const POINT = "memory-put-committed";

describe("flair#2478 — the per-id memory write lock serializes the owner PUT (real Harper)", () => {
  it("a PATCH on the same id cannot take the lock while a PUT holds it past the budget: 503 memory_busy, caller id only, and no write", async () => {
    const id = `wlk-busy-${Date.now()}`;
    await seedMemory(id, "the original text");
    arm(POINT);
    const held = editAs(owner, id, "the held PUT");
    expect(await waitFor(join(pauseDir, `paused.${POINT}`), 30_000), "the first PUT never reached its post-commit pause").toBe(true);

    // The lock is held: a second writer to the SAME id waits its whole budget and is refused.
    const refused = await patchAs(owner, id, "the refused PATCH");
    const body = await refused.json() as any;
    expect(refused.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toBe("memory_busy");
    expect(body.caller).toBe(owner.id);

    release(POINT);
    const heldRes = await held;
    await assertReleased(POINT);
    expect(heldRes.status, `the held PUT was not 2xx: ${await heldRes.clone().text()}`).toBeLessThan(300);
    expect((await readRow(id))?.content, "the refused PATCH wrote after all").toBe("the held PUT");
  }, 120_000);

  it("a second PUT waits out a short hold and commits on top of the first's committed row: no lost write, no spurious 409", async () => {
    const id = `wlk-serial-${Date.now()}`;
    await seedMemory(id, "the original text");
    arm(POINT);
    const first = editAs(owner, id, "the first PUT");
    expect(await waitFor(join(pauseDir, `paused.${POINT}`), 30_000), "the first PUT never reached its post-commit pause").toBe(true);

    // Start the second PUT while the first holds the lock, then release well
    // inside the second's budget: it takes the lock and commits its own write.
    const second = editAs(owner, id, "the second PUT");
    await new Promise((r) => setTimeout(r, 250));
    release(POINT);
    const [a, b] = await Promise.all([first, second]);
    await assertReleased(POINT);
    expect(a.status, `the first PUT was not 2xx: ${await a.clone().text()}`).toBeLessThan(300);
    expect(b.status, `the second PUT was not 2xx: ${await b.clone().text()}`).toBeLessThan(300);
    expect((await readRow(id))?.content, "the second PUT did not land on the first's committed row").toBe("the second PUT");
  }, 120_000);
});

describe("flair#2478 — the lock guards a PATCH too", () => {
  it("a PUT on the same id cannot take the lock while a PATCH holds it past the budget: 503 memory_busy", async () => {
    const id = `wlk-patch-busy-${Date.now()}`;
    await seedMemory(id, "the original text");
    const patchPoint = "memory-patch-committed";
    clearMarkers(patchPoint);
    writeFileSync(join(pauseDir, `arm.${patchPoint}`), "");
    const held = patchAs(owner, id, "the held PATCH");
    expect(await waitFor(join(pauseDir, `paused.${patchPoint}`), 30_000), "the PATCH never reached its post-commit pause").toBe(true);

    const refused = await editAs(owner, id, "the refused PUT");
    const body = await refused.json() as any;
    expect(refused.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toBe("memory_busy");

    release(patchPoint);
    const heldRes = await held;
    await assertReleased(patchPoint);
    expect(heldRes.status, `the held PATCH was not 2xx: ${await heldRes.clone().text()}`).toBeLessThan(300);
    expect((await readRow(id))?.content, "the refused PUT wrote after all").toBe("the held PATCH");
  }, 120_000);
});

// flair#2478: the authorization and visibility refusals decide before the row
// is written. Both decide under the lock, after acquisition; a refusal that
// moved after the write would let an anonymous reindex or a visibility-widening
// flip reach the row. Both cases run through the REAL per-id lock path
// (Memory.primaryStore).
describe("flair#2478 — a refusal decides before the write, and the write does not land", () => {
  it("an anonymous PUT carrying _reindex is refused 401, and the row is unchanged", async () => {
    const id = `wlk-anon-reindex-${Date.now()}`;
    await seedMemory(id, "the original text");
    const before = await readRow(id);
    expect(before?.content).toBe("the original text");

    const res = await anonymousPut(id, { agentId: owner.id, content: "the original text", _reindex: true });
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(401);
    expect(body.error).toBe("authentication required");

    const after = await readRow(id);
    expect(after?.content, "the anonymous reindex re-PUT the row").toBe("the original text");
    expect(after?.instanceToken, "the anonymous reindex rotated the row's instance token").toBe(before.instanceToken);
  }, 120_000);

  it("a PATCH moving a shared record to ephemeral is refused by name through the lock, row unchanged", async () => {
    const id = `wlk-vis-${Date.now()}`;
    await seedMemory(id, "the shared text");
    const before = await readRow(id);
    expect(before?.visibility).toBe("shared");
    expect(before?.durability).toBe("standard");

    const res = await patchBodyAs(owner, id, { agentId: owner.id, durability: "ephemeral" });
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toBe("invalid_visibility_for_durability");

    const after = await readRow(id);
    expect(after?.durability, "the refused PATCH wrote after all").toBe("standard");
    expect(after?.visibility).toBe("shared");
    expect(after?.instanceToken).toBe(before.instanceToken);
  }, 120_000);
});

/** A signed owner PUT to an explicit path with an explicit body (the idless-PUT case sends neither an id). */
function putPathAs(agent: TestAgent, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PUT", path) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}
/** Replace the committed row with a NEW incarnation carrying the same values (ops API, outside the lock).
 *  `token: false` re-creates it the way a legacy writer would, with no instanceToken at all. */
async function replaceWithSameValues(id: string, opts: { token: boolean } = { token: true }): Promise<{ before: any; after: any }> {
  const before = await readRow(id);
  expect(before, "no committed row to replace").toBeTruthy();
  await opsCall({ operation: "delete", database: "flair", table: "Memory", ids: [id] });
  const copy: Record<string, unknown> = { ...before };
  if (opts.token) copy.instanceToken = randomUUID();
  else delete copy.instanceToken;
  for (const key of ["__createdtime__", "__updatedtime__"]) delete copy[key];
  await opsCall({ operation: "insert", database: "flair", table: "Memory", records: [copy] });
  const after = await readRow(id);
  for (const field of ["agentId", "content", "visibility", "durability", "embedding"]) expect(after?.[field]).toEqual(before[field]);
  expect(after?.instanceToken ?? null).not.toBe(before.instanceToken ?? null);
  return { before, after };
}
/** A legacy row: written before incarnation tokens, so it carries no instanceToken. */
async function seedLegacyMemory(id: string, content: string): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id, agentId: owner.id, content, durability: "standard", visibility: "shared",
      embedding: [0.1, 0.2, 0.3], usageCount: 0, createdAt: new Date().toISOString(),
    }],
  });
  expect((await readRow(id))?.instanceToken ?? null, "the legacy row already has a token").toBeNull();
}

describe("flair#2478 — a lock miss reveals nothing about the target row", () => {
  it("the memory_busy refusal for an existing target and for an absent target is byte-identical", async () => {
    const PRE = "memory-put-pre";
    const refusalFor = async (id: string): Promise<string> => {
      arm(PRE);
      const held = editAs(owner, id, "the held PUT");
      expect(await waitFor(join(pauseDir, `paused.${PRE}`), 30_000), "the first PUT never reached its pre-read pause").toBe(true);
      const refused = await editAs(owner, id, "the refused PUT");
      const text = await refused.text();
      const bytes = JSON.stringify({ status: refused.status, type: refused.headers.get("content-type"), body: text });
      release(PRE);
      const heldRes = await held;
      await assertReleased(PRE);
      expect(heldRes.status, `the held PUT was not 2xx: ${await heldRes.clone().text()}`).toBeLessThan(300);
      expect(refused.status, text).toBe(503);
      return bytes;
    };
    const existing = `wlk-miss-existing-${Date.now()}`;
    await seedMemory(existing, "the original text");
    const absent = `wlk-miss-absent-${Date.now()}`;
    expect(await readRow(absent), "the absent target exists").toBeNull();

    const existingBytes = await refusalFor(existing);
    const absentBytes = await refusalFor(absent);
    expect(JSON.parse(JSON.parse(existingBytes).body)).toEqual({ error: "memory_busy", caller: owner.id });
    expect(absentBytes).toBe(existingBytes);
  }, 120_000);
});

describe("flair#2478 — post-commit verification checks the row's incarnation", () => {
  it("a PUT whose committed row is replaced by a new incarnation with the SAME values answers 409 stored_row_changed", async () => {
    const id = `wlk-ident-put-${Date.now()}`;
    await seedMemory(id, "the original text");
    const verifyPoint = "memory-put-verify";
    arm(verifyPoint);
    const held = editAs(owner, id, "the verified PUT");
    expect(await waitFor(join(pauseDir, `paused.${verifyPoint}`), 30_000), "the PUT never reached its pre-verification pause").toBe(true);
    const { after } = await replaceWithSameValues(id);
    release(verifyPoint);
    const res = await held;
    await assertReleased(verifyPoint);
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toBe("stored_row_changed");
    expect(JSON.stringify(body), "the refusal carries the row's incarnation token").not.toContain(after.instanceToken);
    expect((await readRow(id))?.instanceToken).toBe(after.instanceToken);
  }, 120_000);

  it("a PATCH whose committed row is replaced by a new incarnation with the SAME values answers 409 stored_row_changed", async () => {
    const id = `wlk-ident-patch-${Date.now()}`;
    await seedMemory(id, "the original text");
    const verifyPoint = "memory-patch-verify";
    arm(verifyPoint);
    const held = patchAs(owner, id, "the verified PATCH");
    expect(await waitFor(join(pauseDir, `paused.${verifyPoint}`), 30_000), "the PATCH never reached its pre-verification pause").toBe(true);
    const { after } = await replaceWithSameValues(id);
    release(verifyPoint);
    const res = await held;
    await assertReleased(verifyPoint);
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toBe("stored_row_changed");
    expect((await readRow(id))?.instanceToken).toBe(after.instanceToken);
  }, 120_000);
});

describe("flair#2478 — post-commit verification on a re-embed PATCH and a legacy row", () => {
  it("a re-embed PATCH whose committed row is replaced by a new incarnation with the SAME values answers 409 stored_row_changed", async () => {
    const id = `wlk-ident-reembed-${Date.now()}`;
    await seedMemory(id, "the text this re-embed computes its vector from");
    const verifyPoint = "memory-patch-verify";
    arm(verifyPoint);
    const held = patchBodyAs(owner, id, { embedding: null, embeddingModel: null });
    expect(await waitFor(join(pauseDir, `paused.${verifyPoint}`), 60_000), "the re-embed PATCH never reached its pre-verification pause").toBe(true);
    const { before, after } = await replaceWithSameValues(id);
    expect(Array.isArray(before.embedding) && before.embedding.length > 3, "the re-embed did not commit its vector before the pause").toBe(true);
    release(verifyPoint);
    const res = await held;
    await assertReleased(verifyPoint);
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toBe("stored_row_changed");
    expect((await readRow(id))?.instanceToken).toBe(after.instanceToken);
  }, 180_000);

  it("a PATCH gives a legacy row that has no instanceToken one, in the same write", async () => {
    const id = `wlk-legacy-token-${Date.now()}`;
    await seedLegacyMemory(id, "the legacy text");
    const res = await patchAs(owner, id, "the legacy row, patched");
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const row = await readRow(id);
    expect(row?.content).toBe("the legacy row, patched");
    expect(typeof row?.instanceToken === "string" && row.instanceToken.length > 0, "the PATCH left the legacy row without a token").toBe(true);
  }, 120_000);

  it("a legacy row's PATCH whose committed row is deleted and re-created WITHOUT a token, with the same values, answers 409 stored_row_changed", async () => {
    const id = `wlk-legacy-replace-${Date.now()}`;
    await seedLegacyMemory(id, "the legacy text");
    const verifyPoint = "memory-patch-verify";
    arm(verifyPoint);
    const held = patchAs(owner, id, "the legacy row, patched");
    expect(await waitFor(join(pauseDir, `paused.${verifyPoint}`), 30_000), "the PATCH never reached its pre-verification pause").toBe(true);
    const { after } = await replaceWithSameValues(id, { token: false });
    expect(after?.instanceToken ?? null).toBeNull();
    release(verifyPoint);
    const res = await held;
    await assertReleased(verifyPoint);
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toBe("stored_row_changed");
  }, 120_000);
});

describe("flair#2645 — an ordinary owner PATCH verifies retained request fields", () => {
  for (const replaced of [false, true]) {
    it(`a redacted-content PATCH answers ${replaced ? "409 when a newer write replaces it" : "success when retained"}`, async () => {
      const id = `wlk-redacted-${replaced}-${Date.now()}`;
      await seedMemory(id, "the original text");
      const point = "memory-patch-verify";
      arm(point);
      const held = patchBodyAs(owner, id, {
        agentId: owner.id, content: `rotate ghp_${"A".repeat(36)}`,
      });
      try {
        expect(await waitFor(join(pauseDir, `paused.${point}`), 30_000)).toBe(true);
        const committed = await readRow(id);
        expect(committed?.content).toBe("rotate [redacted]");
        if (replaced) {
          await opsCall({
            operation: "update", database: "flair", table: "Memory",
            records: [{ id, agentId: owner.id, content: "the newer content", createdAt: committed.createdAt }],
          });
        }
      } finally {
        release(point);
      }
      const res = await held;
      await assertReleased(point);
      const body = await res.json() as any;
      if (replaced) {
        expect(res.status, JSON.stringify(body)).toBe(409);
        expect(body.error).toBe("stored_row_changed");
      } else {
        expect(res.status, JSON.stringify(body)).toBeLessThan(300);
        expect(body.stored).toEqual({ content: "rotate [redacted]" });
      }
      expect((await readRow(id))?.content).toBe(replaced ? "the newer content" : "rotate [redacted]");
    }, 120_000);
  }

  it("a tags-only PATCH whose tags a newer full write discarded answers 409 stored_row_changed", async () => {
    const id = `wlk-declared-tags-${Date.now()}`;
    await seedMemory(id, "the original text", { tags: ["original-tag"] });
    const point = "memory-patch-verify";
    arm(point);
    const held = patchBodyAs(owner, id, { agentId: owner.id, tags: ["declared-tag"] });
    expect(await waitFor(join(pauseDir, `paused.${point}`), 30_000), "the PATCH never reached its pre-verification pause").toBe(true);

    const committed = await readRow(id);
    expect(committed?.tags, "the PATCH did not commit its tags before the pause").toEqual(["declared-tag"]);
    // A newer FULL write from a lock-bypassing writer: same id, same incarnation
    // token, newer content, and NO tags. The PATCH's declared tags are discarded.
    await opsCall({ operation: "delete", database: "flair", table: "Memory", ids: [id] });
    const copy: Record<string, unknown> = { ...committed, content: "the newer content" };
    delete copy.tags;
    for (const key of ["__createdtime__", "__updatedtime__"]) delete copy[key];
    await opsCall({ operation: "insert", database: "flair", table: "Memory", records: [copy] });

    release(point);
    const res = await held;
    await assertReleased(point);
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toBe("stored_row_changed");
    expect((await readRow(id))?.tags ?? null, "the answered PATCH's tags are missing from the stored row").toBeNull();
  }, 120_000);

  it("a metadata-only PATCH answers success with the metadata present", async () => {
    const id = `wlk-declared-metadata-${Date.now()}`;
    await seedMemory(id, "the original text");
    const res = await patchBodyAs(owner, id, { agentId: owner.id, metadata: "kept" });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect((await readRow(id))?.metadata, "the metadata-only PATCH did not land").toBe("kept");
  }, 120_000);

  it("a mixed PATCH answers success with every declared field present", async () => {
    const id = `wlk-declared-mixed-${Date.now()}`;
    await seedMemory(id, "the original text", { tags: ["original-tag"] });
    const res = await patchBodyAs(owner, id, {
      agentId: owner.id, content: "the mixed text", tags: ["mixed-tag"], metadata: "mixed",
    });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const row = await readRow(id);
    expect(row?.content, "the mixed PATCH content did not land").toBe("the mixed text");
    expect(row?.tags, "the mixed PATCH tags did not land").toEqual(["mixed-tag"]);
    expect(row?.metadata, "the mixed PATCH metadata did not land").toBe("mixed");
  }, 120_000);
});

// An idless Memory PUT or PATCH is refused for every caller and writes nothing.
// A non-admin caller is refused first by the owner-scoped write policy (a write
// to the collection rather than one record, 403); an admin caller reaches the
// Memory verb, which refuses it 400 memory_id_required before the lock.
const IDLESS_NON_ADMIN = { status: 403, error: "forbidden: a non-admin write to Memory must address one record by its id" };
const IDLESS_ADMIN = { status: 400, error: "memory_id_required" };

describe("flair#2478 — a PUT must name its id", () => {
  it("a PUT with no id in the URL or the body is refused (non-admin 403, admin 400 memory_id_required), and writes nothing", async () => {
    const marker = `wlk-idless-${randomUUID()}`;
    for (const path of ["/Memory/", "/Memory"]) {
      const res = await putPathAs(owner, path, { agentId: owner.id, content: marker, durability: "standard" });
      const body = await res.json() as any;
      expect({ status: res.status, error: body.error }, `${path} non-admin: ${JSON.stringify(body)}`).toEqual(IDLESS_NON_ADMIN);
      const adminRes = await fetch(`${harper.httpURL}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ agentId: owner.id, content: marker, durability: "standard" }),
        signal: AbortSignal.timeout(60_000),
      });
      const adminBody = await adminRes.json() as any;
      expect({ status: adminRes.status, error: adminBody.error }, `${path} admin: ${JSON.stringify(adminBody)}`).toEqual(IDLESS_ADMIN);
    }
    const rows = await opsCall({
      operation: "search_by_value", database: "flair", table: "Memory",
      search_attribute: "agentId", search_value: owner.id, get_attributes: ["id", "content"],
    });
    expect((rows as any[]).filter((row) => row.content === marker)).toEqual([]);
  }, 120_000);
});

describe("flair#2478 — a PATCH must name its id", () => {
  it("refuses an idless HTTP PATCH before running the verb body", async () => {
    const point = "memory-patch-entry";
    const id = `wlk-entry-${randomUUID()}`;
    await seedMemory(id, "the entry probe");
    arm(point);
    release(point);
    try {
      const probe = await patchBodyAs(owner, id, { tags: ["entry-probe"] });
      expect(probe.status, await probe.clone().text()).toBeLessThan(300);
      expect(existsSync(join(pauseDir, `claimed.${point}`))).toBe(true);
    } finally {
      rmSync(join(pauseDir, `arm.${point}`), { force: true });
      clearMarkers(point);
    }
    for (const path of ["/Memory/", "/Memory"]) {
      for (const [caller, authorization, expected] of [
        ["non-admin", ed25519Header(owner, "PATCH", path), IDLESS_NON_ADMIN],
        ["admin", authHeader, IDLESS_ADMIN],
      ] as const) {
        arm(point);
        release(point);
        try {
          const res = await fetch(`${harper.httpURL}${path}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: authorization },
            body: JSON.stringify({ agentId: owner.id, content: "an idless PATCH" }),
            signal: AbortSignal.timeout(60_000),
          });
          expect({
            status: res.status,
            error: (await res.json() as any).error,
            bodyEntered: existsSync(join(pauseDir, `claimed.${point}`)),
          }, `${path} ${caller}`).toEqual({ ...expected, bodyEntered: false });
        } finally {
          rmSync(join(pauseDir, `arm.${point}`), { force: true });
          clearMarkers(point);
        }
      }
    }
  }, 120_000);
});

it.each([
  ["pending", "getEmbedding = async () => new Promise(() => {});"],
  ["late vector", "getEmbedding = async () => { const started = performance.now(); while (performance.now() - started < 100) {} return [1, 0, 0]; };"],
])("a PUT provider timeout (%s) preserves the row and releases the real Harper lock", async (_settlement, provider) => {
  const component = mkdtempSync(join(tmpdir(), "flair-2478-provider-timeout-"));
  let instance: HarperInstance | undefined;
  try {
    for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
      cpSync(join(process.cwd(), entry), join(component, entry), { recursive: true });
    }
    symlinkSync(join(process.cwd(), "node_modules"), join(component, "node_modules"), "dir");
    appendFileSync(join(component, "dist/resources/embeddings-provider.js"),
      `\n${provider}\n`);
    instance = await startHarper({
      cwd: component,
      env: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS: "50" },
    });
    const basic = "Basic " + Buffer.from(`${instance.admin.username}:${instance.admin.password}`).toString("base64");
    const ops = async (body: Record<string, unknown>): Promise<any> => {
      const response = await fetch(instance!.opsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basic },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    };
    await ops({ operation: "upsert", database: "flair", table: "Agent", records: [{
      id: owner.id, name: owner.id, publicKey: Buffer.from(owner.publicKey).toString("base64"),
      createdAt: new Date().toISOString(),
    }] });
    const id = `wlk-timeout-${randomUUID()}`;
    await ops({ operation: "insert", database: "flair", table: "Memory", records: [{
      id, agentId: owner.id, content: "the original text", createdAt: new Date().toISOString(),
      embedding: [0.1, 0.2, 0.3], instanceToken: randomUUID(),
      durability: "standard", visibility: "shared",
    }] });
    const read = async () => (await ops({
      operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"],
    }))[0];
    const before = await read();
    expect(before?.content).toBe("the original text");
    const path = `/Memory/${id}`;
    const write = (method: string, body: Record<string, unknown>) => fetch(`${instance!.httpURL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, method, path) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    const refused = await write("PUT", { agentId: owner.id, content: "the edited text" });
    expect(refused.status).toBe(503);
    expect((await refused.json() as any).error).toBe("memory_provider_timeout");
    expect(await read()).toEqual(before);
    const next = await write("PATCH", { tags: ["after-timeout"] });
    expect(next.status, await next.clone().text()).toBeLessThan(300);
    expect((await read())?.tags).toEqual(["after-timeout"]);
  } finally {
    try {
      if (instance) await stopHarper(instance);
    } finally {
      rmSync(component, { recursive: true, force: true });
    }
  }
}, 240_000 + HARPER_STOP_BUDGET_MS);
