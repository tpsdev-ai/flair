/**
 * using-flair-seed-provider-retry.test.ts — the using-flair seed against a real
 * Harper with a test-only embedding provider delay above its memory-write-lock
 * provider bound, both under the fault-injection gate. The delay matches the
 * shipped trigger, which a skill row embeds (flair#1542). The test asserts that
 * the seed's first PUT is refused `503 memory_provider_timeout`, that every PUT
 * before the last is that refusal and the last succeeds, and that the skill row
 * and its org assignment are committed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { currentSeed, runSkillSeed, SEED_ASSIGNMENT_ID, SEED_SKILL_ID, skillSeedRestIo } from "../../src/lib/skill-seed.ts";
import { USING_FLAIR_SKILL_CONTENT, USING_FLAIR_SKILL_TRIGGER } from "../../src/lib/using-flair-skill.ts";

const WARMUP_AGENT_ID = "agent-warmup";
// The provider bound, and a test-only delay above it.
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
 * Before the seed, commit a row with a vector: each attempt POSTs a row for
 * another agent without an id, reads back the id the POST returned, and ends
 * when that row is stored with a vector.
 */
async function warmEmbeddingModel(h: HarperInstance): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${h.httpURL}/Memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth(h) },
      body: JSON.stringify({ agentId: WARMUP_AGENT_ID, content: `warm-up ${attempt}`, durability: "standard", createdAt }),
      signal: AbortSignal.timeout(100_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`warm-up POST returned ${res.status}: ${text}`);
    const body = JSON.parse(text);
    const id = typeof body === "string" ? body : body?.id;
    if (typeof id !== "string" || id.length === 0) throw new Error(`warm-up POST returned no id: ${text.slice(0, 200)}`);
    const [row] = await rowsById(h, "Memory", id);
    if (row?.agentId !== WARMUP_AGENT_ID) throw new Error(`warm-up row ${id} was not committed`);
    if (Array.isArray(row.embedding) && row.embedding.length > 0) return;
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
