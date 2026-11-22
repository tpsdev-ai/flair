/**
 * embedding-readiness-3052.test.ts — the readiness wait retries the REAL
 * `503 memory_provider_timeout` from a real Harper (flair#3052).
 *
 * The unit cases drive a real `memoryProviderTimeoutResponse()`, but a fake
 * `fetch` still stands in for the server. This file closes that seam: a
 * component copy overrides `getEmbedding` so the first two provider calls
 * never settle, the real per-id write lock answers each write with its own
 * `503 memory_provider_timeout` after the fault-injection bound, and the third
 * call returns a vector. The wait must retry the real 503 once and then report
 * the real success.
 *
 * Throwaway HOME + data dir, ephemeral ports; every URL is asserted to be this
 * test's own instance.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { warmInstanceEmbeddings } from "../../scripts/ci/embedding-readiness.mjs";
import { MEMORY_PROVIDER_TIMEOUT_ERROR } from "../../resources/memory-write-lock.ts";

// The first two provider calls hang; the third answers. The lock's
// fault-injection bound turns the first two writes into the real 503.
const PROVIDER_OVERRIDE = `
let __readinessProviderCalls = 0;
getEmbedding = async () => {
  __readinessProviderCalls += 1;
  if (__readinessProviderCalls <= 2) return new Promise(() => {});
  return [0.1, 0.2, 0.3];
};
`;

let component: string;
let harper: HarperInstance;
let authHeader: string;
const owner = { id: "ready-3052-owner", ...nacl.sign.keyPair() };

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  component = mkdtempSync(join(tmpdir(), "flair-3052-readiness-component-"));
  for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
    cpSync(join(process.cwd(), entry), join(component, entry), { recursive: true });
  }
  symlinkSync(join(process.cwd(), "node_modules"), join(component, "node_modules"), "dir");
  appendFileSync(join(component, "dist/resources/embeddings-provider.js"), `\n${PROVIDER_OVERRIDE}\n`);

  harper = await startHarper({
    cwd: component,
    serverEnv: {
      FLAIR_ENABLE_TEST_FAULT_INJECTION: "1",
      FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS: "50",
    },
  });
  authHeader = `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64")}`;

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
      id: owner.id,
      name: owner.id,
      role: "agent",
      publicKey: Buffer.from(owner.publicKey).toString("base64"),
      createdAt: new Date().toISOString(),
    }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (component) rmSync(component, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#3052 — the wait retries the real provider-timeout response", () => {
  it("a real write answers 503 memory_provider_timeout, then the wait retries and succeeds", async () => {
    const id = `ready-direct-${Date.now()}`;
    const direct = await fetch(`${harper.httpURL}/Memory/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        id,
        agentId: owner.id,
        content: "a direct write while the provider call is pending",
        type: "memory",
        durability: "standard",
        createdAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await direct.json() as any;
    expect(direct.status, JSON.stringify(body)).toBe(503);
    expect(body.error, "the server answered a different refusal").toBe(MEMORY_PROVIDER_TIMEOUT_ERROR);

    const result = await warmInstanceEmbeddings({
      baseUrl: harper.httpURL,
      opsUrl: harper.opsURL,
      authHeader,
      label: "integration readiness",
      deadlineMs: 5_000,
      backoffMs: 100,
      log: () => {},
    });

    // Call 2 (the wait's first write) times out; call 3 returns a vector.
    expect(result.attempts).toBe(2);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
