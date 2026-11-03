/**
 * feed-skill-lock-2927.test.ts — flair#2927, real Harper.
 *
 * A skill-tagged POST /FeedMemories write is a Memory writer of the rows it
 * addresses and closes, and of the live head it resolves when the addressed id
 * is absent, so (resources/MemoryFeed.ts) it now takes the same per-id Memory
 * write lock as the ordinary feed write-back
 * (resources/memory-write-lock.ts), including the outcome-unknown marker
 * check. For an authorized caller, a marked id answers `503
 * write_outcome_unknown` to both paths; a held id refuses the skill write `503
 * memory_busy` without writing. A live head outside the held set releases and
 * retries; `409 skill_head_moved` is returned only if the resolved head stays
 * outside the held set through the final attempt.
 *
 * DETERMINISTIC ORDERING via the opt-in pause points
 * (FLAIR_ENABLE_TEST_FAULT_INJECTION + FLAIR_TEST_PAUSE_DIR):
 *   - memory-patch-verify: the owner PATCH's post-commit verification read runs
 *     here; the test arms a Memory read failure for the id, so the PATCH
 *     records the id outcome-unknown (the marker the cases below read);
 *   - feed-ingest-staged: the ordinary feed write is staged and the id's lock
 *     is held;
 *   - skill-close-staged: a skill write's close is staged and its locks are
 *     held;
 *   - skill-head-resolved: a skill write has resolved the live head and has not
 *     taken its locks yet;
 *   - skill-update-confirm: a skill update has committed and not yet confirmed
 *     its committed state; the test closes the successor and inserts a delete
 *     version that does not hash-link to the update's version, so the update
 *     answers `500 skill_update_compensation_failed`.
 *
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent, expectRefused, newAgent, type TestAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";

const owner = newAgent("fsl-owner");
const intruder = newAgent("fsl-intruder");
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

async function feedSkill(id: string, content: string, agent: TestAgent = owner): Promise<Response> {
  return h.signed(agent, "POST", "/FeedMemories", {
    id, agentId: agent.id, content, trigger: `when ${content} applies`,
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
  await h.seedAgent(intruder);
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

  it("a head owned by another agent is refused the same ownership error whether it is free, held or marked", async () => {
    const cases = [
      { subject: "fsl-authz-free-subject", head: "fsl-authz-free-head" },
      { subject: "fsl-authz-marked-subject", head: "fsl-authz-marked-head" },
      { subject: "fsl-authz-held-subject", head: "fsl-authz-held-head" },
    ];
    for (const c of cases) await seed(c.head, { visibility: "private", skillSubjectId: c.subject });

    const refusal = async (subject: string) => {
      const res = await feedSkill(subject, "skill feed write by a caller without a grant", intruder);
      const body = await res.clone().json() as any;
      return { status: res.status, body };
    };

    const free = await refusal(cases[0].subject);
    expect(free.status, JSON.stringify(free.body)).toBe(403);
    expect(free.body.error).toBe("forbidden: cannot write a skill owned by another agent without a write grant");

    await markOutcomeUnknown(cases[1].head);
    const marked = await refusal(cases[1].subject);

    h.arm("feed-ingest-staged");
    const pending = h.signed(owner, "POST", "/FeedMemories", { id: cases[2].head, agentId: owner.id, content: "ordinary feed write holding the private head" });
    await h.assertPaused("feed-ingest-staged");
    const held = await refusal(cases[2].subject);
    await h.release("feed-ingest-staged");
    expect((await pending).status).toBe(200);

    expect({ marked, held }, "the marked or held head answered differently from the free head").toEqual({ marked: free, held: free });
    for (const c of cases) {
      expect(await h.readRow(c.subject), "the refused skill write created the addressed row").toBeNull();
      expect(h.writesBy(c.head, SKILL_WRITER), "the refused skill write reached the live head").toEqual([]);
    }
  }, 180_000);

  it("a head that moves between attempts is included on the next attempt and the write succeeds", async () => {
    const subject = "fsl-move-subject";
    const first = "fsl-move-first";
    await seed(first, { skillSubjectId: subject });

    // The first writer supersedes `first`; its close is staged and its lock
    // held while the transaction is uncommitted.
    h.arm("skill-close-staged");
    const moving = feedSkill(first, "skill write that replaces the first head");
    await h.assertPaused("skill-close-staged");

    // The second writer resolves the still-live first head, then pauses before
    // taking its lock, so the move lands after that resolution.
    h.arm("skill-head-resolved");
    const moved = feedSkill(subject, "skill write that resolves a moved head");
    await h.assertPaused("skill-head-resolved");

    await h.release("skill-close-staged");
    const movingRes = await moving;
    expect(movingRes.status, (await movingRes.clone().text()).slice(0, 300)).toBe(200);
    const newHead = String((await movingRes.clone().json() as any).id);

    await h.release("skill-head-resolved");
    const movedRes = await moved;
    expect(movedRes.status, (await movedRes.clone().text()).slice(0, 300)).toBe(200);
    expect((await h.readRow(subject))?.content).toBe("skill write that resolves a moved head");
    expect(typeof (await h.readRow(newHead))?.validTo, "the skill write did not close the moved head").toBe("string");
    expect(h.writesBy(subject, SKILL_WRITER).map((write) => write.method), "the retried write did not run under the lock phase").toContain("put");
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

  it("a skill update whose undo cannot be confirmed marks the ids it wrote outcome-unknown, and not a locked id it did not write", async () => {
    // `pred` is the subject's first version and `head` its live successor. The
    // failing write addresses `head` and repeats its `supersedes: pred`, so it
    // locks `pred` as well, and writes only its successor and `head`'s close.
    const pred = "fsl-undo-pred";
    const head = "fsl-undo-head";
    const created = await feedSkill(pred, "undo lineage first version");
    expect(created.status, (await created.clone().text()).slice(0, 300)).toBe(200);
    const updatePayload = (content: string) => ({
      id: head, supersedes: pred, agentId: owner.id, content, trigger: `when ${content} applies`,
      tags: ["skill"], durability: "persistent", visibility: "shared",
    });
    const updated = await h.signed(owner, "POST", "/FeedMemories", updatePayload("undo lineage second version"));
    expect(updated.status, (await updated.clone().text()).slice(0, 300)).toBe(200);
    expect((await h.readRow(head))?.supersedes).toBe(pred);
    const predWrites = h.writesBy(pred, SKILL_WRITER).length;

    h.arm("skill-update-confirm");
    const failing = h.signed(owner, "POST", "/FeedMemories", updatePayload("undo lineage third version"));
    let successorId = "";
    try {
      await h.assertPaused("skill-update-confirm");
      const versions = await h.ops({
        operation: "search_by_value", database: "flair", table: "InstructionVersion",
        search_attribute: "subjectId", search_value: pred, get_attributes: ["*"],
      }) as any[];
      const appended = versions.sort((a, b) => Number(a.version) - Number(b.version)).at(-1);
      expect(appended?.kind, JSON.stringify(versions)).toBe("update");
      successorId = String(appended.memoryId);
      const successor = await h.readRow(successorId);
      expect(successor?.supersedes, "the paused write's successor does not supersede the head").toBe(head);
      const closedAt = new Date().toISOString();
      await h.ops({ operation: "put", database: "flair", table: "Memory", records: [{ ...successor, validTo: closedAt, updatedAt: closedAt }] });
      const next = Number(appended.version) + 1;
      await h.ops({
        operation: "insert", database: "flair", table: "InstructionVersion", records: [{
          id: `skill:${pred}:${next}`, subjectType: "skill", subjectId: pred, agentId: owner.id, key: null,
          version: next, kind: "delete", rowId: successorId, valueHash: null,
          previousVersionHash: "not-this-updates-record-hash", soulSnapshot: null, memoryId: null, visibility: "shared",
          actorKind: "agent", actorId: owner.id, sourceClass: "agent",
          createdAt: closedAt, guarded: false, expectedVersion: null, recordHash: "following-delete",
        }],
      });
      await h.release("skill-update-confirm");
    } finally {
      h.letGo("skill-update-confirm");
    }
    const res = await failing;
    const body = await res.clone().json() as any;
    expect(res.status, JSON.stringify(body)).toBe(500);
    expect(body.error).toBe("skill_update_compensation_failed");
    expect(h.writesBy(pred, SKILL_WRITER), "the failing write wrote the locked predecessor").toHaveLength(predWrites);

    await expectRefused(await feedSkill(successorId, "write to the unconfirmed successor"), "write_outcome_unknown");
    await expectRefused(await feedSkill(head, "write to the closed head"), "write_outcome_unknown");
    // `pred` is not marked: the same write takes its lock and reaches the plan.
    const unmarked = await feedSkill(pred, "write to the unwritten predecessor");
    const unmarkedBody = await unmarked.clone().json() as any;
    expect(unmarked.status, JSON.stringify(unmarkedBody)).toBe(409);
    expect(unmarkedBody).toEqual({ error: "skill_head_missing" });
  }, 180_000);

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
