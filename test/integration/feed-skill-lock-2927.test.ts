/**
 * feed-skill-lock-2927.test.ts — flair#2927, real Harper.
 *
 * A skill-tagged POST /FeedMemories write is a Memory writer of the rows it
 * addresses and closes, and of the live head it resolves when the addressed id
 * is absent, so (resources/MemoryFeed.ts) it now takes the same per-id Memory
 * write lock as the ordinary feed write-back
 * (resources/memory-write-lock.ts), including the outcome-unknown marker
 * check. A marked id answers `503 write_outcome_unknown` to both paths; a held
 * id refuses the skill write `503 memory_busy` without writing, exactly as it
 * refuses the ordinary write. A live head outside the held set releases and
 * retries, then refuses `409 skill_head_moved`.
 *
 * DETERMINISTIC ORDERING via the opt-in pause points
 * (FLAIR_ENABLE_TEST_FAULT_INJECTION + FLAIR_TEST_PAUSE_DIR):
 *   - memory-patch-verify: the owner PATCH's post-commit verification read runs
 *     here; the test arms a Memory read failure for the id, so the PATCH
 *     records the id outcome-unknown (the marker the cases below read);
 *   - feed-ingest-staged: the ordinary feed write is staged and the id's lock
 *     is held;
 *   - the skill writer's own `skill-close-staged` pause is not used here.
 *
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent, expectRefused, newAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";

const owner = newAgent("fsl-owner");
const CURRENT_MODEL_ID = getModelId();
const SKILL_WRITER = "feed-skill-ingest";

let harper: HarperInstance;
let pauseDir: string;
let home: string;
let stubDir: string;
let component: ProbeComponent;
let h: RaceHarness;

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

function seed(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  // An explicit visibility and a current embedding stamp: the boot visibility
  // backfill and the embedding-stamp migration leave the row alone.
  return h.seedMemory({
    id, agentId: owner.id, content: `content of ${id}`, embedding: [0.1, 0.2, 0.3],
    embeddingModel: CURRENT_MODEL_ID, ...extra,
  }, {});
}

async function feedSkill(id: string, content: string): Promise<Response> {
  return h.signed(owner, "POST", "/FeedMemories", {
    id, agentId: owner.id, content, trigger: `when ${content} applies`,
    tags: ["skill"], durability: "persistent", visibility: "shared",
  });
}

/** Mark `id` outcome-unknown: an owner PATCH whose verification read is failed
 *  on demand (the arm file is consumed by the first Memory read of that id). */
async function markOutcomeUnknown(id: string): Promise<void> {
  h.arm("memory-patch-verify");
  const held = h.signed(owner, "PATCH", memPath(id), { embedding: null, embeddingModel: null });
  await h.assertPaused("memory-patch-verify");
  writeFileSync(join(pauseDir, `arm.memory-get-fail.${id}`), "");
  await h.release("memory-patch-verify");
  const marked = await held;
  const body = await marked.clone().json() as any;
  expect(existsSync(join(pauseDir, `arm.memory-get-fail.${id}`)), "the read-back was not the read that failed").toBe(false);
  expect(marked.status, JSON.stringify(body)).toBe(503);
  expect(body.error).toBe("write_outcome_unknown");
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2927-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2927-pause-"));
  stubDir = mkdtempSync(join(tmpdir(), "flair-2927-stub-"));
  writeFileSync(join(stubDir, "generate-response.json"), JSON.stringify({ candidates: [] }));
  component = composeTracedComponent();
  harper = await startHarper({
    cwd: component.dir, harperBinDir: component.sourceRoot, homeDir: home,
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
    appendRootConfigYaml: [
      "models:",
      "  generative:",
      "    default:",
      `      backend: ${resolve(process.cwd(), "test/fixtures/stub-generative-backend.mjs")}`,
      `      responseFile: ${join(stubDir, "generate-response.json")}`,
    ].join("\n"),
  });
  h = new RaceHarness(pauseDir);
  h.harper = harper;
  h.assertOwnInstance();
  await h.seedAgent(owner);
}, 240_000);

afterAll(async () => {
  if (harper) {
    const installDir = harper.installDir;
    await stopHarper(harper).catch(() => {});
    rmSync(installDir, { recursive: true, force: true, maxRetries: 4 });
  }
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  component?.cleanup();
}, HARPER_STOP_BUDGET_MS);

describe("flair#2927 — a skill-tagged feed write (real Harper)", () => {
  it("a marked id answers 503 write_outcome_unknown to the skill feed write, as it does to the ordinary feed write", async () => {
    const id = "fsl-skill-marked";
    await seed(id);
    await markOutcomeUnknown(id);
    const before = await h.readRow(id);

    await expectRefused(await h.signed(owner, "POST", "/FeedMemories", { id, agentId: owner.id, content: "ordinary feed write to the marked id" }), "write_outcome_unknown");
    await expectRefused(await feedSkill(id, "skill feed write to the marked id"), "write_outcome_unknown");
    expect(await h.readRow(id), "a write to the marked id changed the stored row").toEqual(before);
  }, 180_000);

  it("a skill feed write to an id held by an ordinary feed write is refused memory_busy and writes nothing", async () => {
    const id = "fsl-skill-held";
    await seed(id);
    h.arm("feed-ingest-staged");
    const pending = h.signed(owner, "POST", "/FeedMemories", { id, agentId: owner.id, content: "ordinary feed write holding the id" });
    await h.assertPaused("feed-ingest-staged");
    const refused = await feedSkill(id, "skill feed write while the id is held");
    const refusedBody = await refused.clone().json() as any;
    expect(refused.status, JSON.stringify(refusedBody)).toBe(503);
    expect(refusedBody).toEqual({ error: "memory_busy", caller: owner.id });
    const held = await h.readRow(id);
    expect(held?.content, "the refused skill write wrote the id").toBe(`content of ${id}`);
    expect(held?.validTo ?? null, "the refused skill write closed the id").toBeNull();
    expect(h.writesBy(id, SKILL_WRITER), "the refused skill write reached the table").toEqual([]);

    await h.release("feed-ingest-staged");
    expect((await pending).status).toBe(200);
    expect((await h.readRow(id))?.content).toBe("ordinary feed write holding the id");

    // The same skill write succeeds once the id is free.
    const after = await feedSkill(id, "skill feed write after the release");
    expect(after.status, (await after.clone().text()).slice(0, 300)).toBe(200);
    expect(typeof (await h.readRow(id))?.validTo, "the skill write did not close the row it addressed").toBe("string");
  }, 180_000);
  it("a live head of an absent addressed id is refused memory_busy while its lock is held, and nothing is written", async () => {
    // The write addresses id `subject`, which is absent; its live head is
    // `head` (skillSubjectId = subject). The head is the row the writer would
    // close, so its lock decides the write.
    const subject = "fsl-head-held-subject";
    const head = "fsl-head-held-live";
    await seed(head, { skillSubjectId: subject });
    h.arm("feed-ingest-staged");
    const pending = h.signed(owner, "POST", "/FeedMemories", { id: head, agentId: owner.id, content: "ordinary feed write holding the live head" });
    await h.assertPaused("feed-ingest-staged");
    const before = await h.readRow(head);

    const refused = await feedSkill(subject, "skill feed write closing the live head");
    const refusedBody = await refused.clone().json() as any;
    expect(refused.status, JSON.stringify(refusedBody)).toBe(503);
    expect(refusedBody).toEqual({ error: "memory_busy", caller: owner.id });
    expect(await h.readRow(head), "the refused skill write changed the live head").toEqual(before);
    expect(await h.readRow(subject), "the refused skill write created the addressed row").toBeNull();
    expect(h.writesBy(head, SKILL_WRITER), "the refused skill write reached the live head").toEqual([]);

    await h.release("feed-ingest-staged");
    expect((await pending).status).toBe(200);
  }, 180_000);

  it("a live head of an absent addressed id marked outcome-unknown is refused and nothing is written", async () => {
    const subject = "fsl-head-marked-subject";
    const head = "fsl-head-marked-live";
    await seed(head, { skillSubjectId: subject });
    await markOutcomeUnknown(head);
    const before = await h.readRow(head);

    const refused = await feedSkill(subject, "skill feed write closing the marked live head");
    await expectRefused(refused, "write_outcome_unknown");
    expect(await h.readRow(head), "the refused skill write changed the live head").toEqual(before);
    expect(await h.readRow(subject), "the refused skill write created the addressed row").toBeNull();
    expect(h.writesBy(head, SKILL_WRITER), "the refused skill write reached the live head").toEqual([]);
  }, 180_000);

  it("a live head of an absent addressed id is closed under its own lock when free", async () => {
    const subject = "fsl-head-free-subject";
    const head = "fsl-head-free-live";
    await seed(head, { skillSubjectId: subject });

    const res = await feedSkill(subject, "skill feed write closing the free live head");
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    const created = await h.readRow(subject);
    expect(created?.content).toBe("skill feed write closing the free live head");
    expect(created?.skillSubjectId).toBe(subject);
    expect(typeof (await h.readRow(head))?.validTo, "the skill write did not close the live head").toBe("string");
    expect(h.writesBy(head, SKILL_WRITER).map((write) => write.method), "the close did not run under the lock phase").toContain("put");
  }, 120_000);

  it("CONTROL: an uncontended skill feed create is stored and its Memory write runs under the id's lock", async () => {
    const id = "fsl-skill-control";
    const res = await feedSkill(id, "skill control body");
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    const row = await h.readRow(id);
    expect(row?.content).toBe("skill control body");
    expect(row?.skillSubjectId).toBe(id);
    expect(h.writesBy(id, SKILL_WRITER).map((write) => write.method), "the skill write did not run under the lock phase").toContain("put");
  }, 120_000);

});
