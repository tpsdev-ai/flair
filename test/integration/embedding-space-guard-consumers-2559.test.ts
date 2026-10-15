/**
 * embedding-space-guard-consumers-2559.test.ts — flair#2559 (real Harper).
 *
 * The two consumers this change routes through the query-time embedding-space
 * guard, driven against a real Harper instance:
 *   - MemoryDedupStats returns its vector-derived counts only on a uniform
 *     verdict; on a mixed or unknown one it returns no counts and names the
 *     guard state.
 *   - MemoryBootstrap's task-relevant selection refuses its task embedding on a
 *     non-uniform verdict and surfaces the state-named warning SemanticSearch
 *     emits. (Gated on the embedding model, like the other bootstrap
 *     real-Harper tests — the consult only happens when a query embedding was
 *     generated.)
 *
 * The unknown verdict is held the way embedding-space-guard-unknown-2530 holds
 * it: the boot pre-warm's first scan parks at the test-only `space-guard-scan`
 * pause point, armed before Harper starts. Releasing it converges the (uniform)
 * store and reopens the gate; a signed PATCH that stores a foreign
 * `embeddingModel` stamp then trips the latch immediately (the #2425 path), for
 * the mixed verdict. No production port is used: all traffic is loopback to the
 * ephemeral instance this file started.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV } from "../../resources/txn-pause-point.ts";

const POINT = "space-guard-scan";
const AGENT = "agent-a";
const ROW = "row-a";
const FOREIGN = "other-engine:not-the-current-space"; // a genuinely different vector space

const MODEL_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";
function modelPresent(): boolean {
  const dirs = [process.env.FLAIR_MODELS_DIR, join(process.cwd(), "models")].filter(Boolean) as string[];
  return dirs.some((d) => existsSync(join(d as string, MODEL_FILE)));
}
const HAS_MODEL = modelPresent();
const gate = HAS_MODEL ? describe : describe.skip;

function basicAuthOf(h: HarperInstance): string {
  return "Basic " + btoa(`${h.admin.username}:${h.admin.password}`);
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Poll /Health until the guard reaches `state` (bounded). */
async function waitForGuardState(h: HarperInstance, state: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const res = await fetch(`${h.httpURL}/Health`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { embeddingSpace?: { state?: unknown } };
    last = body.embeddingSpace?.state;
    if (last === state) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

async function adminOp(h: HarperInstance, op: Record<string, unknown>): Promise<any> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuthOf(h) },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status, `${op.operation} returned ${res.status}`).toBe(200);
  return res.json();
}

async function dedupStats(h: HarperInstance): Promise<any> {
  const res = await fetch(`${h.httpURL}/MemoryDedupStats`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuthOf(h) },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  expect(res.status, `MemoryDedupStats → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

/** A signed PATCH that stores a foreign embedding stamp — the write-maintained
 *  latch path (#2425). */
async function patchForeignStamp(h: HarperInstance): Promise<void> {
  const res = await fetch(`${h.httpURL}/Memory/${ROW}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: basicAuthOf(h) },
    body: JSON.stringify({ embedding: [0, 1, 0, 0], embeddingModel: FOREIGN }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(res.status, `PATCH foreign stamp → ${res.status}: ${(await res.text()).slice(0, 200)}`).toBeLessThan(300);
}

describe("MemoryDedupStats consults the guard against a real Harper (flair#2559)", () => {
  let h: HarperInstance | undefined;
  let pauseDir = "";

  beforeAll(async () => {
    pauseDir = mkdtempSync(join(tmpdir(), "flair-2559-dedup-pause-"));
    writeFileSync(join(pauseDir, `arm.${POINT}`), ""); // armed before Harper starts
    const saved: Record<string, string | undefined> = {
      [TEST_FAULT_INJECTION_ENV]: process.env[TEST_FAULT_INJECTION_ENV],
      [TEST_PAUSE_DIR_ENV]: process.env[TEST_PAUSE_DIR_ENV],
    };
    process.env[TEST_FAULT_INJECTION_ENV] = "1";
    process.env[TEST_PAUSE_DIR_ENV] = pauseDir;
    try {
      h = await startHarper();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(h.external).toBe(false);
    expect(h.ownsInstallDir).toBe(true);
    // One plain row to PATCH later; it carries no embedding stamp, so it does
    // not affect the stamp scan (a missing stamp is ignored).
    await adminOp(h, {
      operation: "insert", database: "flair", table: "Memory", records: [
        { id: ROW, agentId: AGENT, content: "seeded row", durability: "standard", visibility: "shared", createdAt: new Date().toISOString() },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (pauseDir) writeFileSync(join(pauseDir, `go.${POINT}`), ""); // never leave a scan parked
    if (h) await stopHarper(h);
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  }, 60_000);

  test("unknown → uniform → mixed: counts only on uniform, state named otherwise", async () => {
    // The boot pre-warm's scan is parked ⇒ the guard verdict is unknown.
    expect(await waitFor(join(pauseDir, `paused.${POINT}`), 30_000), "no scan reached the boot pause").toBe(true);

    const unknown = await dedupStats(h!);
    expect(unknown.clusterCount).toBeNull();
    expect(unknown.largestClusterSize).toBeNull();
    expect(unknown.totalMemoriesInClusters).toBeNull();
    expect(unknown.embeddingSpace?.state).toBe("unverified");
    expect(unknown.embeddingSpace?.reason).toBeNull();

    // Release the scan: the (uniform) store reopens the gate.
    writeFileSync(join(pauseDir, `go.${POINT}`), "");
    expect(await waitForGuardState(h!, "uniform", 60_000)).toBe("uniform");

    const uniform = await dedupStats(h!);
    expect(typeof uniform.clusterCount).toBe("number");
    expect(uniform.embeddingSpace).toBeUndefined();

    // A foreign-stamp PATCH trips the latch: the sweep must not count across spaces.
    await patchForeignStamp(h!);
    const mixed = await dedupStats(h!);
    expect(mixed.clusterCount).toBeNull();
    expect(mixed.embeddingSpace).toEqual({ state: "mixed", reason: null });
  }, 120_000);
});

gate("MemoryBootstrap's task-relevant selection consults the guard against a real Harper (flair#2559)", () => {
  let h: HarperInstance | undefined;
  let pauseDir = "";

  interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
  const agent: TestAgent = (() => {
    const kp = nacl.sign.keyPair();
    return { id: AGENT, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
  })();

  function ed25519Header(method: string, path: string): string {
    const ts = Date.now().toString();
    const nonce = randomUUID();
    const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
    const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
    return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
  }

  async function bootstrap(): Promise<any> {
    const path = "/BootstrapMemories";
    const res = await fetch(`${h!.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header("POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT, currentTask: "federation replication direction" }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    expect(res.status, `BootstrapMemories → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    return JSON.parse(text);
  }

  beforeAll(async () => {
    pauseDir = mkdtempSync(join(tmpdir(), "flair-2559-boot-pause-"));
    writeFileSync(join(pauseDir, `arm.${POINT}`), "");
    const saved: Record<string, string | undefined> = {
      [TEST_FAULT_INJECTION_ENV]: process.env[TEST_FAULT_INJECTION_ENV],
      [TEST_PAUSE_DIR_ENV]: process.env[TEST_PAUSE_DIR_ENV],
    };
    process.env[TEST_FAULT_INJECTION_ENV] = "1";
    process.env[TEST_PAUSE_DIR_ENV] = pauseDir;
    try {
      h = await startHarper();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(h.external).toBe(false);
    expect(h.ownsInstallDir).toBe(true);
    await adminOp(h, {
      operation: "insert", database: "flair", table: "Agent", records: [
        { id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (pauseDir) writeFileSync(join(pauseDir, `go.${POINT}`), "");
    if (h) await stopHarper(h);
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  }, 60_000);

  test("unknown warning while the first scan is held, then no warning uniform, then the mixed warning", async () => {
    expect(await waitFor(join(pauseDir, `paused.${POINT}`), 30_000), "no scan reached the boot pause").toBe(true);

    const unknown = await bootstrap();
    expect(String(unknown._warning)).toContain("embedding space not yet verified");
    expect(String(unknown._warning)).not.toContain("non-current embedding model stamp was observed");

    writeFileSync(join(pauseDir, `go.${POINT}`), "");
    expect(await waitForGuardState(h!, "uniform", 60_000)).toBe("uniform");

    const uniform = await bootstrap();
    expect(uniform._warning).toBeUndefined();

    await adminOp(h!, {
      operation: "insert", database: "flair", table: "Memory", records: [
        { id: ROW, agentId: AGENT, content: "seeded row", durability: "standard", visibility: "shared", createdAt: new Date().toISOString() },
      ],
    });
    await patchForeignStamp(h!);
    const mixed = await bootstrap();
    expect(String(mixed._warning)).toContain("non-current embedding model stamp was observed");
    expect(String(mixed._warning)).toContain("results are keyword-only");
  }, 180_000);
});
