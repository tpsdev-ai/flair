/**
 * writer-audit-step3-2645.test.ts — real-Harper interleavings for two writers
 * #2645 had not exercised: the InstructionVersion append and the MemoryReflect
 * source stamp.
 *
 * Each case holds the writer at a test-only pause point, commits a competing
 * row through the lock-bypassing operations API, releases the writer, and
 * reads the committed state back. The source-stamp case also reads the attempt
 * log the write-back helper appends with fault injection armed and a pause
 * directory configured, so the retry is asserted from the attempt log.
 *
 * Before this test's own HTTP requests, the shared guard checks a live spawned
 * process, an owned temporary install directory, and distinct 127.0.0.1 ports
 * outside the denylist. startHarper probes readiness before that check.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { assertOwnInstance } from "../helpers/own-harper-instance";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const SEED = mkAgent(`wa3-seed-${sfx}`);
const REFLECT = mkAgent(`wa3-reflect-${sfx}`);
const now = () => new Date().toISOString();

let harper: HarperInstance;
let pauseDir = "";
let stubDir = "";
let seq = 0;
const nextId = (label: string) => `wa3-${label}-${sfx}-${++seq}`;

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

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

async function basicCall(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(harper.httpURL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

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

async function rowById(table: string, id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table, ids: [id], get_attributes: ["*"] });
  return (rows as any[])[0] ?? null;
}

async function seedMemory(id: string, content: string): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id, agentId: REFLECT.id, content, contentHash: id, visibility: "shared", archived: false,
      durability: "standard", type: "session", instanceToken: randomUUID(),
      createdAt: now(), embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(),
    }],
  });
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return true;
    } catch {
      // Not written yet.
    }
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

/** As above, but the writer does not await the pause: wait for its release marker. */
async function withPausedBackground(point: string, trigger: () => Promise<Response>, compete: () => Promise<void>) {
  const result = await withPaused(point, trigger, compete);
  let released = result.released;
  for (const until = Date.now() + 5_000; !released && Date.now() < until;) {
    await new Promise((r) => setTimeout(r, 25));
    try { released = readFileSync(join(pauseDir, `released.${point}`), "utf8"); } catch { released = ""; }
  }
  return { ...result, released };
}

/** Wait for attempt 2's settled skip, then return the recorded attempt starts. */
async function attemptsFor(id: string, ms: number): Promise<number[]> {
  const path = join(pauseDir, "attempts.write-back");
  const deadline = Date.now() + ms;
  let mine: number[] = [];
  while (Date.now() < deadline) {
    try {
      const records = readFileSync(path, "utf8").split("\n").filter(Boolean)
        .map((line) => line.split("\t"))
        .filter((fields) => fields[1] === id);
      mine = records.filter((fields) => fields[3] === undefined).map((fields) => Number(fields[2]));
      if (records.some((fields) => fields[2] === "2" && fields[3] === "skipped")) return mine;
    } catch {
      mine = [];
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for write-back attempt 2's terminal skipped outcome for ${id}; starts: ${mine}`);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2645d-pause-"));
  stubDir = mkdtempSync(join(tmpdir(), "flair-2645d-stub-"));
  writeFileSync(join(stubDir, "generate-response.json"), JSON.stringify({ candidates: [] }));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper({
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
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [
      { id: SEED.id, name: SEED.id, role: "agent", publicKey: SEED.publicKey, createdAt: now() },
      { id: REFLECT.id, name: REFLECT.id, role: "agent", publicKey: REFLECT.publicKey, createdAt: now() },
    ],
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2645 — InstructionVersion append after its id is computed", () => {
  it("a row inserted at the computed id while the append is paused is not overwritten", async () => {
    const agentId = SEED.id;
    const key = nextId("iv-key");
    const soulId = `${agentId}:${key}`;
    const subjectId = `${agentId}:${key}`;
    const versionRowId = `soul:${subjectId}:1`;
    const { response, paused, released } = await withPaused(
      "instruction-version-append",
      () => basicCall("POST", "/Soul/", { id: soulId, agentId, key, value: "writer value" }),
      async () => {
        await ops({
          operation: "insert", database: "flair", table: "InstructionVersion",
          records: [{
            id: versionRowId, subjectType: "soul", subjectId, agentId, key,
            version: 1, kind: "create", rowId: soulId, valueHash: null,
            previousVersionHash: null, recordHash: "competitor-hash", soulSnapshot: null,
            memoryId: null, visibility: null, actorKind: "internal", actorId: "audit-competitor",
            sourceClass: "internal", createdAt: now(), guarded: false, expectedVersion: null,
          }],
        });
        expect((await rowById("InstructionVersion", versionRowId))?.actorId).toBe("audit-competitor");
      },
    );
    expect(paused, "the append was not paused after computing its id").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    // SAFE: the colliding append fails the transaction and rolls the Soul write back.
    expect(response.status, text.slice(0, 300)).toBe(500);
    expect(JSON.parse(text).error, text.slice(0, 300)).toBe("instruction_version_append_failed");
    const version = await rowById("InstructionVersion", versionRowId);
    expect(version?.actorId, "the append overwrote the row at its computed id").toBe("audit-competitor");
    expect(version?.recordHash, "the append overwrote the row at its computed id").toBe("competitor-hash");
    expect(await rowById("Soul", soulId), "the failed append left its Soul write committed").toBeNull();
  }, 120_000);
});

describe("flair#2645 — MemoryReflect source stamp retry", () => {
  it("a source changed in a gathered field makes the retry skip the stamp", async () => {
    const id = nextId("reflect");
    await seedMemory(id, "reflect v1");
    const NEWER = `reflect v2-committed-by-the-competitor-${id}`;
    const { response, paused, released } = await withPausedBackground(
      "reflect-sources",
      () => call(REFLECT, "POST", "/ReflectMemories", { agentId: REFLECT.id, execute: true }),
      async () => {
        const current = await rowById("Memory", id);
        expect(current).not.toBeNull();
        await ops({
          operation: "put", database: "flair", table: "Memory",
          records: [{ ...current, content: NEWER, updatedAt: now() }],
        });
        expect((await rowById("Memory", id))?.content).toBe(NEWER);
      },
    );
    expect(paused, "the source stamp was not paused between its read and its write").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(200);
    // Wait for attempt 2's terminal skipped outcome before reading the row.
    const attempts = await attemptsFor(id, 10_000);
    expect(attempts, "the stamp did not run a second attempt").toEqual([1, 2]);
    const row = await rowById("Memory", id);
    expect(row?.content, "the newer committed write was overwritten by the stamp").toBe(NEWER);
    expect(row?.lastReflected, "the retry stamped a source whose gathered content changed").toBeUndefined();
  }, 120_000);
});
