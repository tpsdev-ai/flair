/**
 * reembed-preserves-fields-2296.test.ts — `flair reembed` against a real
 * ephemeral Harper (flair#2296).
 *
 * Each CLI path (all agents, one agent) re-embeds rows seeded with a value for
 * every Memory attribute. Afterwards the stored row may differ only in
 * `embedding`, `embeddingModel` and `updatedAt`, and the new vector must match
 * the server's embedding of the row's text (`trigger` for a skill row).
 *
 * The fixtures carry the bare current-space stamp, which the boot migration
 * treats as current, so its delayed follow-up cycles leave them alone.
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { MEMORY_ATTRIBUTES } from "../../src/lib/memory-attributes.ts";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
const CURRENT_MODEL_ID = getModelId();
const BARE_MODEL_ID = stripEnginePrefix(CURRENT_MODEL_ID);
const ALLOWED_TO_CHANGE = new Set(["embedding", "embeddingModel", "updatedAt"]);
const FIXTURE_VECTOR = Array.from({ length: 768 }, (_, i) => ((i % 7) + 1) / 1000);

type Agent = { id: string; publicKey: Uint8Array; secretKey: Uint8Array };
const newAgent = (id: string): Agent => ({ id, ...nacl.sign.keyPair() });
const agentA = newAgent("reembed-agent-a");
const agentB = newAgent("reembed-agent-b");
const agentC = newAgent("reembed-agent-c");
// Has a key file but no Agent row, so its signed requests are refused.
const unregistered = newAgent("reembed-agent-d");

let harper: HarperInstance;
let home: string;

const adminAuth = () =>
  "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

async function op(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

const read = async (id: string) =>
  (await op({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] }))[0];

/** A write can answer before an ops read sees its commit; poll the same read (bounded). */
async function readUntil(id: string, pred: (row: any) => boolean): Promise<any> {
  const deadline = Date.now() + 10_000;
  let row = await read(id);
  while (!pred(row) && Date.now() < deadline) {
    await Bun.sleep(50);
    row = await read(id);
  }
  return row;
}

async function signedRequest(who: Agent, method: string, path: string, body?: unknown): Promise<Response> {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const signature = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return fetch(harper.httpURL + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(signature).toString("base64")}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

/** A row carrying a non-default value for every Memory attribute. */
function fixtureRow(id: string, agentId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const day = (d: number) => `2001-01-0${d}T00:00:00.000Z`;
  return {
    id,
    agentId,
    content: `Release checklist ${id}: verify the tarball checksum before tagging.`,
    contentHash: `hash-${id}`,
    trigger: "trigger fixture",
    visibility: "private",
    embedding: FIXTURE_VECTOR,
    embeddingModel: BARE_MODEL_ID,
    tags: ["release", "fixture"],
    durability: "persistent",
    source: "source-fixture",
    type: "type-fixture",
    createdAt: day(1),
    updatedAt: day(2),
    instanceToken: `token-${id}`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    retrievalCount: 7,
    lastRetrieved: day(3),
    usageCount: 3,
    promotionStatus: "approved",
    promotedAt: day(4),
    promotedBy: "reviewer-fixture",
    archived: true,
    archivedAt: day(5),
    archivedBy: agentId,
    parentId: "parent-fixture",
    derivedFrom: ["source-1", "source-2"],
    sessionId: "session-fixture",
    lastReflected: day(6),
    supersedes: "older-fixture",
    subject: `subject-${id}`,
    summary: "summary fixture",
    validFrom: day(1),
    validTo: "2098-01-01T00:00:00.000Z",
    _safetyFlags: ["flag-fixture"],
    provenance: JSON.stringify({ v: 1, verified: { agentId, timestamp: day(1), receivedAt: day(1) } }),
    originatorInstanceId: "instance-fixture",
    metadata: JSON.stringify({ name: `skill-${id}` }),
    entities: ["subsystem:release"],
    skillSubjectId: `subject-of-${id}`,
    meta: { seq: 1, processUUID: "process-fixture", sessionId: "session-fixture", hook: "hook-fixture" },
    kind: "kind-fixture",
    _originatorInstanceId: "receiver-origin-fixture",
    _syncedFrom: "peer-fixture",
    _syncedAt: day(7),
    ...overrides,
  };
}

function skillFixtureRow(id: string, agentId: string): Record<string, unknown> {
  return fixtureRow(id, agentId, {
    tags: ["skill", "release"],
    trigger: `when cutting a release for ${id}`,
    skillSubjectId: id,
    archived: false,
    archivedAt: null,
    archivedBy: null,
    validTo: null,
  });
}

async function seedRows(rows: Record<string, unknown>[]): Promise<Map<string, any>> {
  await op({ operation: "insert", database: "flair", table: "Memory", records: rows });
  const before = new Map<string, any>();
  for (const row of rows) {
    const stored = await read(String(row.id));
    for (const [key, value] of Object.entries(row)) expect({ [key]: stored?.[key] }).toEqual({ [key]: value });
    before.set(String(row.id), stored);
  }
  return before;
}

function runReembed(args: string[]): { code: number | null; out: string } {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const r = spawnSync(process.execPath, [CLI, "reembed", "--port", new URL(harper.httpURL).port, ...args], {
    encoding: "utf-8",
    env: {
      ...env,
      HOME: home,
      FLAIR_OPS_PORT: new URL(harper.opsURL).port,
      FLAIR_ADMIN_USER: harper.admin.username,
      FLAIR_ADMIN_PASS: harper.admin.password,
    },
    timeout: 90_000, // flair#1807: the CLI child's own deadline
    killSignal: "SIGTERM",
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.signal ? `\n[killed by ${r.signal}]` : ""}` };
}

/** The server's own embedding of `text`, via an ordinary admin PUT of a probe row. */
async function serverEmbedding(text: string): Promise<number[]> {
  const id = `probe-${randomUUID()}`;
  const res = await fetch(`${harper.httpURL}/Memory/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({ id, agentId: "probe-agent", content: text }),
    signal: AbortSignal.timeout(60_000),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const row = await readUntil(id, (r) => Array.isArray(r?.embedding));
  expect(Array.isArray(row?.embedding)).toBe(true);
  return row.embedding;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

async function expectOnlyEmbeddingChanged(before: any): Promise<void> {
  const after = await readUntil(before.id, (row) => row?.embeddingModel === CURRENT_MODEL_ID);
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after ?? {})])) {
    if (ALLOWED_TO_CHANGE.has(key) || Bun.deepEquals(after?.[key], before[key], true)) continue;
    changed[key] = { before: before[key], after: after?.[key] };
  }
  expect(changed).toEqual({});
  expect(after.embeddingModel).toBe(CURRENT_MODEL_ID);
  expect(after.updatedAt > before.updatedAt).toBe(true);
  expect(after.embedding).not.toEqual(before.embedding);
  const tagged = Array.isArray(before.tags) && before.tags.includes("skill");
  const expected = await serverEmbedding(tagged ? before.trigger : before.content);
  expect(after.embedding).toHaveLength(expected.length);
  expect(cosine(after.embedding, expected)).toBeGreaterThan(0.999);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  expect(BARE_MODEL_ID).not.toBe(CURRENT_MODEL_ID);
  ensureCliBuild();
  home = mkdtempSync(join(tmpdir(), "flair-2296-home-"));
  harper = await startHarper();
  // Every request in this file goes to the ephemeral instance this test started.
  for (const url of [new URL(harper.httpURL), new URL(harper.opsURL)]) {
    expect(url.hostname).toBe("127.0.0.1");
    expect(["9925", "9926"]).not.toContain(url.port);
  }
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  for (const agent of [agentA, agentB, agentC, unregistered]) {
    writeFileSync(join(keysDir, `${agent.id}.key`), agent.secretKey.slice(0, 32), { mode: 0o600 });
  }
  const now = new Date().toISOString();
  await op({
    operation: "upsert",
    database: "flair",
    table: "Agent",
    records: [agentA, agentB, agentC].map((a) => ({
      id: a.id, name: a.id, role: "agent", publicKey: Buffer.from(a.publicKey).toString("base64"), createdAt: now,
    })),
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("flair#2296: flair reembed", () => {
  test("the fixture covers every Memory attribute", () => {
    expect(Object.keys(fixtureRow("x", "y")).sort()).toEqual([...MEMORY_ATTRIBUTES].sort());
  });

  test("all-agents path; --dry-run writes nothing; a refused row is counted as an error", async () => {
    const before = await seedRows([fixtureRow("all-a", agentA.id), fixtureRow("all-b", agentB.id)]);
    const refused = await seedRows([fixtureRow("all-d", unregistered.id)]);

    const dry = runReembed(["--dry-run"]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain(`Agent 1/3: ${agentA.id}`);
    for (const row of [...before.values(), ...refused.values()]) expect(await read(row.id)).toEqual(row);

    const r = runReembed(["--batch-size", "1", "--delay-ms", "0"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`✅ Agent ${agentA.id}: 1 updated, 0 errors`);
    expect(r.out).toContain(`✅ Agent ${agentB.id}: 1 updated, 0 errors`);
    expect(r.out).toContain(`✅ Agent ${unregistered.id}: 0 updated, 1 errors`);
    expect(r.out).toContain("Re-embedding complete: 2 updated, 1 errors");
    for (const row of before.values()) await expectOnlyEmbeddingChanged(row);
    for (const row of refused.values()) expect(await read(row.id)).toEqual(row);
  }, 240_000);

  test("single-agent path, including a skill row; --dry-run writes nothing", async () => {
    const before = await seedRows([fixtureRow("one-c", agentC.id), skillFixtureRow("one-c-skill", agentC.id)]);
    const dry = runReembed(["--agent", agentC.id, "--dry-run"]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain("Candidates for re-embedding: 2");
    for (const row of before.values()) expect(await read(row.id)).toEqual(row);

    const r = runReembed(["--agent", agentC.id, "--batch-size", "1", "--delay-ms", "0"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Re-embedding complete: 2 updated, 0 errors");
    for (const row of before.values()) await expectOnlyEmbeddingChanged(row);
  }, 240_000);

  test("a re-embed request from another agent or without credentials is refused and writes nothing", async () => {
    const before = await seedRows([fixtureRow("owned-a", agentA.id)]);
    const body = { embedding: null, embeddingModel: null };
    const other = await signedRequest(agentB, "PATCH", "/Memory/owned-a", body);
    expect(other.status, await other.clone().text()).toBe(403);
    const anonymous = await fetch(`${harper.httpURL}/Memory/owned-a`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    expect(anonymous.status, await anonymous.clone().text()).toBe(401);
    expect(await read("owned-a")).toEqual(before.get("owned-a"));
  }, 240_000);
});
