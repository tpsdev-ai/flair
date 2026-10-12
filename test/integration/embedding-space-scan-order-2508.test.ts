/**
 * embedding-space-scan-order-2508.test.ts — flair#2508 (real Harper).
 *
 * Same ordering scenario as the unit-isolated test, but the guard's scan reads
 * the REAL Memory store of a live Harper instance through its operations API:
 * the older scan reads a uniform corpus and parks at the verdict pause; a
 * foreign-stamp row is then inserted into that instance; a newer scan reads the
 * now-mixed corpus and publishes `false`; the older scan is released and must
 * refuse its `true` verdict by name.
 *
 * Why the table getter is injected: the guard's latch is per-process module
 * state, so its scan runs in THIS process and cannot be reached through the
 * spawned Harper. The seam exercised here is the scan's read of the real store
 * (`SELECT embeddingModel FROM flair.Memory` through the real ops API); the
 * getter is a thin adapter, the rows are the instance's own.
 *
 * Mutation check (fails-on-unfixed): remove the scan-order check in
 * resources/embedding-space-guard.ts scan() and the older scan overwrites the
 * newer verdict, so "final verdict false" goes red.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV } from "../../resources/txn-pause-point.ts";

const CURRENT = "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix";
const FOREIGN = "other-engine:not-the-current-space";
const POINT = "scan-verdict";

let harper: HarperInstance;
let basic: string;
let savedFault: string | undefined;
let savedPauseDir: string | undefined;
let dir: string;

const {
  isEmbeddingSpaceUniform,
  recomputeLatch,
  _setGuardTableGetterForTests,
  _setGuardModelIdForTests,
  _resetGuardForTests,
} = await import("../../resources/embedding-space-guard.ts");

/** Refuse to talk to anything but this test's own ephemeral instance: loopback,
 *  the OS-assigned ports it was started on, never a production port. */
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const [label, u, port] of [["http", http, Number(http.port)], ["ops", ops, Number(ops.port)]] as const) {
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
}

async function adminOp(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic },
    body: JSON.stringify(op),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return JSON.parse(text);
}

/** The guard's scan reads `{ embeddingModel }` rows; serve them from the live
 *  instance over the real ops API. */
function realStoreGetter() {
  return async () => ({
    search(_q: unknown) {
      async function* gen() {
        const rows = await adminOp({ operation: "sql", sql: "SELECT embeddingModel FROM flair.Memory" });
        for (const row of Array.isArray(rows) ? rows : (rows?.results ?? [])) {
          yield { embeddingModel: (row as any).embeddingModel ?? null };
        }
      }
      return gen();
    },
  });
}

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${path}`);
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  basic = "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
  const now = new Date().toISOString();
  await adminOp({
    operation: "insert", database: "flair", table: "Memory", records: [
      { id: "m-current-1", agentId: "scan-order-agent", content: "current-space row", visibility: "shared", embeddingModel: CURRENT, createdAt: now, updatedAt: now },
    ],
  });
}, 180_000);

afterAll(async () => {
  if (harper) {
    const { rm } = await import("node:fs/promises");
    const installDir = harper.installDir;
    await stopHarper(harper);
    await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  }
}, 30_000);

describe("embedding-space-guard scan ordering against a live instance (flair#2508, real Harper)", () => {
  test("an older scan finishing after a newer one refuses its verdict by name", async () => {
    dir = mkdtempSync(join(tmpdir(), "flair-2508-"));
    savedFault = process.env[TEST_FAULT_INJECTION_ENV];
    savedPauseDir = process.env[TEST_PAUSE_DIR_ENV];
    process.env[TEST_FAULT_INJECTION_ENV] = "1";
    process.env[TEST_PAUSE_DIR_ENV] = dir;
    try {
      _resetGuardForTests();
      _setGuardModelIdForTests(() => CURRENT);
      // Drain the module-scope pre-warm with the default getter before arming.
      await new Promise((r) => setTimeout(r, 50));
      _resetGuardForTests();
      _setGuardModelIdForTests(() => CURRENT);
      _setGuardTableGetterForTests(realStoreGetter());

      // The OLDER scan reads the uniform corpus, then parks at the verdict pause.
      writeFileSync(join(dir, `arm.${POINT}`), "");
      const older = recomputeLatch();
      await waitFor(join(dir, `paused.${POINT}`), 15_000);

      // A foreign-stamp row lands in the instance; a NEWER scan publishes false.
      const now = new Date().toISOString();
      await adminOp({
        operation: "insert", database: "flair", table: "Memory", records: [
          { id: "m-foreign-1", agentId: "scan-order-agent", content: "foreign-space row", visibility: "shared", embeddingModel: FOREIGN, createdAt: now, updatedAt: now },
        ],
      });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const newer = recomputeLatch();
        expect(await newer).toBe(false);

        // Release the OLDER scan: it must not overwrite the newer verdict.
        writeFileSync(join(dir, `go.${POINT}`), "");
        expect(await older).toBe(false);
        expect(await isEmbeddingSpaceUniform()).toBe(false);
        expect(
          warn.mock.calls.map((call) => call.join(" ")).some((line) => line.includes("stale scan verdict refused")),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    } finally {
      for (const [key, saved] of [[TEST_FAULT_INJECTION_ENV, savedFault], [TEST_PAUSE_DIR_ENV, savedPauseDir]] as const) {
        if (saved === undefined) delete process.env[key];
        else process.env[key] = saved;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
