/**
 * write-back-contention-2354.test.ts — flair#2354, real Harper.
 *
 * One shared helper (resources/write-back.ts: writeBackCommittedRow) now owns
 * every converted full-row Memory write-back: it reads the row inside a
 * transaction it owns, builds the write from THAT read, re-reads the COMMITTED
 * row before commit, and on a concurrent change aborts the transaction (the
 * staged write is discarded) and retries from the committed row. Without the
 * helper, a write built from a copy read before the transaction would revert
 * the concurrent change while reporting success (Harper has no
 * compare-and-set on a table write; it applies both writes in timestamp
 * order).
 *
 * Each case drives a converted path through its HTTP entry point against a
 * spawned Harper carrying the test-only pause (resources/txn-pause-point.ts,
 * enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, set
 * for this file's Harper only). Two interleavings are exercised per path:
 *   - `<path>-pre`: a competing write commits BEFORE this write-back's owned
 *     transaction opens — the write-back must read the committed row and keep
 *     the competing change;
 *   - `<path>`: a competing write commits AFTER this write-back's read/build —
 *     the committed re-read must abort the staged write and retry, keeping the
 *     competing change rather than reverting it.
 * The paths here are those a serving instance exposes over HTTP. The
 * conversion also covers the embedding backfill and the visibility and
 * synthetic boot migrations; those are not exercised here.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
/** Refuse any target that is not the ephemeral instance this file started. */
function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}
async function authSend(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function seedAgent(harper: HarperInstance, agent: TestAgent, role = "agent"): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role, publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `seed agent returned ${res.status}`).toBe(200);
}
async function readRow(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_hash returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}
async function insertRow(harper: HarperInstance, row: Record<string, unknown>): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Memory",
    records: [{ visibility: "shared", archived: false, createdAt: "2026-01-01T00:00:00.000Z", embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(), ...row }],
  });
  expect(res.status, `raw insert of ${String(row.id)} returned ${res.status}`).toBe(200);
}
async function updateRow(harper: HarperInstance, row: Record<string, unknown>): Promise<number> {
  const res = await adminOp(harper, { operation: "update", database: "flair", table: "Memory", records: [row] });
  return res.status;
}
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Arm `point`, start `trigger`, run `compete` once the trigger is paused inside
 * that point, release, and await the trigger. Returns the trigger's response
 * and how the pause ended.
 */
async function withPaused<T>(point: string, trigger: () => Promise<Response>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, competed, released, paused };
}

let harper: HarperInstance;
let pauseDir: string;
const feedAgent = mkAgent("wbc-feed");
const reflectAgent = mkAgent("wbc-reflect");
const admin = mkAgent("wbc-admin");

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-wbc-pause-"));
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
  await seedAgent(harper, feedAgent);
  await seedAgent(harper, reflectAgent);
  await seedAgent(harper, admin, "admin");
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2354 — the feed ingest write-back under a concurrent change (real Harper)", () => {
  for (const point of ["feed-ingest-pre", "feed-ingest"]) {
    it(`keeps a competing incarnation-token change and applies the feed write (${point})`, async () => {
      const id = `wbc-feed-${point}`;
      const TOKEN1 = randomUUID();
      const TOKEN2 = randomUUID();
      await insertRow(harper, { id, agentId: feedAgent.id, content: `feed v1 ${point}`, contentHash: id, instanceToken: TOKEN1 });
      const { response, released, paused } = await withPaused(
        point,
        () => authSend(harper, feedAgent, "POST", "/FeedMemories", { id, agentId: feedAgent.id, content: `feed v2 ${point}`, visibility: "shared" }),
        () => updateRow(harper, { id, instanceToken: TOKEN2 }),
      );
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
      expect(released, "the feed ingest was not paused and released by this test").toBe("go");
      expect(paused).toBe(true);
      const row = await readRow(harper, id);
      console.log(`${point} feed row:`, JSON.stringify({ content: row?.content, instanceToken: row?.instanceToken }));
      expect(row?.content, "the feed write's own content").toBe(`feed v2 ${point}`);
      expect(row?.instanceToken, "the competing incarnation token is kept, not reverted").toBe(TOKEN2);
    }, 60_000);
  }
});

describe("flair#2354 — the admin reindex re-PUT write-back under a concurrent change (real Harper)", () => {
  for (const point of ["reindex-put-pre", "reindex-put"]) {
    it(`keeps a competing content edit and applies _reindex (${point})`, async () => {
      const agentId = `wbc-reindex-agent-${point}`;
      const id = `wbc-reindex-${point}`;
      await insertRow(harper, { id, agentId, content: "reindex v1", contentHash: id });
      const { response, released, paused } = await withPaused(
        point,
        () => authSend(harper, admin, "POST", "/MemoryReindex", { agentId }),
        () => updateRow(harper, { id, content: "reindex edited" }),
      );
      expect(released, "the reindex write-back was not paused and released by this test").toBe("go");
      expect(paused).toBe(true);
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
      const row = await readRow(harper, id);
      console.log(`${point} reindex row:`, JSON.stringify({ content: row?.content, _reindex: row?._reindex }));
      expect(row?.content, "the competing content edit is kept, not reverted by the scan copy").toBe("reindex edited");
      expect(row?._reindex, "the reindex re-PUT landed").toBe(true);
    }, 60_000);
  }

}
);

describe("flair#2354 — the last-reflected patch write-back under a concurrent change (real Harper)", () => {
  for (const point of ["last-reflected-pre", "last-reflected"]) {
    it(`keeps a competing content edit on the source row and stamps lastReflected (${point})`, async () => {
      const srcId = `wbc-reflect-src-${point}`;
      await insertRow(harper, { id: srcId, agentId: reflectAgent.id, content: "reflect v1", contentHash: srcId });
      const { response, released, paused } = await withPaused(
        point,
        () => authSend(harper, reflectAgent, "POST", "/Memory", {
          id: `wbc-deriv-${point}`, agentId: reflectAgent.id, content: "derived memory", derivedFrom: [srcId],
        }),
        () => updateRow(harper, { id: srcId, content: "reflect edited" }),
      );
      expect(released, "the last-reflected patch was not paused and released by this test").toBe("go");
      expect(paused).toBe(true);
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
      const row = await readRow(harper, srcId);
      console.log(`${point} reflect row:`, JSON.stringify({ content: row?.content, lastReflected: row?.lastReflected ?? null }));
      expect(row?.content, "the competing content edit is kept, not reverted by the patch").toBe("reflect edited");
      expect(row?.lastReflected, "the lastReflected bookkeeping landed").toBeTruthy();
    }, 60_000);
  }
});
