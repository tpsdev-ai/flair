/**
 * Hermetic flag-on Harper boot (flair#2300).
 *
 * test/unit/embeddings-flair-register.test.ts drives boot with a fake
 * globalThis.models and the Harper Models facade. test/integration-heavy/
 * embeddings-flair-load.test.ts loads the native engine in-process and does
 * not boot Harper. This file sets FLAIR_EMBEDDINGS_ENGINE=flair on a real
 * Harper process, writes Memory through the signed resource path, and reads
 * the stamp plus HealthDetail. A refused registration still stores the row
 * and serves it with no embedding stamp.
 */
import { chmod, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { BUILTIN_EMBEDDING_MODEL } from "../../resources/embeddings/models.ts";
import { flairSpaceKey } from "../../resources/embeddings/stamp-key.ts";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { tempDir } from "../helpers/temp-dir.ts";

const modelDir = process.env.FLAIR_MODELS_DIR ?? join(process.cwd(), "models");
const modelFile = join(modelDir, BUILTIN_EMBEDDING_MODEL.file);
const hasModel = existsSync(modelFile) && statSync(modelFile).size === BUILTIN_EMBEDDING_MODEL.bytes;
if (!hasModel) {
  console.warn(`[embeddings-flair-boot] SKIPPING stamp case: ${modelFile} is not the registry blob.`);
}

const FLAIR_STAMP = flairSpaceKey(BUILTIN_EMBEDDING_MODEL, "+searchprefix");

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

function basicAuth(harper: HarperInstance): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

async function adminOp(harper: HarperInstance, op: Record<string, unknown>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: basicAuth(harper),
    },
    body: JSON.stringify(op),
  });
}

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{
      id: agent.id,
      name: agent.id,
      role: "agent",
      publicKey: agent.publicKey,
      createdAt: new Date().toISOString(),
    }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}: ${await res.clone().text()}`).toBe(200);
}

async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, content: string): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: {
      Authorization: ed25519Header(agent, "PUT", path),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id,
      agentId: agent.id,
      content,
      durability: "standard",
      visibility: "private",
    }),
  });
}

async function getMemory(harper: HarperInstance, agent: TestAgent, id: string): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    headers: { Authorization: ed25519Header(agent, "GET", path) },
  });
}

async function searchMemory(harper: HarperInstance, agent: TestAgent): Promise<Response> {
  const path = `/Memory/?agentId=${encodeURIComponent(agent.id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    headers: { Authorization: ed25519Header(agent, "GET", path) },
  });
}

async function healthDetail(harper: HarperInstance): Promise<Record<string, unknown>> {
  const res = await fetch(`${harper.httpURL}/HealthDetail`, {
    headers: { Authorization: basicAuth(harper) },
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 500)).toBe(200);
  return JSON.parse(text) as Record<string, unknown>;
}

async function waitForLog(inst: HarperInstance, pattern: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let log = "";
  while (Date.now() < deadline) {
    log = inst.getLog?.() ?? "";
    if (pattern.test(log)) return log;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${pattern}. Log tail:\n${log.slice(-5000)}`);
}

const ENV_KEYS = [
  "FLAIR_EMBEDDINGS_ENGINE",
  "FLAIR_EMBED_GPU_LAYERS",
  "FLAIR_MODELS_DIR",
  "FLAIR_RECALL_HARNESS_FORCE_PREFIX",
] as const;

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("flair engine on a real Harper (flair#2300)", () => {
  let harper: HarperInstance | undefined;
  let saved: Map<string, string | undefined> | undefined;

  afterEach(async () => {
    if (harper) await stopHarper(harper);
    harper = undefined;
    if (saved) restoreEnv(saved);
    saved = undefined;
  });

  test("a refused registration stores the row with no embedding stamp", async () => {
    if (process.env.HARPER_HTTP_URL) {
      throw new Error("this test boots its own Harper; HARPER_HTTP_URL would attach to someone else's server");
    }
    const openDir = tempDir("flair-boot-open-");
    await mkdir(openDir, { recursive: true });
    await chmod(openDir, 0o777);
    saved = snapshotEnv();
    process.env.FLAIR_EMBEDDINGS_ENGINE = "flair";
    process.env.FLAIR_EMBED_GPU_LAYERS = "0";
    process.env.FLAIR_MODELS_DIR = openDir;
    delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
    harper = await startHarper();
    await waitForLog(harper, /backend registration skipped:[\s\S]*group or other writable/, 60_000);

    const agent = mkAgent(`flair-boot-kw-${randomUUID()}`);
    await registerAgent(harper, agent);
    const id = `${agent.id}-row`;
    const content = "Keyword-only memory written after flair registration was refused.";
    const put = await putMemory(harper, agent, id, content);
    expect(put.status, await put.clone().text()).toBe(200);

    const got = await getMemory(harper, agent, id);
    expect(got.status, await got.clone().text()).toBe(200);
    const row = await got.json() as Record<string, unknown>;
    expect(row.content).toBe(content);
    expect(row.embeddingModel ?? null).toBeNull();
    expect(row.embedding ?? null).toBeNull();

    const listed = await searchMemory(harper, agent);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const body = await listed.text();
    expect(body).toContain(id);
    expect(body).not.toContain(FLAIR_STAMP);

    const detail = await healthDetail(harper);
    const embedding = detail.embedding as { degrade?: string } | undefined;
    expect(embedding?.degrade).toContain("could not be verified or fetched");
    expect(embedding?.degrade).toContain("group or other writable");
    expect(embedding?.degrade).not.toContain("embeddings did not start");
    expect(embedding?.degrade).not.toContain("did not load");
    const warnings = detail.warnings as Array<{ message?: string }> | undefined;
    expect(warnings?.some((item) => item.message === embedding?.degrade)).toBe(true);
  }, 180_000);

  (hasModel ? test : test.skip)("a successfully embedded write carries the flair stamp and HealthDetail provenance", async () => {
    if (process.env.HARPER_HTTP_URL) {
      throw new Error("this test boots its own Harper; HARPER_HTTP_URL would attach to someone else's server");
    }
    saved = snapshotEnv();
    process.env.FLAIR_EMBEDDINGS_ENGINE = "flair";
    process.env.FLAIR_EMBED_GPU_LAYERS = "0";
    process.env.FLAIR_MODELS_DIR = modelDir;
    delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
    harper = await startHarper();
    await waitForLog(harper, /\[embeddings\] embedding:/, 180_000);

    const agent = mkAgent(`flair-boot-ok-${randomUUID()}`);
    await registerAgent(harper, agent);
    const id = `${agent.id}-row`;
    const content = "Successfully embedded memory written through the signed Memory resource.";
    const put = await putMemory(harper, agent, id, content);
    expect(put.status, await put.clone().text()).toBe(200);

    const got = await getMemory(harper, agent, id);
    expect(got.status, await got.clone().text()).toBe(200);
    const row = await got.json() as Record<string, unknown>;
    expect(row.content).toBe(content);
    expect(row.embeddingModel).toBe(FLAIR_STAMP);
    expect(Array.isArray(row.embedding)).toBe(true);
    expect((row.embedding as unknown[]).length).toBe(768);

    const listed = await searchMemory(harper, agent);
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain(FLAIR_STAMP);

    const detail = await healthDetail(harper);
    const embedding = detail.embedding as { degrade?: string; provenance?: { prebuiltVersion?: string; prebuiltPackage?: string } };
    expect(embedding.degrade).toBeUndefined();
    expect(embedding.provenance?.prebuiltVersion).toBe("3.18.1");
    expect(embedding.provenance?.prebuiltPackage).toContain("@node-llama-cpp/");
  }, 300_000);
});
