/**
 * reindex-guard-stamp-2932.test.ts — real Harper.
 *
 * The admin `_reindex` re-PUT owns its transaction and reads the row back after
 * that transaction returns (flair#2656). A read-back refusal must not suppress
 * the embedding-space guard's notification: the guard has to learn the
 * ATTEMPTED stamp before that read, as the ordinary PUT path does, and the
 * read-back determines whether the stamp remains stored. Otherwise a reindex
 * that attempts a foreign embedding stamp and whose read-back is refused leaves
 * the latch reading `uniform` until some later scan (the uniform fast path does
 * not rescan on a timer).
 *
 * Each case starts its own ephemeral Harper; the latch starts unverified, and
 * the case waits for the boot scan to publish `uniform`. The
 * `fail.memory-reindex-verify` fault point makes the post-commit read throw.
 */
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const FOREIGN = "other-engine:not-the-current-space"; // a genuinely different vector space
const AGENT = "agent-a";

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

async function ops(h: HarperInstance, operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`) },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function readRow(h: HarperInstance, id: string): Promise<any> {
  const rows = await ops(h, { operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function guardState(h: HarperInstance): Promise<unknown> {
  const res = await fetch(`${h.httpURL}/Health`, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json()) as { embeddingSpace?: { state?: unknown } };
  return body.embeddingSpace?.state;
}

/** Poll /Health until the guard reaches `state`, bounded. Returns the last state. */
async function waitForGuardState(h: HarperInstance, state: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await guardState(h);
    if (last === state) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

async function withInstances<T>(fn: (h: HarperInstance, pauseDir: string) => Promise<T>): Promise<T> {
  const pauseDir = mkdtempSync(join(tmpdir(), "flair-2932-pause-"));
  let h: HarperInstance | undefined;
  try {
    h = await startHarper({ serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir } });
    expect(h.external).toBe(false);
    expect(h.ownsInstallDir).toBe(true);
    return await fn(h, pauseDir);
  } finally {
    if (h) await stopHarper(h).catch(() => {});
    rmSync(pauseDir, { recursive: true, force: true });
  }
}

/** Seed one persistent Memory row, and an admin Agent to sign the re-PUT. */
async function seed(h: HarperInstance, id: string): Promise<TestAgent> {
  const admin = mkAgent("agent-admin");
  await ops(h, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: admin.id, name: admin.id, role: "admin", publicKey: admin.publicKey, createdAt: new Date().toISOString() }],
  });
  await ops(h, {
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id, agentId: AGENT, content: `reindex ${id}`, contentHash: id, instanceToken: randomUUID(),
      durability: "persistent", visibility: "shared", archived: false,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }],
  });
  return admin;
}

/** One admin `_reindex` re-PUT committing the foreign embedding stamp. */
function reindexPut(h: HarperInstance, admin: TestAgent, id: string): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${h.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(admin, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, _reindex: true, embedding: [0, 1, 0, 0], embeddingModel: FOREIGN }),
    signal: AbortSignal.timeout(60_000),
  });
}

describe("flair#2932 — the _reindex guard notification precedes the read-back (real Harper)", () => {
  it("a refused read-back still leaves the guard told of the committed foreign stamp", async () => {
    await withInstances(async (h, pauseDir) => {
      const id = `rgs-fault-${Date.now()}`;
      const admin = await seed(h, id);
      expect(await waitForGuardState(h, "uniform", 60_000), "the boot scan did not publish a uniform verdict").toBe("uniform");
      const fault = join(pauseDir, "fail.memory-reindex-verify");
      writeFileSync(fault, "");
      let response: Response;
      try {
        response = await reindexPut(h, admin, id);
      } finally {
        rmSync(fault, { force: true });
      }
      const text = await response.clone().text();
      expect(response.status, text.slice(0, 200)).toBe(503);
      expect(JSON.parse(text).error).toBe("write_outcome_unknown");
      expect((await readRow(h, id))?.embeddingModel, "the refused read-back hid that the re-PUT stored the foreign stamp").toBe(FOREIGN);
      expect(await waitForGuardState(h, "mixed", 10_000), "the guard did not learn the attempted foreign stamp").toBe("mixed");
    });
  }, 240_000);

  it("CONTROL: without the fault the same re-PUT answers success and the guard reads mixed", async () => {
    await withInstances(async (h) => {
      const id = `rgs-ok-${Date.now()}`;
      const admin = await seed(h, id);
      expect(await waitForGuardState(h, "uniform", 60_000), "the boot scan did not publish a uniform verdict").toBe("uniform");
      const response = await reindexPut(h, admin, id);
      expect(response.status, (await response.clone().text()).slice(0, 200)).toBeLessThan(300);
      expect((await readRow(h, id))?.embeddingModel, "the re-PUT did not commit the foreign stamp").toBe(FOREIGN);
      expect(await waitForGuardState(h, "mixed", 10_000), "the guard did not learn the committed foreign stamp").toBe("mixed");
    });
  }, 240_000);
});
