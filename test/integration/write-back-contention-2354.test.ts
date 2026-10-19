import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { WRITE_BACK_ATTEMPTS } from "../../resources/write-back.ts";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { promotionContentHash } from "../../resources/promotion-binding.ts";

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
  if (!paused) {
    console.error(`pause ${point} not reached: ${response.status} ${await response.clone().text()}\n${harper.getLog?.() ?? ""}`);
  }
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, competed, released, paused };
}

/** Every Memory row owned by `agentId`, read through the admin ops API. */
async function memoryRowsForAgent(harper: HarperInstance, agentId: string): Promise<any[]> {
  const res = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "agentId", search_value: agentId, get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_value returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  const rows = JSON.parse(text) as any[];
  return Array.isArray(rows) ? rows : [];
}

/** The promoted Memory row a paused sweep wrote: the id is minted inside the
 *  handler, so the competing writer finds it by its owning agent + content. */
async function findPromotedRow(harper: HarperInstance, agentId: string, claim: string): Promise<any> {
  return (await memoryRowsForAgent(harper, agentId)).find((r) => r?.content === claim) ?? null;
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

async function readCandidate(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_hash", database: "flair", table: "MemoryCandidate", hash_values: [id], get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `candidate search returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
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
    for (const name of ["WriteBackIndexProbe.js", "WriteBackTrace.js"]) {
      cpSync(resolve(`test/fixtures/write-back-app/${name}`), join(appDir, `dist/resources/${name}`));
    }
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
    expect(body.stats.errorSamples[0].message).toBe(`MemoryReindex: row ${id} was confirmed after commit but is now absent from the agentId index query (index unconfirmed)`);
    expect(body.stats.errorSamples[0].outcome).toBe("unconfirmed");
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
  it("logs conflict when a contribution count write aborts before commit", async () => {
    const id = "wbc-usage-conflict";
    await insertRow(harper, { id, agentId: reflectAgent.id, content: "usage conflict", contentHash: id, instanceToken: randomUUID(), usageCount: 0 });
    const replacement = randomUUID();
    const { response, paused, released } = await withPaused("usage-count-pre",
      () => authSend(harper, reflectAgent, "POST", "/RecordUsage", { memoryIds: [id] }),
      async () => expect(await updateRow(harper, { id, instanceToken: replacement })).toBe(200));
    expect(paused).toBe(true);
    expect(released).toBe("go");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: true });
    expect(await readRow(harper, id)).toMatchObject({ usageCount: 0, instanceToken: replacement });
    const ledger = await adminOp(harper, { operation: "search_by_hash", database: "flair", table: "MemoryUsage", hash_values: [`${reflectAgent.id}:${id}`], get_attributes: ["*"] });
    expect(ledger.status).toBe(200);
    expect(await ledger.json()).toMatchObject([{ agentId: reflectAgent.id, memoryId: id }]);
    let log = harper.getLog?.() ?? "";
    for (const until = Date.now() + 5_000; !log.includes("contribution count write aborted, stored_row_changed") && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      log = harper.getLog?.() ?? "";
    }
    expect(log).toContain("contribution count write aborted, stored_row_changed");
    expect(log).toMatch(/outcome:\s*['"]conflict['"]/);
    expect(log).toContain("no write committed by this attempt");
  }, 60_000);

  it("reports a dropped increment unconfirmed when another agent commits the same count in the commit gap", async () => {
    const id = "wbc-usage-same-value";
    await insertRow(harper, { id, agentId: reflectAgent.id, content: "same-value usage", contentHash: id, instanceToken: randomUUID(), usageCount: 5 });
    const attemptLog = join(pauseDir, "attempts.write-back");
    const { response, competed, paused, released } = await withPaused("usage-count-commit",
      () => authSend(harper, reflectAgent, "POST", "/RecordUsage", { memoryIds: [id] }),
      async () => {
        expect((await readRow(harper, id))?.usageCount).toBe(5);
        const second = await authSend(harper, feedAgent, "POST", "/RecordUsage", { memoryIds: [id] });
        expect(second.status, await second.clone().text()).toBe(200);
        expect(await second.json()).toEqual({ recorded: true });
        const row = await readRow(harper, id);
        expect(row.usageCount).toBe(6);
        expect(row.writeBackWriteId).toBeString();
        return row.writeBackWriteId as string;
      });
    expect(paused).toBe(true);
    expect(released).toBe("go");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: true });
    const row = await readRow(harper, id);
    expect(row.usageCount).toBe(6);
    expect(row.writeBackWriteId).toBe(competed);
    const settled = readFileSync(attemptLog, "utf8").split("\n")
      .filter((line) => line.startsWith(`usage-recording\t${id}\t`) && line.split("\t").length === 4);
    expect(settled).toEqual([
      `usage-recording\t${id}\t1\tapplied`,
      `usage-recording\t${id}\t1\tunconfirmed`,
    ]);
    for (const agent of [reflectAgent, feedAgent]) {
      const ledger = await adminOp(harper, { operation: "search_by_hash", database: "flair", table: "MemoryUsage", hash_values: [`${agent.id}:${id}`], get_attributes: ["*"] });
      expect(ledger.status).toBe(200);
      expect(await ledger.json()).toMatchObject([{ agentId: agent.id, memoryId: id }]);
    }
  }, 60_000);

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
    for (const until = Date.now() + 5_000; !log.includes("usage count unconfirmed, write_unconfirmed") && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      log = harper.getLog?.() ?? "";
    }
    expect(log).toContain("usage count unconfirmed, write_unconfirmed");
    expect(log).toMatch(/outcome:\s*['"]unconfirmed['"]/);
    expect(log).toContain("staged values unconfirmed after commit");
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
    const cand = await readCandidate(harper, "wbc-stamp-cand-clean");
    expect(cand?.status, "a landed verdict marks the candidate promoted").toBe("promoted");
  }, 60_000);

  it("a refused stamp records its row; a changed incarnation is not reused", async () => {
    const agentId = "wbc-stamp-agent-recover";
    const stampAgent = mkAgent(agentId);
    await seedAgent(harper, stampAgent);
    const claim = "promotion stamp claim for the recovery sweep";
    await seedCandidate(harper, agentId, {
      id: "wbc-stamp-cand-recover", claim, scopeTag: `adk:app:${agentId}`, sourceMemoryIds: [],
    });
    const TOKEN2 = randomUUID();

    // Sweep 1: the row is written, then a competing incarnation token replaces
    // the one the sweep wrote and recorded, so its stamp is refused.
    const { response, released, paused, competed } = await withPaused(
      "promotion-stamp-select",
      () => authSend(harper, stampAgent, "POST", "/AutoPromoteCandidates", { agentId }),
      async () => {
        const row = await findPromotedRow(harper, agentId, claim);
        if (!row) throw new Error(`no promoted row for ${agentId} while paused`);
        const status = await updateRow(harper, { id: row.id, instanceToken: TOKEN2 });
        expect(status, `competing update returned ${status}`).toBe(200);
        return row.id as string;
      },
    );
    expect(paused, "the promotion stamp did not pause").toBe(true);
    expect(released, "the promotion stamp was not paused and released by this test").toBe("go");
    expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
    const first = await response.json() as any;
    expect(first.skipped.find((s: any) => s.id === "wbc-stamp-cand-recover")?.reason).toBe("stamp_refused");

    const rowAfterSweep1 = await readRow(harper, competed as string);
    expect(rowAfterSweep1?.content).toBe(claim);
    expect(rowAfterSweep1?.promotionStatus ?? null).toBeNull();
    const candAfterSweep1 = await readCandidate(harper, "wbc-stamp-cand-recover");
    expect(candAfterSweep1?.status).toBe("pending");
    expect(candAfterSweep1?.promotedRowId, "the sweep records the row it wrote").toBe(competed);
    expect(typeof candAfterSweep1?.promotedRowInstanceToken).toBe("string");
    expect(candAfterSweep1.promotedRowInstanceToken.length).toBeGreaterThan(0);
    expect(candAfterSweep1.promotedRowInstanceToken, "the recorded token is the one the sweep wrote, not the replacement").not.toBe(TOKEN2);

    // Sweep 2: the recorded row is no longer that incarnation, so it is not
    // reused; a fresh row is written and the recorded row stays unstamped.
    const second = await authSend(harper, stampAgent, "POST", "/AutoPromoteCandidates", { agentId });
    expect(second.status, (await second.clone().text()).slice(0, 300)).toBeLessThan(300);
    const body = await second.json() as any;
    const rows = (await memoryRowsForAgent(harper, agentId)).filter((r) => r.content === claim);
    expect(rows.length, "the changed incarnation must not be reused").toBe(2);
    const recordedRow = rows.find((r) => r.id === competed);
    expect(recordedRow?.promotionStatus ?? null, "nothing is stamped onto the changed row").toBeNull();
    const freshRow = rows.find((r) => r.id !== competed);
    expect(freshRow?.promotionStatus, "the fresh row carries the verdict").toBe("approved");
    expect(freshRow?.promotedBy).toBeTruthy();
    expect(body.promoted, "the sweep reports the row it stamped").toContain(freshRow?.id);
    expect(body.promoted).not.toContain(competed);
    const candAfterSweep2 = await readCandidate(harper, "wbc-stamp-cand-recover");
    expect(candAfterSweep2?.status).toBe("promoted");
    expect(candAfterSweep2?.promotedRowId).toBe(freshRow?.id);
  }, 60_000);

  it("reuses and stamps the unchanged row a pending candidate records", async () => {
    const agentId = "wbc-stamp-agent-reuse";
    const stampAgent = mkAgent(agentId);
    await seedAgent(harper, stampAgent);
    const claim = "promotion stamp claim for a successive sweep";
    const candidateId = "wbc-stamp-cand-reuse";
    const rowId = "wbc-stamp-row-reuse";
    const token = randomUUID();
    // The state a sweep that wrote the row and had its stamp refused leaves:
    // the candidate is pending and records the row it wrote; the row is
    // unstamped and carries the fields the sweep writes.
    await insertRow(harper, {
      id: rowId, agentId, content: claim, contentHash: rowId, instanceToken: token,
      visibility: "private", durability: "persistent",
      tags: [`adk:app:${agentId}`, "nightly-rem-promoted", "auto-promoted", `from:${candidateId}`],
    });
    await seedCandidate(harper, agentId, {
      id: candidateId, claim, scopeTag: `adk:app:${agentId}`, sourceMemoryIds: [],
      promotedRowId: rowId, promotedRowInstanceToken: token,
    });

    const response = await authSend(harper, stampAgent, "POST", "/AutoPromoteCandidates", { agentId });
    expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
    const body = await response.json() as any;
    const rows = (await memoryRowsForAgent(harper, agentId)).filter((r) => r.content === claim);
    expect(rows.length, "the retry wrote a duplicate promoted row").toBe(1);
    expect(rows[0].id).toBe(rowId);
    expect(rows[0].promotionStatus, "the verdict landed on the recorded row").toBe("approved");
    expect(rows[0].promotedBy).toBeTruthy();
    expect(rows[0].promotionContentHash, "the verdict is bound to the recorded row's stored content")
      .toBe(promotionContentHash(claim));
    expect(body.promoted, "the sweep reports the row it stamped").toContain(rowId);
    expect((await readCandidate(harper, candidateId))?.status).toBe("promoted");
  }, 60_000);

  it("refuses to stamp a recorded row the owner archives before the stamp takes its lock", async () => {
    const agentId = "wbc-stamp-agent-archived-entry";
    const stampAgent = mkAgent(agentId);
    await seedAgent(harper, stampAgent);
    const claim = "promotion stamp claim archived before the stamp";
    const candidateId = "wbc-stamp-cand-archived-entry";
    const rowId = "wbc-stamp-row-archived-entry";
    const token = randomUUID();
    // A recorded, unstamped row that passes the reuse lookup.
    await insertRow(harper, {
      id: rowId, agentId, content: claim, contentHash: rowId, instanceToken: token,
      visibility: "private", durability: "persistent",
      tags: [`adk:app:${agentId}`, "nightly-rem-promoted", "auto-promoted", `from:${candidateId}`],
    });
    await seedCandidate(harper, agentId, {
      id: candidateId, claim, scopeTag: `adk:app:${agentId}`, sourceMemoryIds: [],
      promotedRowId: rowId, promotedRowInstanceToken: token,
    });

    // promotion-stamp-entry: after the lookup chose the row, before the stamp's
    // lock and first read. The owner archives the row through its own PATCH.
    const { response, released, paused, competed } = await withPaused(
      "promotion-stamp-entry",
      () => authSend(harper, stampAgent, "POST", "/AutoPromoteCandidates", { agentId }),
      async () => {
        const patch = await authSend(harper, stampAgent, "PATCH", `/Memory/${rowId}`, { archived: true });
        return { status: patch.status, text: (await patch.text()).slice(0, 300) };
      },
    );
    expect(paused, "the promotion stamp did not pause at its entry").toBe(true);
    expect(released, "the promotion stamp was not paused and released by this test").toBe("go");
    expect(competed?.status, `the owner's archive PATCH was not applied: ${competed?.text}`).toBeLessThan(300);
    expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
    const body = await response.json() as any;
    expect(body.skipped.find((s: any) => s.id === candidateId)?.reason, "the stamp on the archived row is refused").toBe("stamp_refused");
    expect(body.promoted).not.toContain(rowId);
    const row = await readRow(harper, rowId);
    expect(row?.archived, "the owner's archive is kept").toBe(true);
    expect(row?.instanceToken).toBe(token);
    expect(row?.promotionStatus ?? null, "no verdict is stamped onto the archived row").toBeNull();
    expect(row?.promotedBy ?? null, "no reviewer is stamped onto the archived row").toBeNull();
    expect(row?.promotionContentHash ?? null, "no content binding is stamped onto the archived row").toBeNull();
    const rows = (await memoryRowsForAgent(harper, agentId)).filter((r) => r.content === claim);
    expect(rows.length, "the sweep chose the recorded row and wrote no other").toBe(1);
    const cand = await readCandidate(harper, candidateId);
    expect(cand?.status, "a refused stamp leaves the candidate pending").toBe("pending");
    expect(cand?.promotedRowId).toBe(rowId);
    expect(cand?.promotedRowInstanceToken).toBe(token);
  }, 60_000);

  it("does not reuse a row with the candidate's tag and claim that the sweep did not write", async () => {
    const agentId = "wbc-stamp-agent-owner-row";
    const stampAgent = mkAgent(agentId);
    await seedAgent(harper, stampAgent);
    const claim = "promotion stamp claim with an owner-written row";
    const candidateId = "wbc-stamp-cand-owner-row";
    const ownerRowId = "wbc-stamp-row-owner-written";
    // The owner can write its own Memory rows with this candidate's tag and
    // claim; the candidate records no row, so none of them is reused.
    await insertRow(harper, {
      id: ownerRowId, agentId, content: claim, contentHash: ownerRowId, instanceToken: randomUUID(),
      visibility: "private", durability: "persistent",
      tags: [`adk:app:${agentId}`, "nightly-rem-promoted", "auto-promoted", `from:${candidateId}`],
    });
    await seedCandidate(harper, agentId, { id: candidateId, claim, scopeTag: `adk:app:${agentId}`, sourceMemoryIds: [] });

    const response = await authSend(harper, stampAgent, "POST", "/AutoPromoteCandidates", { agentId });
    expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
    const body = await response.json() as any;
    const rows = (await memoryRowsForAgent(harper, agentId)).filter((r) => r.content === claim);
    expect(rows.length, "the owner-written row must not be reused").toBe(2);
    const ownerRow = rows.find((r) => r.id === ownerRowId);
    expect(ownerRow?.promotionStatus ?? null, "nothing is stamped onto the owner-written row").toBeNull();
    const freshRow = rows.find((r) => r.id !== ownerRowId);
    expect(freshRow?.promotionStatus, "the sweep writes and stamps its own row").toBe("approved");
    expect(body.promoted).toContain(freshRow?.id);
    expect(body.promoted).not.toContain(ownerRowId);
  }, 60_000);

  it("does not reuse a matching row the owner wrote through the Memory resource", async () => {
    const agentId = "wbc-stamp-agent-client-row";
    const stampAgent = mkAgent(agentId);
    await seedAgent(harper, stampAgent);
    const claim = "promotion stamp claim with a row the owner wrote through /Memory";
    const candidateId = "wbc-stamp-cand-client-row";
    const clientRowId = "wbc-stamp-row-client-written";
    const sweepTags = [`adk:app:${agentId}`, "nightly-rem-promoted", "auto-promoted", `from:${candidateId}`];
    // The owner's own authenticated Memory write: the candidate's claim, every
    // tag the sweep writes, and the sweep's visibility and durability.
    const written = await authSend(harper, stampAgent, "PUT", `/Memory/${clientRowId}`, {
      id: clientRowId, agentId, content: claim, visibility: "private", durability: "persistent", tags: sweepTags,
    });
    expect(written.status, (await written.clone().text()).slice(0, 300)).toBeLessThan(300);
    const clientRow = await readRow(harper, clientRowId);
    expect(clientRow?.agentId).toBe(agentId);
    expect(clientRow?.content).toBe(claim);
    expect(clientRow?.visibility).toBe("private");
    expect(clientRow?.durability).toBe("persistent");
    expect(clientRow?.archived === true, "the owner-written row is live").toBe(false);
    for (const tag of sweepTags) expect(clientRow?.tags, `the owner-written row carries ${tag}`).toContain(tag);
    expect(clientRow?.promotionStatus ?? null, "the owner-written row starts unstamped").toBeNull();
    expect(typeof clientRow?.instanceToken).toBe("string");
    await seedCandidate(harper, agentId, { id: candidateId, claim, scopeTag: `adk:app:${agentId}`, sourceMemoryIds: [] });

    const response = await authSend(harper, stampAgent, "POST", "/AutoPromoteCandidates", { agentId });
    expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
    const body = await response.json() as any;
    const rows = (await memoryRowsForAgent(harper, agentId)).filter((r) => r.content === claim);
    expect(rows.length, "the owner-written row must not be reused").toBe(2);
    const ownerRow = rows.find((r) => r.id === clientRowId);
    expect(ownerRow?.promotionStatus ?? null, "nothing is stamped onto the owner-written row").toBeNull();
    expect(ownerRow?.promotedBy ?? null, "no reviewer is stamped onto the owner-written row").toBeNull();
    expect(ownerRow?.promotedAt ?? null, "no decision time is stamped onto the owner-written row").toBeNull();
    expect(ownerRow?.promotionContentHash ?? null, "no content binding is stamped onto the owner-written row").toBeNull();
    expect(ownerRow?.instanceToken, "the owner-written row keeps its incarnation").toBe(clientRow.instanceToken);
    const freshRow = rows.find((r) => r.id !== clientRowId);
    expect(freshRow?.promotionStatus, "the sweep writes and stamps its own row").toBe("approved");
    expect(body.promoted).toContain(freshRow?.id);
    expect(body.promoted).not.toContain(clientRowId);
    const cand = await readCandidate(harper, candidateId);
    expect(cand?.status).toBe("promoted");
    expect(cand?.promotedRowId, "the candidate records the row the sweep wrote").toBe(freshRow?.id);
  }, 60_000);

  for (const mismatch of [
    { name: "visibility", visibility: "shared", durability: "persistent" },
    { name: "durability", visibility: "private", durability: "standard" },
  ] as const) {
    it(`does not reuse a recorded row with the wrong ${mismatch.name}`, async () => {
      const agentId = `wbc-stamp-agent-wrong-${mismatch.name}`;
      const stampAgent = mkAgent(agentId);
      await seedAgent(harper, stampAgent);
      const claim = `promotion stamp claim with the wrong ${mismatch.name}`;
      const candidateId = `wbc-stamp-cand-wrong-${mismatch.name}`;
      const rowId = `wbc-stamp-row-wrong-${mismatch.name}`;
      const token = randomUUID();
      await insertRow(harper, {
        id: rowId, agentId, content: claim, contentHash: rowId, instanceToken: token,
        visibility: mismatch.visibility, durability: mismatch.durability,
        tags: [`adk:app:${agentId}`, "nightly-rem-promoted", "auto-promoted", `from:${candidateId}`],
      });
      await seedCandidate(harper, agentId, {
        id: candidateId, claim, scopeTag: `adk:app:${agentId}`, sourceMemoryIds: [],
        promotedRowId: rowId, promotedRowInstanceToken: token,
      });

      const response = await authSend(harper, stampAgent, "POST", "/AutoPromoteCandidates", { agentId });
      expect(response.status, (await response.clone().text()).slice(0, 300)).toBeLessThan(300);
      const body = await response.json() as any;
      const rows = (await memoryRowsForAgent(harper, agentId)).filter((r) => r.content === claim);
      expect(rows.length, `the row with the wrong ${mismatch.name} must not be reused`).toBe(2);
      const wrongRow = rows.find((r) => r.id === rowId);
      expect(wrongRow?.promotionStatus ?? null, "nothing is stamped onto the mismatched row").toBeNull();
      const freshRow = rows.find((r) => r.id !== rowId);
      expect(freshRow?.promotionStatus, "the sweep writes and stamps its own row").toBe("approved");
      expect(body.promoted).toContain(freshRow?.id);
      expect(body.promoted).not.toContain(rowId);
    }, 60_000);
  }

  it("the recorded promoted-row identity on a candidate is server-written", async () => {
    const agentId = "wbc-stamp-agent-identity";
    const agent = mkAgent(agentId);
    await seedAgent(harper, agent);
    const candidateId = "wbc-stamp-cand-identity";
    await seedCandidate(harper, agentId, {
      id: candidateId, claim: "promotion stamp claim with a client write", scopeTag: `adk:app:${agentId}`, sourceMemoryIds: [],
    });
    const before = await authSend(harper, agent, "GET", `/MemoryCandidate/${candidateId}`);
    expect(before.status).toBe(200);
    const stored = await before.json() as any;
    const put = await authSend(harper, agent, "PUT", `/MemoryCandidate/${candidateId}`, { ...stored, promotedRowId: "forged-row" });
    expect(put.status, (await put.clone().text()).slice(0, 300)).toBe(403);
    const post = await authSend(harper, agent, "POST", "/MemoryCandidate", {
      id: "wbc-stamp-cand-identity-create", agentId, claim: "A staged claim.", status: "pending",
      generatedAt: new Date().toISOString(), generatedBy: "test-seed",
      promotedRowId: "forged-row", promotedRowInstanceToken: "forged-token",
    });
    expect(post.status, (await post.clone().text()).slice(0, 300)).toBe(403);
    expect((await readCandidate(harper, candidateId))?.promotedRowId ?? null, "the refused write changed nothing").toBeNull();
    expect(await readCandidate(harper, "wbc-stamp-cand-identity-create")).toBeNull();
  }, 60_000);

  /** A pending candidate that records a promoted row, and the owner's view of it. */
  async function recordedIdentityCandidate(slug: string) {
    const agentId = `wbc-stamp-agent-identity-${slug}`;
    const agent = mkAgent(agentId);
    await seedAgent(harper, agent);
    const candidateId = `wbc-stamp-cand-identity-${slug}`;
    const recordedId = `wbc-stamp-row-identity-${slug}`;
    const recordedToken = randomUUID();
    await seedCandidate(harper, agentId, {
      id: candidateId, claim: `promotion stamp claim with a recorded identity (${slug})`, scopeTag: `adk:app:${agentId}`,
      sourceMemoryIds: [], promotedRowId: recordedId, promotedRowInstanceToken: recordedToken,
    });
    const before = await authSend(harper, agent, "GET", `/MemoryCandidate/${candidateId}`);
    expect(before.status).toBe(200);
    const stored = await before.json() as any;
    expect(stored.promotedRowId).toBe(recordedId);
    expect(stored.promotedRowInstanceToken).toBe(recordedToken);
    const { promotedRowId: _id, promotedRowInstanceToken: _token, ...withoutIdentity } = stored;
    return { agent, candidateId, recordedId, recordedToken, withoutIdentity };
  }

  for (const verb of ["PUT", "PATCH"] as const) {
    for (const forgery of [
      { slug: "token", name: "promotedRowInstanceToken only", fields: () => ({ promotedRowInstanceToken: randomUUID() }), refused: /^forbidden: promotedRowInstanceToken is set by the promotion workflow$/ },
      { slug: "id", name: "promotedRowId only", fields: () => ({ promotedRowId: "wbc-stamp-row-identity-forged" }), refused: /^forbidden: promotedRowId is set by the promotion workflow$/ },
      {
        slug: "both", name: "both promoted-row fields",
        fields: () => ({ promotedRowId: "wbc-stamp-row-identity-forged", promotedRowInstanceToken: randomUUID() }),
        refused: /^forbidden: promotedRow(Id|InstanceToken) is set by the promotion workflow$/,
      },
    ]) {
      it(`refuses an owner ${verb} that sets ${forgery.name} on a candidate and keeps the recorded identity`, async () => {
        const c = await recordedIdentityCandidate(`${verb.toLowerCase()}-${forgery.slug}`);
        const body = verb === "PUT" ? { ...c.withoutIdentity, ...forgery.fields() } : forgery.fields();
        const res = await authSend(harper, c.agent, verb, `/MemoryCandidate/${c.candidateId}`, body);
        const text = await res.text();
        // The stored candidate is read back before the response is judged.
        const after = await readCandidate(harper, c.candidateId);
        expect(after?.promotedRowId, `the refused write keeps the recorded id (${res.status})`).toBe(c.recordedId);
        expect(after?.promotedRowInstanceToken, `the refused write keeps the recorded token (${res.status})`).toBe(c.recordedToken);
        expect(res.status, text.slice(0, 300)).toBe(403);
        expect(JSON.parse(text).error).toMatch(forgery.refused);
      }, 60_000);
    }
  }

  it("accepts an owner PUT or PATCH that leaves the recorded promoted-row identity out, and keeps it", async () => {
    const c = await recordedIdentityCandidate("unchanged");
    const put = await authSend(harper, c.agent, "PUT", `/MemoryCandidate/${c.candidateId}`, { ...c.withoutIdentity, rationalePrompt: "owner edit by PUT" });
    expect(put.status, (await put.clone().text()).slice(0, 300)).toBeLessThan(300);
    const afterPut = await readCandidate(harper, c.candidateId);
    expect(afterPut?.rationalePrompt).toBe("owner edit by PUT");
    expect(afterPut?.promotedRowId, "a PUT that omits the identity keeps the recorded id").toBe(c.recordedId);
    expect(afterPut?.promotedRowInstanceToken, "a PUT that omits the identity keeps the recorded token").toBe(c.recordedToken);
    const patch = await authSend(harper, c.agent, "PATCH", `/MemoryCandidate/${c.candidateId}`, { rationalePrompt: "owner edit by PATCH" });
    expect(patch.status, (await patch.clone().text()).slice(0, 300)).toBeLessThan(300);
    const afterPatch = await readCandidate(harper, c.candidateId);
    expect(afterPatch?.rationalePrompt).toBe("owner edit by PATCH");
    expect(afterPatch?.promotedRowId, "a PATCH without the identity keeps the recorded id").toBe(c.recordedId);
    expect(afterPatch?.promotedRowInstanceToken, "a PATCH without the identity keeps the recorded token").toBe(c.recordedToken);
  }, 60_000);

  for (const verb of ["PUT", "PATCH"] as const) {
    it(`accepts an owner ${verb} that carries content and leaves the recorded promoted-row identity out, and keeps it`, async () => {
      const c = await recordedIdentityCandidate(`${verb.toLowerCase()}-content`);
      const edit = { content: `owner content edit by ${verb}`, rationalePrompt: `owner edit with content by ${verb}` };
      const body = verb === "PUT" ? { ...c.withoutIdentity, ...edit } : edit;
      const res = await authSend(harper, c.agent, verb, `/MemoryCandidate/${c.candidateId}`, body);
      expect(res.status, (await res.clone().text()).slice(0, 300)).toBeLessThan(300);
      const after = await readCandidate(harper, c.candidateId);
      expect(after?.rationalePrompt, `the ${verb} was applied`).toBe(edit.rationalePrompt);
      expect(after?.content, `the ${verb}'s content was stored`).toBe(edit.content);
      expect(after?.promotedRowId, `a ${verb} carrying content keeps the recorded id`).toBe(c.recordedId);
      expect(after?.promotedRowInstanceToken, `a ${verb} carrying content keeps the recorded token`).toBe(c.recordedToken);
    }, 60_000);
  }

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
      const cand = await readCandidate(harper, `wbc-stamp-cand-${point}`);
      expect(cand?.status, "a refused stamp leaves the candidate unpromoted").toBe("pending");
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
