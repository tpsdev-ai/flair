import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { WRITE_BACK_ATTEMPTS } from "../../resources/write-back.ts";
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
async function putRow(harper: HarperInstance, row: Record<string, unknown>): Promise<number> {
  const res = await adminOp(harper, { operation: "put", database: "flair", table: "Memory", records: [row] });
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

/** The promoted Memory row a paused sweep wrote: the id is minted inside the
 *  handler, so the competing writer finds it by its owning agent + content. */
async function findPromotedRow(harper: HarperInstance, agentId: string, claim: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "agentId", search_value: agentId, get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_value returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  const rows = JSON.parse(text) as any[];
  return (Array.isArray(rows) ? rows : []).find((r) => r?.content === claim) ?? null;
}

/** Seed a PENDING ADK candidate (scopeTag-bearing, the shape the unattended
 *  sweep accepts) directly through the admin ops API. */
async function seedCandidate(harper: HarperInstance, agentId: string, row: Record<string, unknown>): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "MemoryCandidate",
    records: [{ agentId, status: "pending", generatedAt: new Date().toISOString(), generatedBy: "test-seed", ...row }],
  });
  expect(res.status, `seed candidate ${String(row.id)} returned ${res.status}: ${(await res.text()).slice(0, 200)}`).toBe(200);
}

let harper: HarperInstance;
let pauseDir: string;
// The deterministic generative backend ReflectMemories' execute mode calls
// (test/fixtures/stub-generative-backend.mjs): it returns this file's content.
let stubDir: string;
let appDir: string;
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
    stubDir = mkdtempSync(join(tmpdir(), "flair-wbc-stub-"));
    writeFileSync(join(stubDir, "generate-response.json"), JSON.stringify({ candidates: [] }));
    appDir = mkdtempSync(join(tmpdir(), "flair-wbc-app-"));
    for (const name of ["dist", "schemas", "config.yaml"]) cpSync(resolve(name), join(appDir, name), { recursive: true });
    cpSync(resolve("test/fixtures/write-back-app/WriteBackIndexProbe.js"), join(appDir, "dist/resources/WriteBackIndexProbe.js"));
    symlinkSync(resolve("node_modules"), join(appDir, "node_modules"), "dir");
    harper = await startHarper({
      cwd: appDir,
      harperBinDir: process.cwd(),
      appendRootConfigYaml: [
        "models:",
        "  generative:",
        "    default:",
        `      backend: ${resolve(process.cwd(), "test/fixtures/stub-generative-backend.mjs")}`,
        `      responseFile: ${join(stubDir, "generate-response.json")}`,
      ].join("\n"),
    });
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
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  if (appDir) rmSync(appDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2653 — a newer write in the final-confirmation-to-commit window (real Harper)", () => {
  it("retries a promotion stamp the commit gap dropped, and the stamp lands on the newer row", async () => {
    const agentId = "wbc-stamp-commit-agent";
    const stampAgent = mkAgent(agentId);
    await seedAgent(harper, stampAgent);
    const claim = "promotion stamp claim for the commit gap";
    await seedCandidate(harper, agentId, { id: "wbc-stamp-cand-commit", claim, scopeTag: `adk:app:${agentId}`, sourceMemoryIds: [] });
    const COMPETED = "competing subject for the commit gap";
    const { response, released, paused } = await withPaused(
      "promotion-stamp-commit",
      () => authSend(harper, stampAgent, "POST", "/AutoPromoteCandidates", { agentId }),
      async () => {
        const row = await findPromotedRow(harper, agentId, claim);
        if (!row) throw new Error(`no promoted row for ${agentId} at the commit gap`);
        const current = await readRow(harper, row.id);
        // A newer full write to a field the stamp does not compare. It commits
        // in the window between the stamp's final confirmation and its commit.
        expect(await putRow(harper, { ...current, subject: COMPETED }), "the competing full write").toBe(200);
        return row.id as string;
      },
    );
    expect(paused, "the promotion stamp was not paused at its commit gap").toBe(true);
    expect(released, "the promotion stamp was not paused and released by this test").toBe("go");
    expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
    const row = await readRow(harper, String((await response.clone().json() as any).promoted[0]));
    // The retry re-read the newer row and stamped it: the effect is present.
    expect(row?.promotionStatus, "the verdict landed on the newer committed row").toBe("approved");
    expect(row?.promotedBy).toBeTruthy();
    expect(row?.subject, "the newer write's field is kept").toBe(COMPETED);
  }, 120_000);
});

describe("flair#2354 — the feed ingest write-back under a concurrent change (real Harper)", () => {
  for (const point of ["feed-ingest-pre", "feed-ingest"]) {
    it(`refuses a replaced feed target (${point})`, async () => {
      const id = `wbc-feed-${point}`;
      const TOKEN1 = randomUUID();
      const TOKEN2 = randomUUID();
      await insertRow(harper, { id, agentId: feedAgent.id, content: `feed v1 ${point}`, contentHash: id, instanceToken: TOKEN1 });
      const { response, released, paused } = await withPaused(
        point,
        () => authSend(harper, feedAgent, "POST", "/FeedMemories", { id, agentId: feedAgent.id, content: `feed v2 ${point}`, visibility: "shared" }),
        () => updateRow(harper, { id, instanceToken: TOKEN2 }),
      );
      const text = await response.clone().text();
      expect(response.status, text.slice(0, 300)).toBe(409);
      expect(JSON.parse(text).error, "a replaced target is the retryable feed_target_changed").toBe("feed_target_changed");
      expect(released, "the feed ingest was not paused and released by this test").toBe("go");
      expect(paused).toBe(true);
      const row = await readRow(harper, id);
      console.log(`${point} feed row:`, JSON.stringify({ content: row?.content, instanceToken: row?.instanceToken }));
      expect(row?.content).toBe(`feed v1 ${point}`);
      expect(row?.instanceToken, "the competing incarnation token is kept, not reverted").toBe(TOKEN2);
    }, 60_000);
  }

  for (const point of ["feed-ingest-pre", "feed-ingest"]) {
    it(`an update that omits visibility keeps a concurrent shared -> private change (${point})`, async () => {
      const id = `wbc-feed-vis-${point}`;
      await insertRow(harper, { id, agentId: feedAgent.id, content: `feed vis v1 ${point}`, contentHash: id, instanceToken: randomUUID(), visibility: "shared" });
      const { response, released, paused, competed } = await withPaused(
        point,
        () => authSend(harper, feedAgent, "POST", "/FeedMemories", { id, agentId: feedAgent.id, content: `feed vis v2 ${point}` }),
        () => updateRow(harper, { id, visibility: "private" }),
      );
      expect(released, "the feed ingest was not paused and released by this test").toBe("go");
      expect(paused).toBe(true);
      expect(competed, "the competing visibility change was not applied").toBe(200);
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBe(200);
      const row = await readRow(harper, id);
      expect(row?.content, "the feed write landed").toBe(`feed vis v2 ${point}`);
      expect(row?.visibility, "the concurrent private change is kept").toBe("private");
    }, 60_000);
  }

  it("refuses a body embedding or embeddingModel with a named 400 and writes nothing", async () => {
    const id = "wbc-feed-embedding";
    await insertRow(harper, { id, agentId: feedAgent.id, content: "feed embedding v1", contentHash: id, instanceToken: randomUUID() });
    const before = await readRow(harper, id);
    const bodies = [
      { id, agentId: feedAgent.id, content: "feed embedding v2", embedding: [0.5, 0.5, 0.5] },
      { id, agentId: feedAgent.id, content: "feed embedding v2", embeddingModel: "foreign-model" },
      { id: "wbc-feed-embedding-new", agentId: feedAgent.id, content: "feed embedding create", embedding: [0.5, 0.5, 0.5], embeddingModel: "foreign-model" },
    ];
    for (const body of bodies) {
      const res = await authSend(harper, feedAgent, "POST", "/FeedMemories", body);
      const text = await res.text();
      expect(res.status, text.slice(0, 300)).toBe(400);
      expect(JSON.parse(text).error).toBe("feed_embedding_not_writable");
    }
    expect(await readRow(harper, id)).toEqual(before);
    expect(await readRow(harper, "wbc-feed-embedding-new")).toBeNull();
  }, 60_000);
});

describe("flair#2354 — the admin reindex re-PUT write-back under a concurrent change (real Harper)", () => {
  for (const point of ["reindex-put-pre", "reindex-put"]) {
    it(`keeps a competing content edit and stores no _reindex flag (${point})`, async () => {
      const agentId = `wbc-reindex-agent-${point}`;
      const id = `wbc-reindex-${point}`;
      // No instanceToken, and one undeclared field: the re-PUT generates the
      // token and strips the field, as Memory.put()'s `_reindex` branch does.
      await insertRow(harper, { id, agentId, content: "reindex v1", contentHash: id, undeclaredReindexProbe: "x" });
      expect((await readRow(harper, id))?.undeclaredReindexProbe, "the undeclared field was stored before the reindex").toBe("x");
      const { response, released, paused } = await withPaused(
        point,
        () => authSend(harper, admin, "POST", "/MemoryReindex", { agentId }),
        () => updateRow(harper, { id, content: "reindex edited" }),
      );
      expect(released, "the reindex write-back was not paused and released by this test").toBe("go");
      expect(paused).toBe(true);
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
      const body = await response.json() as any;
      expect(body.stats.reindexed, JSON.stringify(body.stats)).toBe(1);
      const row = await readRow(harper, id);
      console.log(`${point} reindex row:`, JSON.stringify({ content: row?.content, _reindex: row?._reindex, instanceToken: row?.instanceToken }));
      expect(row?.content, "the competing content edit is kept, not reverted by the scan copy").toBe("reindex edited");
      expect(row?._reindex ?? null, "the _reindex flag is not stored").toBeNull();
      expect(row?.undeclaredReindexProbe ?? null, "the undeclared field is stripped").toBeNull();
      expect(typeof row?.instanceToken === "string" && row.instanceToken.length > 0, "an absent instance token is generated").toBe(true);
    }, 60_000);
  }

  it("does not count a re-PUT dropped while a newer write retains an omitted field", async () => {
    const id = "wbc-reindex-commit-gap";
    const agentId = "wbc-reindex-commit-agent";
    await insertRow(harper, { id, agentId, content: "reindex gap", contentHash: id, instanceToken: randomUUID(), undeclaredReindexProbe: "keep" });
    const points = Array.from({ length: WRITE_BACK_ATTEMPTS }, (_, n) => `reindex-put-commit${"-retry".repeat(n)}`);
    for (const point of points) writeFileSync(join(pauseDir, `arm.${point}`), "");
    const pending = authSend(harper, admin, "POST", "/MemoryReindex", { agentId });
    try {
      for (const point of points) {
        expect(await waitFor(join(pauseDir, `paused.${point}`), 20_000), point).toBe(true);
        const current = await readRow(harper, id);
        expect(current?.undeclaredReindexProbe).toBe("keep");
        expect(await putRow(harper, current)).toBe(200);
        writeFileSync(join(pauseDir, `go.${point}`), "");
      }
    } finally {
      for (const point of points) writeFileSync(join(pauseDir, `go.${point}`), "");
    }
    const response = await pending;
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.stats.reindexed).toBe(0);
    expect(body.stats.errors).toBe(1);
    expect(body.stats.errorSamples[0].message).toContain("staged values unconfirmed");
    expect((await readRow(harper, id))?.undeclaredReindexProbe).toBe("keep");
  }, 90_000);

  it("does not count a row still missing from the agentId index after a newer same-values write", async () => {
    const id = "wbc-reindex-index-gap";
    const agentId = "wbc-reindex-index-agent";
    await insertRow(harper, { id, agentId, content: "index gap", contentHash: id, instanceToken: randomUUID() });
    const probe = await fetch(`${harper.httpURL}/WriteBackIndexProbe`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
      body: JSON.stringify({ id, agentId }),
    });
    expect(probe.status, await probe.clone().text()).toBe(200);
    expect((await probe.json() as any).indexed).toBe(false);
    const { response, paused, released } = await withPaused("reindex-put-commit",
      () => authSend(harper, admin, "POST", "/MemoryReindex", { agentId }),
      async () => expect(await putRow(harper, await readRow(harper, id))).toBe(200));
    expect(paused).toBe(true);
    expect(released).toBe("go");
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.stats.totalMissing).toBe(1);
    expect(body.stats.reindexed).toBe(0);
    expect(body.stats.errors).toBe(1);
    expect(body.stats.errorSamples[0].message).toContain("MemoryReindex agentId index");
    expect((await readRow(harper, id))?.content).toBe("index gap");
  }, 60_000);

}
);

describe("flair#2354 — the embedding backfill after a Memory write (real Harper)", () => {
  for (const point of ["backfill-embedding-pre", "backfill-embedding"]) {
    it(`fills the embedding and keeps a competing content edit (${point})`, async () => {
      const id = `wbc-backfill-${point}`;
      // insertRow's 3-value embedding is below the backfill's length threshold.
      await insertRow(harper, { id, agentId: reflectAgent.id, content: "backfill v1", contentHash: id, instanceToken: randomUUID() });
      const { response, released, paused, competed } = await withPaused(
        point,
        () => authSend(harper, reflectAgent, "PATCH", `/Memory/${id}`, { subject: "backfill-subject" }),
        () => updateRow(harper, { id, content: "backfill edited" }),
      );
      expect(paused).toBe(true);
      // The backfill is not awaited by the PATCH request, so the release marker
      // can be written after withPaused returns: read it until it is written.
      let releaseMarker = released;
      for (const until = Date.now() + 5_000; !releaseMarker && Date.now() < until;) {
        await new Promise((r) => setTimeout(r, 25));
        try { releaseMarker = readFileSync(join(pauseDir, `released.${point}`), "utf8"); } catch { releaseMarker = ""; }
      }
      expect(releaseMarker, "the embedding backfill was not paused and released by this test").toBe("go");
      expect(competed, "the competing content edit was not applied").toBe(200);
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
      const deadline = Date.now() + 120_000;
      let row = await readRow(harper, id);
      while (!(Array.isArray(row?.embedding) && row.embedding.length > 100) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        row = await readRow(harper, id);
      }
      console.log(`${point} backfill row:`, JSON.stringify({ content: row?.content, subject: row?.subject, dims: row?.embedding?.length }));
      expect(row?.embedding?.length, "the backfill wrote a computed embedding").toBeGreaterThan(100);
      expect(row?.content, "the competing content edit is kept").toBe("backfill edited");
      expect(row?.subject, "the PATCH that triggered the backfill is kept").toBe("backfill-subject");
    }, 180_000);
  }

  it("retries the backfill when a newer full write drops its commit", async () => {
    const id = "wbc-backfill-commit-gap";
    await insertRow(harper, { id, agentId: reflectAgent.id, content: "backfill gap v1", contentHash: id, instanceToken: randomUUID() });
    const COMPETED = "backfill gap subject from the newer write";
    const { released, paused } = await withPaused(
      "backfill-embedding-commit",
      () => authSend(harper, reflectAgent, "PATCH", `/Memory/${id}`, { subject: "backfill gap subject" }),
      async () => {
        const current = await readRow(harper, id);
        // The newer full write commits between the backfill's confirmation and
        // its commit; the backfill's update is dropped.
        expect(await putRow(harper, { ...current, subject: COMPETED }), "the competing full write").toBe(200);
      },
    );
    expect(paused, "the backfill was not paused at its commit gap").toBe(true);
    expect(await releaseMarker("backfill-embedding-commit", released), "the backfill was not paused and released by this test").toBe("go");
    const row = await readUntil(id, (r) => Array.isArray(r?.embedding) && r.embedding.length > 100, 120_000);
    console.log(`backfill commit-gap row:`, JSON.stringify({ content: row?.content, subject: row?.subject, dims: row?.embedding?.length }));
    expect(row?.embedding?.length, "the retried backfill wrote a computed embedding").toBeGreaterThan(100);
    expect(row?.content, "the newer write's content is kept").toBe("backfill gap v1");
    expect(row?.subject, "the newer write's field is kept").toBe(COMPETED);
  }, 180_000);
});

describe("flair#2653 — usage contributions across agents (real Harper)", () => {
  it("does not repeat an agent's committed increment after another agent increments", async () => {
    const id = "wbc-usage-verify";
    await insertRow(harper, { id, agentId: reflectAgent.id, content: "shared usage", contentHash: id, instanceToken: randomUUID(), usageCount: 0 });
    const { response, paused, released } = await withPaused("usage-count-verify",
      () => authSend(harper, reflectAgent, "POST", "/RecordUsage", { memoryIds: [id] }),
      async () => {
        expect((await readRow(harper, id))?.usageCount).toBe(1);
        const second = await authSend(harper, feedAgent, "POST", "/RecordUsage", { memoryIds: [id] });
        expect(second.status, await second.clone().text()).toBe(200);
        expect((await readRow(harper, id))?.usageCount).toBe(2);
      });
    expect(paused).toBe(true);
    expect(released).toBe("go");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: true });
    expect((await readRow(harper, id))?.usageCount).toBe(2);
    let log = harper.getLog?.() ?? "";
    for (const until = Date.now() + 5_000; !log.includes("usage count unconfirmed, stored_row_changed") && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      log = harper.getLog?.() ?? "";
    }
    expect(log).toContain("usage count unconfirmed, stored_row_changed");
    for (const agent of [reflectAgent, feedAgent]) {
      const ledger = await adminOp(harper, { operation: "search_by_hash", database: "flair", table: "MemoryUsage", hash_values: [`${agent.id}:${id}`], get_attributes: ["*"] });
      expect(ledger.status).toBe(200);
      expect(await ledger.json()).toMatchObject([{ agentId: agent.id, memoryId: id }]);
      const repeat = await authSend(harper, agent, "POST", "/RecordUsage", { memoryIds: [id] });
      expect(repeat.status).toBe(200);
    }
    expect((await readRow(harper, id))?.usageCount).toBe(2);
  }, 60_000);
});

describe("flair#2354 — a self-referential derivedFrom (real Harper)", () => {
  it("POST /Memory refuses a derivedFrom entry equal to the row's own id with a named 400 and writes nothing", async () => {
    const id = "wbc-self-derived";
    const response = await authSend(harper, reflectAgent, "POST", "/Memory", {
      id, agentId: reflectAgent.id, content: "a memory that names itself as its source", derivedFrom: [id],
    });
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(400);
    expect(JSON.parse(text).error).toBe("derived_from_self");
    expect(await readRow(harper, id)).toBeNull();
  }, 60_000);
});

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

/** The release marker of a pause whose write-back the request does not await:
 *  read it until it is written. */
async function releaseMarker(point: string, initial: string): Promise<string> {
  let marker = initial;
  for (const until = Date.now() + 5_000; !marker && Date.now() < until;) {
    await new Promise((r) => setTimeout(r, 25));
    try { marker = readFileSync(join(pauseDir, `released.${point}`), "utf8"); } catch { marker = ""; }
  }
  return marker;
}

/** Read `id` until `done(row)` holds or `ms` passes; the last read is returned. */
async function readUntil(id: string, done: (row: any) => boolean, ms: number): Promise<any> {
  const deadline = Date.now() + ms;
  let row = await readRow(harper, id);
  while (!done(row) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    row = await readRow(harper, id);
  }
  return row;
}

describe("flair#2354 — the ReflectMemories source stamp in execute mode (real Harper)", () => {
  async function reflectSource(agentId: string, id: string): Promise<TestAgent> {
    const agent = mkAgent(agentId);
    await seedAgent(harper, agent);
    await insertRow(harper, {
      id, agentId, content: `reflect source ${id}`, contentHash: id, instanceToken: randomUUID(),
      durability: "standard", createdAt: new Date().toISOString(),
    });
    return agent;
  }
  const reflect = (agent: TestAgent) => authSend(harper, agent, "POST", "/ReflectMemories", { agentId: agent.id, execute: true });

  it("stamps lastReflected on a gathered source row", async () => {
    const id = "wbc-reflect-clean";
    const agent = await reflectSource("wbc-reflect-clean-agent", id);
    const response = await reflect(agent);
    expect(response.status, (await response.clone().text()).slice(0, 300)).toBe(200);
    const row = await readUntil(id, (r) => !!r?.lastReflected, 10_000);
    expect(row?.lastReflected, "the source stamp landed").toBeTruthy();
    expect(row?.content).toBe(`reflect source ${id}`);
  }, 60_000);

  for (const point of ["reflect-sources-pre", "reflect-sources"]) {
    it(`does not stamp a source whose gathered content changed (${point})`, async () => {
      const id = `wbc-reflect-content-${point}`;
      const agent = await reflectSource(`wbc-reflect-content-agent-${point}`, id);
      const { response, released, paused, competed } = await withPaused(
        point,
        () => reflect(agent),
        () => updateRow(harper, { id, content: "reflect source edited" }),
      );
      expect(paused).toBe(true);
      expect(await releaseMarker(point, released), "the source stamp was not paused and released by this test").toBe("go");
      expect(competed, "the competing edit was not applied").toBe(200);
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBe(200);
      // Give the released write-back time to finish before reading.
      const row = await readUntil(id, (r) => !!r?.lastReflected, 2_000);
      expect(row?.content, "the competing content edit is kept").toBe("reflect source edited");
      expect(row?.lastReflected ?? null, "a source changed since the gather is not stamped").toBeNull();
    }, 60_000);

    it(`stamps a source whose ungathered field changed and keeps that edit (${point})`, async () => {
      const id = `wbc-reflect-subject-${point}`;
      const agent = await reflectSource(`wbc-reflect-subject-agent-${point}`, id);
      const { response, released, paused, competed } = await withPaused(
        point,
        () => reflect(agent),
        () => updateRow(harper, { id, subject: "reflect subject edited" }),
      );
      expect(paused).toBe(true);
      expect(await releaseMarker(point, released), "the source stamp was not paused and released by this test").toBe("go");
      expect(competed, "the competing edit was not applied").toBe(200);
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBe(200);
      const row = await readUntil(id, (r) => !!r?.lastReflected, 10_000);
      expect(row?.lastReflected, "the source stamp landed").toBeTruthy();
      expect(row?.subject, "the competing edit is kept").toBe("reflect subject edited");
      expect(row?.content).toBe(`reflect source ${id}`);
    }, 60_000);
  }
});

describe("flair#2354 — the promotion stamp write-back under a concurrent change (real Harper)", () => {
  it("stamps the row an unpaused auto-promotion wrote", async () => {
    const agentId = "wbc-stamp-agent-clean";
    const stampAgent = mkAgent(agentId);
    await seedAgent(harper, stampAgent);
    const claim = "promotion stamp claim for the clean run";
    await seedCandidate(harper, agentId, { id: "wbc-stamp-cand-clean", claim, scopeTag: `adk:app:${agentId}`, sourceMemoryIds: [] });
    const response = await authSend(harper, stampAgent, "POST", "/AutoPromoteCandidates", { agentId });
    expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
    const row = await findPromotedRow(harper, agentId, claim);
    expect(row?.promotionStatus, "the verdict landed on the written row").toBe("approved");
    expect(row?.promotedBy).toBeTruthy();
  }, 60_000);

  // promotion-stamp-select: between the Memory write and the stamp's first
  // read; the other two are the write-back helper's own points.
  for (const point of ["promotion-stamp-select", "promotion-stamp-pre", "promotion-stamp"]) {
    it(`refuses a promotion stamp on a replaced row (${point})`, async () => {
      const agentId = `wbc-stamp-agent-${point}`;
      const stampAgent = mkAgent(agentId);
      await seedAgent(harper, stampAgent);
      const claim = `promotion stamp claim for ${point}`;
      await seedCandidate(harper, agentId, { id: `wbc-stamp-cand-${point}`, claim, scopeTag: `adk:app:${agentId}`, sourceMemoryIds: [] });
      const TOKEN2 = randomUUID();
      const COMPETED = `competing stamp edit for ${point}`;
      const { response, released, paused, competed } = await withPaused(
        point,
        () => authSend(harper, stampAgent, "POST", "/AutoPromoteCandidates", { agentId }),
        async () => {
          const row = await findPromotedRow(harper, agentId, claim);
          if (!row) throw new Error(`no promoted row for ${agentId} while paused at ${point}`);
          const status = await updateRow(harper, { id: row.id, content: COMPETED, instanceToken: TOKEN2 });
          expect(status, `competing update returned ${status}`).toBe(200);
          return row.id as string;
        },
      );
      expect(released, "the promotion stamp was not paused and released by this test").toBe("go");
      expect(paused).toBe(true);
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
      expect(competed, "the competing writer did not run").toBeTruthy();
      const row = await readRow(harper, competed as string);
      console.log(`${point} stamp row:`, JSON.stringify({ content: row?.content, promotionStatus: row?.promotionStatus, instanceToken: row?.instanceToken }));
      expect(row?.promotedBy).toBeFalsy();
      expect(row?.content, "the competing content edit is kept, not reverted by the stamp").toBe(COMPETED);
      expect(row?.instanceToken, "the competing incarnation token is kept, not reverted").toBe(TOKEN2);
    }, 60_000);
  }
});

for (const point of ["feed-ingest-pre", "feed-ingest"]) {
  for (const field of ["agentId", "contentHash"]) {
    it(`refuses a changed feed ${field} (${point})`, async () => {
      const id = `wbc-feed-replaced-${field}-${point}`;
      await insertRow(harper, { id, agentId: feedAgent.id, content: "original", contentHash: id, instanceToken: randomUUID() });
      const { response, released, paused } = await withPaused(point,
        () => authSend(harper, feedAgent, "POST", "/FeedMemories", { id, agentId: feedAgent.id, content: "submitted" }),
        () => updateRow(harper, { id, [field]: "replacement" }));
      expect(paused).toBe(true);
      expect(released).toBe("go");
      const text = await response.clone().text();
      // A changed owner is refused by the plan's owner check (403); a changed
      // contentHash fails the write-back's target check (409).
      expect(response.status, text.slice(0, 300)).toBe(field === "agentId" ? 403 : 409);
      if (field === "contentHash") expect(JSON.parse(text).error).toBe("feed_target_changed");
      const row = await readRow(harper, id);
      expect(row?.[field]).toBe("replacement");
      expect(row?.content).toBe("original");
    }, 60_000);
  }
}
