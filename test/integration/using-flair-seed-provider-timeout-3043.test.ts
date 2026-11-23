/**
 * using-flair-seed-provider-timeout-3043.test.ts — Hermetic end-to-end integration test
 * for the using-flair skill seed retry behavior against a REAL Harper instance
 * returning real 503 memory_provider_timeout refusals (flair#3043).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARPER_STOP_BUDGET_MS,
  startHarper,
  stopHarper,
  type HarperInstance,
} from "../helpers/harper-lifecycle";
import {
  currentSeed,
  runSkillSeed,
  SEED_SKILL_ID,
  skillSeedRestIo,
} from "../../src/lib/skill-seed.js";

describe("using-flair seed provider timeout retry against real Harper (flair#3043)", () => {
  const component = mkdtempSync(join(tmpdir(), "flair-3043-real-timeout-"));
  let instance: HarperInstance | undefined;

  beforeAll(async () => {
    for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
      cpSync(join(process.cwd(), entry), join(component, entry), { recursive: true });
    }
    symlinkSync(join(process.cwd(), "node_modules"), join(component, "node_modules"), "dir");

    // Patch embedding provider in the ephemeral instance so embedding calls hang and trigger Harper's lock timeout
    appendFileSync(
      join(component, "dist/resources/embeddings-provider.js"),
      "\ngetEmbedding = async () => new Promise(() => {});\n",
    );

    instance = await startHarper({
      cwd: component,
      serverEnv: {
        FLAIR_ENABLE_TEST_FAULT_INJECTION: "1",
        FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS: "50",
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (instance) await stopHarper(instance);
    rmSync(component, { recursive: true, force: true });
  }, HARPER_STOP_BUDGET_MS);

  it("handles real Harper 503 memory_provider_timeout refusals through the retrying seed client", async () => {
    expect(instance).toBeDefined();
    const current = currentSeed();
    const basic = "Basic " + Buffer.from(`${instance!.admin.username}:${instance!.admin.password}`).toString("base64");

    const io = skillSeedRestIo(
      {
        baseUrl: instance!.httpURL,
        user: instance!.admin.username,
        pass: instance!.admin.password,
        skillWriteTimeoutMs: 200,
        retryBackoffMs: [30, 30],
      },
      current,
    );

    const result = await runSkillSeed(io, current);
    expect(result).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
    const message = (result as { message: string }).message;
    expect(message).toContain("HTTP 503");
    expect(message).toContain("memory_provider_timeout");

    // Verify against Harper that nothing was written to Memory for the skill row
    const ops = async (body: Record<string, unknown>): Promise<any> => {
      const response = await fetch(instance!.opsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basic },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    const records = await ops({
      operation: "search_by_id",
      database: "flair",
      table: "Memory",
      ids: [SEED_SKILL_ID],
      get_attributes: ["*"],
    });

    expect(records.length).toBe(0);
  }, 60_000);
});
