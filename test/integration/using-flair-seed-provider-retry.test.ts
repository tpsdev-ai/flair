/**
 * using-flair-seed-provider-retry.test.ts — the using-flair seed against a real
 * Harper whose embedding provider stalls on the first call for the skill row.
 *
 * The instance declares a short memory-write-lock provider bound and a
 * test-only provider delay above that bound, both under the fault-injection
 * gate. A skill row embeds its trigger (flair#1542), and the delay matches only
 * the shipped trigger, so the seed's first PUT is refused
 * `503 memory_provider_timeout` with nothing written; the second call is not
 * delayed, and the seed writes the skill row and its org assignment.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { currentSeed, runSkillSeed, SEED_ASSIGNMENT_ID, SEED_SKILL_ID, skillSeedRestIo } from "../../src/lib/skill-seed.ts";
import { USING_FLAIR_SKILL_CONTENT, USING_FLAIR_SKILL_TRIGGER } from "../../src/lib/using-flair-skill.ts";

const WARMUP_AGENT_ID = "agent-warmup";
// A bound a warm embed meets on a loaded runner, and a delay well above it.
const PROVIDER_BOUND_MS = 2_000;
const PROVIDER_DELAY_MS = 5_000;
/** The shipped trigger, the text a skill row embeds. */
const SKILL_TEXT_MATCH = USING_FLAIR_SKILL_TRIGGER;

const SERVER_ENV = {
  FLAIR_ENABLE_TEST_FAULT_INJECTION: "1",
  FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS: String(PROVIDER_BOUND_MS),
  FLAIR_TEST_EMBED_PROVIDER_DELAY_MS: String(PROVIDER_DELAY_MS),
  FLAIR_TEST_EMBED_PROVIDER_DELAY_MATCH: SKILL_TEXT_MATCH,
};

let harper: HarperInstance;

const createdAt = new Date().toISOString();

function assertOwnInstance(h: HarperInstance): void {
  for (const raw of [h.httpURL, h.opsURL]) {
    const u = new URL(raw);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
  }
}

function adminAuth(h: HarperInstance): string {
  return "Basic " + btoa(`${h.admin.username}:${h.admin.password}`);
}

async function rowsById(h: HarperInstance, table: string, id: string): Promise<any[]> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth(h) },
    body: JSON.stringify({ operation: "search_by_id", database: "flair", table, ids: [id], get_attributes: ["*"] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ops search returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as any[];
}

/**
 * Load the embedding model before the seed, so the short provider bound is not
 * spent on a first-call model download or load. A POST embeds outside the
 * write lock, so it waits for the model. Each attempt writes a row for another
 * agent; the first row stored with a vector ends it.
 */
async function warmEmbeddingModel(h: HarperInstance): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const id = `warm-up-${attempt}`;
    const res = await fetch(`${h.httpURL}/Memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth(h) },
      body: JSON.stringify({ id, agentId: WARMUP_AGENT_ID, content: `warm-up ${attempt}`, durability: "standard", createdAt }),
      signal: AbortSignal.timeout(100_000),
    });
    if (!res.ok) throw new Error(`warm-up POST returned ${res.status}: ${await res.text()}`);
    const [row] = await rowsById(h, "Memory", id);
    if (Array.isArray(row?.embedding) && row.embedding.length > 0) return;
  }
  throw new Error("the embedding model did not load: three warm-up rows were stored without a vector");
}

beforeAll(async () => {
  harper = await startHarper({ serverEnv: { ...SERVER_ENV } });
  assertOwnInstance(harper);
  await warmEmbeddingModel(harper);
}, 420_000);

afterAll(async () => {
  try {
    await stopHarpers([harper]);
  } finally {
    if (harper?.installDir?.startsWith(tmpdir())) rmSync(harper.installDir, { recursive: true, force: true });
  }
}, HARPER_STOP_BUDGET_MS * 2);

describe("the using-flair seed retries a real provider-timeout refusal", () => {
  test("the first skill-row PUT is refused 503 memory_provider_timeout, the retry writes the row, then the assignment", async () => {
    expect(await rowsById(harper, "Memory", SEED_SKILL_ID)).toEqual([]);

    // The real REST client, with each Memory PUT's answer recorded.
    const memoryPuts: Array<{ status: number; error?: unknown }> = [];
    const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fetch(input, init);
      if ((init?.method ?? "GET") === "PUT" && new URL(String(input)).pathname.startsWith("/Memory/")) {
        let error: unknown;
        try {
          error = JSON.parse(await res.clone().text())?.error;
        } catch {
          error = undefined;
        }
        memoryPuts.push({ status: res.status, error });
      }
      return res;
    }) as typeof fetch;

    const outcome = await runSkillSeed(
      skillSeedRestIo({
        baseUrl: harper.httpURL,
        user: harper.admin.username,
        pass: harper.admin.password,
        fetchImpl: recordingFetch,
      }),
      currentSeed(),
    );

    expect(outcome).toMatchObject({ kind: "ok", action: "create", skillId: SEED_SKILL_ID, assignmentId: SEED_ASSIGNMENT_ID });
    // The delay fires once; a retry slowed past the bound would be refused the
    // same way, so every PUT before the last is the timeout refusal.
    expect(memoryPuts.length).toBeGreaterThanOrEqual(2);
    for (const put of memoryPuts.slice(0, -1)) expect(put).toEqual({ status: 503, error: "memory_provider_timeout" });
    const last = memoryPuts[memoryPuts.length - 1];
    expect(last.status).toBeGreaterThanOrEqual(200);
    expect(last.status).toBeLessThan(300);

    const [row] = await rowsById(harper, "Memory", SEED_SKILL_ID);
    expect(row).toMatchObject({
      id: SEED_SKILL_ID,
      agentId: harper.admin.username,
      content: USING_FLAIR_SKILL_CONTENT,
      durability: "persistent",
      visibility: "shared",
    });
    expect(row.tags).toContain("skill");
    const [assignment] = await rowsById(harper, "OrgSkillAssignment", SEED_ASSIGNMENT_ID);
    expect(assignment).toMatchObject({ id: SEED_ASSIGNMENT_ID, skillRef: SEED_SKILL_ID, skillName: currentSeed().name });
  }, 120_000);
});
