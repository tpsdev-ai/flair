/**
 * embedding-readiness-null-3052.test.ts — a 2xx warm-up write is not readiness
 * when the backend stores no vector (flair#3052).
 *
 * The instance points the embedding backend at an absent model file, the repo's
 * existing fault knob for a null embedding: `getEmbedding()` fails, and a
 * Memory PUT still succeeds without storing a vector. The wait must read the
 * row back, refuse to report ready, and fail closed naming the reason.
 *
 * Throwaway HOME + data dir, ephemeral ports; every URL is asserted to be this
 * test's own instance. The absent model means no background writer can add a
 * vector to the rows this test reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithoutMigrationBoot, type ComposedComponent } from "../helpers/component-without-migration-boot";
import { createWarmAgent, warmInstanceEmbeddings } from "../../scripts/ci/embedding-readiness.mjs";

const ROOT = join(import.meta.dir, "..", "..");
const MODEL_FILE = "nomic-embed-text-absent.gguf";

let component: ComposedComponent;
let harper: HarperInstance;
let authHeader: string;
let homeDir = "";

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
  homeDir = mkdtempSync(join(tmpdir(), "flair-3052-null-backend-"));
  const absentPath = join(homeDir, "absent-model", MODEL_FILE);
  expect(existsSync(absentPath)).toBe(false);

  component = componentWithoutMigrationBoot({ sourceRoot: ROOT });
  harper = await startHarper({
    cwd: component.dir,
    harperBinDir: component.sourceRoot,
    serverEnv: { FLAIR_RECALL_HARNESS_MODEL_PATH: absentPath },
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
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  component?.cleanup();
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#3052 — a stored row without a vector is not ready", () => {
  it("a 2xx warm-up write stores no vector, and the wait fails closed naming it", async () => {
    const agentId = await createWarmAgent(harper.opsURL, authHeader);
    const id = `null-backend-${Date.now()}`;
    const direct = await fetch(`${harper.httpURL}/Memory/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        id,
        agentId,
        content: "a write the absent backend cannot embed",
        type: "memory",
        durability: "ephemeral",
        createdAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    expect(direct.status, await direct.clone().text()).toBeLessThan(300);

    const rows = await opsCall({
      operation: "search_by_id", database: "flair", table: "Memory",
      ids: [id], get_attributes: ["*"],
    });
    const row = Array.isArray(rows) ? rows.find((candidate: any) => candidate?.id === id) : undefined;
    expect(row, "the 2xx write did not store a row").toBeTruthy();
    expect(row.embedding ?? null, "the absent backend stored a vector").toBeNull();

    const error = await warmInstanceEmbeddings({
      baseUrl: harper.httpURL,
      opsUrl: harper.opsURL,
      authHeader,
      label: "null backend readiness",
      deadlineMs: 10_000,
      backoffMs: 100,
      maxAttempts: 5,
      log: () => {},
    }).then(() => null, (err: Error) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("never became ready");
    expect(error?.message).toContain("stored no vector");
  }, 60_000);
});
