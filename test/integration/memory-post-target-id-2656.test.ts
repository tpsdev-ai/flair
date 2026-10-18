/**
 * memory-post-target-id-2656.test.ts — real-Harper classification of a Memory
 * POST whose target id is caller-supplied (flair#2656).
 *
 * Real Harper, ephemeral instance; every URL is asserted to be this test's own
 * instance before the first call.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`mpost-owner-${sfx}`);
const now = () => new Date().toISOString();

let harper: HarperInstance;
let pauseDir = "";
let appDir = "";
let seq = 0;
const nextId = (label: string) => `mpost-${label}-${sfx}-${++seq}`;

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

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(harper.httpURL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519(A, method, path) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

async function callInProcess(record: unknown): Promise<Response> {
  const response = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ op: "postMemory", agentId: A.id, record }),
    signal: AbortSignal.timeout(60_000),
  });
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  return result.ok ? Response.json(result.value) : new Response(result.body, { status: result.status });
}

async function seedRow(id: string, content: string, extra: Record<string, unknown> = {}): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id, agentId: A.id, content, contentHash: id, visibility: "shared", archived: false,
      durability: "persistent", instanceToken: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z", embedding: [0.1, 0.1, 0.1], embeddingModel: "test",
      ...extra,
    }],
  });
}

/** Commit a competing write to the row through the ops API (no write lock). */
async function commitCompetingWrite(id: string, content: string): Promise<void> {
  const row = {
    id, agentId: A.id, content, contentHash: `${id}-competing`, visibility: "shared", archived: false,
    durability: "persistent", instanceToken: randomUUID(), createdAt: "2026-02-02T00:00:00.000Z",
    updatedAt: now(),
  };
  await ops({ operation: "put", database: "flair", table: "Memory", records: [row] });
  expect((await memoryRow(id))?.content, "the competing write is not visible while the POST is paused").toBe(content);
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Arm `point`, start the POST, commit the competitor once paused, release, read. */
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

interface Observation { status: number; error: string | null; storedContent: string | null; ownWriteStored: boolean | null }

async function observe(response: Response, id: string, ownContent: string): Promise<Observation> {
  const text = await response.text();
  let error: string | null = null;
  try { error = JSON.parse(text)?.error ?? null; } catch { /* non-JSON answer */ }
  const stored = await memoryRow(id);
  return {
    status: response.status,
    error,
    storedContent: stored?.content ?? null,
    ownWriteStored: stored == null ? null : stored.content === ownContent,
  };
}

/** A refusal that names the lost write, with the competitor's row still stored. */
function refusedTruthfully(o: Observation): boolean {
  return o.status === 409 && o.error === "stored_row_changed" && o.ownWriteStored === false;
}

async function expectAllRefused(observations: Observation[], label: string): Promise<void> {
  const bad = observations.filter((o) => !refusedTruthfully(o));
  expect(bad, `${label}: every paused POST must refuse by name with its write absent; got ${JSON.stringify(bad)}`).toEqual([]);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2656p-pause-"));
  appDir = mkdtempSync(join(tmpdir(), "flair-2656p-app-"));
  await cp(join(process.cwd(), "test/fixtures/inproc-app"), appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules/@tpsdev-ai"), { recursive: true });
  await symlink(process.cwd(), join(appDir, "node_modules/@tpsdev-ai/flair"), "dir");
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd() });
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
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  if (appDir) rmSync(appDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

const RUNS = 10;

describe("flair#2656 — a Memory POST's caller-supplied target id", () => {
  it("collection POST with a body id: 10 interleavings", async () => {
    const observations: Observation[] = [];
    for (let i = 0; i < RUNS; i++) {
      const id = nextId("body");
      const own = `body-own-${i}`;
      const competitor = `body-competitor-${i}`;
      const { response, paused } = await withPaused(
        "memory-post-staged",
        () => call("POST", "/Memory", { id, agentId: A.id, content: own }),
        () => commitCompetingWrite(id, competitor),
      );
      expect(paused, "the collection POST was not paused after staging its write").toBe(true);
      observations.push(await observe(response, id, own));
    }
    console.log("POST body-id observations", JSON.stringify(observations));
    // The id was accepted as the row id (a caller-supplied id is not ignored).
    expect(observations.every((o) => o.status !== 400)).toBe(true);
    await expectAllRefused(observations, "collection POST with a body id");
  }, 600_000);

  it("addressed POST /Memory/<id>: 10 interleavings", async () => {
    const observations: Observation[] = [];
    for (let i = 0; i < RUNS; i++) {
      const id = nextId("url");
      const own = `url-own-${i}`;
      const competitor = `url-competitor-${i}`;
      const { response, paused } = await withPaused(
        "memory-post-staged",
        () => call("POST", memPath(id), { agentId: A.id, content: own }),
        () => commitCompetingWrite(id, competitor),
      );
      expect(paused, "the addressed POST was not paused after staging its write").toBe(true);
      observations.push(await observe(response, id, own));
    }
    console.log("POST url-id observations", JSON.stringify(observations));
    expect(observations.every((o) => o.status !== 400)).toBe(true);
    await expectAllRefused(observations, "addressed POST");
  }, 600_000);

  it("supersede-linked create with a body id: 10 interleavings", async () => {
    const observations: Observation[] = [];
    for (let i = 0; i < RUNS; i++) {
      const predecessor = nextId("sup-pred");
      const id = nextId("sup-new");
      const own = `sup-own-${i}`;
      const competitor = `sup-competitor-${i}`;
      await seedRow(predecessor, `predecessor-${i}`);
      const { response, paused } = await withPaused(
        "memory-post-staged",
        () => call("POST", "/Memory", { id, agentId: A.id, supersedes: predecessor, content: own }),
        () => commitCompetingWrite(id, competitor),
      );
      expect(paused, "the supersede create was not paused after staging its write").toBe(true);
      observations.push(await observe(response, id, own));
    }
    console.log("POST supersede observations", JSON.stringify(observations));
    expect(observations.every((o) => o.status !== 400)).toBe(true);
    await expectAllRefused(observations, "supersede create");
  }, 600_000);

  it("skill POST with a body id: 10 interleavings", async () => {
    const observations: Observation[] = [];
    for (let i = 0; i < RUNS; i++) {
      const id = nextId("skill");
      const own = `skill-own-${i}`;
      const competitor = `skill-competitor-${i}`;
      const { response, paused } = await withPaused(
        "memory-post-skill-staged",
        () => call("POST", "/Memory", { id, agentId: A.id, content: own, trigger: `when ${i}`, tags: ["skill"] }),
        () => commitCompetingWrite(id, competitor),
      );
      expect(paused, "the skill POST was not paused after staging its write").toBe(true);
      observations.push(await observe(response, id, own));
    }
    console.log("POST skill observations", JSON.stringify(observations));
    expect(observations.every((o) => o.status !== 400)).toBe(true);
    await expectAllRefused(observations, "skill POST");
  }, 600_000);

  it("a POST that no competitor touches stores its own row under the caller's id", async () => {
    const id = nextId("plain");
    const response = await call("POST", "/Memory", { id, agentId: A.id, content: "plain-own" });
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBeLessThan(300);
    expect(JSON.parse(text).id).toBe(id);
    const row = await memoryRow(id);
    expect(row?.id).toBe(id);
    expect(row?.content).toBe("plain-own");
  }, 120_000);

  it("a competitor that commits after the POST's commit makes even an otherwise successful POST refuse", async () => {
    for (const [label, body, point] of [
      ["ordinary", (id: string, own: string) => ({ id, agentId: A.id, content: own }), "memory-post-verify"],
      ["skill", (id: string, own: string) => ({ id, agentId: A.id, content: own, trigger: "when", tags: ["skill"] }), "memory-post-skill-verify"],
    ] as const) {
      const id = nextId(`postcommit-${label}`);
      const own = `postcommit-own-${label}`;
      const competitor = `postcommit-competitor-${label}`;
      const { response, paused } = await withPaused(
        point,
        () => callInProcess(body(id, own)),
        async () => {
          expect((await memoryRow(id))?.content, "the POST must have committed before the competitor writes").toBe(own);
          await commitCompetingWrite(id, competitor);
        },
      );
      expect(paused, `the ${label} POST was not paused after its commit, before its confirmation read`).toBe(true);
      const observation = await observe(response, id, own);
      expect(refusedTruthfully(observation), `${label}: ${JSON.stringify(observation)}`).toBe(true);
    }
  }, 300_000);
});
