/**
 * memory-skill-write-lock-2950.test.ts — flair#2950, real Harper.
 *
 * The Memory.ts skill-version writes that name or address a stored id take the
 * same per-id Memory write lock as the feed path: a held id makes a skill PUT
 * create, a skill PUT update, a skill POST update, a stale-id skill PUT (which
 * closes a different live head) and a skill DELETE wait for the holder's budget
 * and refuse `503 memory_busy` without writing. The holder is a Memory skill
 * write paused at `memory-post-skill-staged`, so the lock is real and the
 * holder is released by this test, never by a sleep.
 *
 * The feed path's head-disappears window is pinned too: a skill feed write
 * resolves the live head at `skill-head-resolved`, the test closes that head
 * before the write acquires its locks, and the write is refused
 * `409 skill_target_changed`; when the test deletes the head of a
 * first-version create, the write resolves no head, creates the subject and
 * answers 200.
 *
 * Throwaway HOME + data dir, ephemeral ports, and the repo's traced component.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent, expectRefused, newAgent, type TestAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";

const owner = newAgent("msw-owner");
const CURRENT_MODEL_ID = getModelId();
const SKILL_WRITER = "memory-skill-write";

let harper: HarperInstance;
let pauseDir: string;
let home: string;
let stubDir: string;
let component: ProbeComponent;
let h: RaceHarness;

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

function skillBody(id: string, content: string, agent: TestAgent = owner, extra: Record<string, unknown> = {}): any {
  return {
    id, agentId: agent.id, content, trigger: `when ${content} applies`,
    tags: ["skill"], durability: "persistent", visibility: "shared", ...extra,
  };
}

async function seedSkill(id: string): Promise<void> {
  const res = await h.signed(owner, "PUT", memPath(id), skillBody(id, `procedure ${id}`));
  const text = await res.clone().text();
  expect(res.status, text.slice(0, 300)).toBeLessThan(300);
}

/** Hold the ids of a skill write: the holder is a skill PUT/POST paused after
 *  its successor/close are staged, so the per-id lock is held by a real writer
 *  until this test releases it. */
async function holdSkill(start: () => Promise<Response>): Promise<{ release: () => Promise<void> }> {
  h.arm("memory-post-skill-staged");
  const pending = start();
  await h.assertPaused("memory-post-skill-staged");
  return {
    release: async () => {
      await h.release("memory-post-skill-staged");
      const res = await pending;
      const text = await res.clone().text();
      expect(res.status, text.slice(0, 300)).toBeLessThan(300);
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Commit a newer full record to the skill row through the operations API
 *  (lock-bypassing), keeping every identity field, so the staged close loses. */
async function commitNewerSkill(id: string, content: string): Promise<void> {
  const current = await h.readRow(id);
  expect(current, "the skill row is missing before the competing write").not.toBeNull();
  await h.ops({
    operation: "put", database: "flair", table: "Memory",
    records: [{ ...current, content, updatedAt: new Date().toISOString() }],
  });
  expect((await h.readRow(id))?.content, "the competing write is not visible while the write is paused").toBe(content);
}

async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await h.ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return (rows as any[]).sort((a, b) => Number(a.version) - Number(b.version));
}

async function liveHeadsOf(subjectId: string): Promise<string[]> {
  const rows = await h.ops({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "skillSubjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return (rows as any[])
    .filter((row) => row.archived !== true && !(typeof row.validTo === "string" && row.validTo.length > 0))
    .map((row) => String(row.id));
}

/** Hold `id`'s Memory write lock from a real writer: a skill-row PATCH pauses
 *  inside the per-id lock at `memory-patch-entry`, before its skill refusal.
 *  The returned function releases it and settles the (refused) request. */
async function holdPredecessorLock(id: string): Promise<() => Promise<Response>> {
  h.arm("memory-patch-entry");
  const pending = h.signed(owner, "PATCH", memPath(id), { content: "holder" });
  await h.assertPaused("memory-patch-entry");
  return async () => {
    await h.release("memory-patch-entry");
    return pending;
  };
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2950-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2950-pause-"));
  stubDir = mkdtempSync(join(tmpdir(), "flair-2950-stub-"));
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

describe("flair#2950 — Memory skill writes hold the existing addressed and head ids they lock (real Harper)", () => {
  it("a skill PUT create waits on a held id and refuses memory_busy without writing", async () => {
    const id = "msw-put-create-held";
    const held = await holdSkill(() => h.signed(owner, "POST", "/Memory", skillBody(id, "holder skill create")));
    const writesBefore = h.writesBy(id, SKILL_WRITER).length;
    const res = await h.signed(owner, "PUT", memPath(id), skillBody(id, "skill create while held"));
    await expectRefused(res, "memory_busy");
    expect(await h.readRow(id), "the refused skill create wrote the id").toBeNull();
    expect(h.writesBy(id, SKILL_WRITER), "the refused skill create reached the table").toHaveLength(writesBefore);
    await held.release();
  }, 180_000);

  it("a skill PUT update waits on the addressed id and refuses memory_busy without writing", async () => {
    const id = "msw-put-update-held";
    await seedSkill(id);
    const before = await h.readRow(id);
    const held = await holdSkill(() => h.signed(owner, "PUT", memPath(id), skillBody(id, "holder skill update")));
    const writesBefore = h.writesBy(id, SKILL_WRITER).length;
    const res = await h.signed(owner, "PUT", memPath(id), skillBody(id, "skill update while held"));
    await expectRefused(res, "memory_busy");
    expect(await h.readRow(id), "the refused skill update changed the addressed row").toEqual(before);
    expect(h.writesBy(id, SKILL_WRITER), "the refused skill update reached the table").toHaveLength(writesBefore);
    await held.release();
  }, 180_000);

  it("a skill POST update waits on the addressed id and refuses memory_busy without writing", async () => {
    const id = "msw-post-update-held";
    await seedSkill(id);
    const before = await h.readRow(id);
    const held = await holdSkill(() => h.signed(owner, "PUT", memPath(id), skillBody(id, "holder skill POST update")));
    const writesBefore = h.writesBy(id, SKILL_WRITER).length;
    const res = await h.signed(owner, "POST", "/Memory", skillBody(id, "skill POST update while held"));
    await expectRefused(res, "memory_busy");
    expect(await h.readRow(id), "the refused skill POST update changed the addressed row").toEqual(before);
    expect(h.writesBy(id, SKILL_WRITER), "the refused skill POST update reached the table").toHaveLength(writesBefore);
    await held.release();
  }, 180_000);

  it("a stale-id skill PUT waits on the live head it would close and refuses memory_busy", async () => {
    // The first version at `subject` is closed by a successor; the head is the
    // successor row. The staged write addresses `subject` and closes the head.
    const subject = "msw-stale-subject";
    await seedSkill(subject);
    const update = await h.signed(owner, "PUT", memPath(subject), skillBody(subject, "first successor"));
    expect(update.status, (await update.clone().text()).slice(0, 300)).toBeLessThan(300);
    const head = String((await update.clone().json() as any).id);
    expect(head).not.toBe(subject);
    const before = await h.readRow(head);

    const held = await holdSkill(() => h.signed(owner, "PUT", memPath(head), skillBody(head, "holder closes the live head")));
    const writesBefore = h.writesBy(head, SKILL_WRITER).length;
    const res = await h.signed(owner, "PUT", memPath(subject), {
      id: subject, agentId: owner.id, content: "stale-id write that closes the head",
      trigger: "when it applies", durability: "persistent",
    });
    await expectRefused(res, "memory_busy");
    expect(await h.readRow(head), "the refused stale-id write changed the live head").toEqual(before);
    expect(h.writesBy(head, SKILL_WRITER), "the refused stale-id write reached the live head").toHaveLength(writesBefore);
    await held.release();
  }, 180_000);

  it("a skill DELETE waits on the live head it would close and refuses memory_busy", async () => {
    const id = "msw-delete-held";
    await seedSkill(id);
    const before = await h.readRow(id);
    const held = await holdSkill(() => h.signed(owner, "PUT", memPath(id), skillBody(id, "holder before delete")));
    const writesBefore = h.writesBy(id, "delete").length;
    const res = await h.signed(owner, "DELETE", memPath(id));
    await expectRefused(res, "memory_busy");
    expect(await h.readRow(id), "the refused skill delete closed the row").toEqual(before);
    expect(h.writesBy(id, "delete"), "the refused skill delete reached the table").toHaveLength(writesBefore);
    await held.release();
  }, 180_000);
});

describe("flair#2950 — a deferred confirmation retry and its compensation take the predecessor's Memory lock (real Harper)", () => {
  it("a confirmation retry does not re-apply the close while another writer holds the predecessor id", async () => {
    const id = "msw-confirm-retry-held";
    const successorId = "msw-confirm-retry-held-successor";
    await seedSkill(id);
    h.arm("skill-close-staged");
    h.arm("skill-update-confirm");
    const pending = h.signed(owner, "PUT", memPath(successorId), skillBody(successorId, "v2", owner, { supersedes: id }));
    await h.assertPaused("skill-close-staged");
    // The staged close loses to this newer full write; confirmation must re-apply it.
    await commitNewerSkill(id, "competitor-before-confirmation");
    await h.release("skill-close-staged");
    await h.assertPaused("skill-update-confirm");
    const releaseHolder = await holdPredecessorLock(id);
    await h.release("skill-update-confirm");
    await sleep(600);
    const held = await h.readRow(id);
    expect(typeof held?.validTo === "string" ? held.validTo : null,
      "the confirmation retry closed the row while another writer held its id").toBeNull();
    expect(held?.content).toBe("competitor-before-confirmation");
    const holder = await releaseHolder();
    expect(holder.status, (await holder.clone().text()).slice(0, 300)).toBeGreaterThanOrEqual(400);
    const res = await pending;
    const text = await res.clone().text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const closed = await h.readRow(id);
    expect(typeof closed?.validTo, `the close did not land after the holder released: ${JSON.stringify(closed)}`).toBe("string");
    expect(await liveHeadsOf(id)).toEqual([successorId]);
  }, 180_000);

  it("a compensation undo does not write while another writer holds the predecessor id", async () => {
    const id = "msw-compensation-held";
    const successorId = "msw-compensation-held-successor";
    await seedSkill(id);
    h.arm("skill-close-staged");
    h.arm("skill-update-confirm");
    const pending = h.signed(owner, "PUT", memPath(successorId), skillBody(successorId, "v2", owner, { supersedes: id }));
    await h.assertPaused("skill-close-staged");
    await commitNewerSkill(id, "competitor-before-compensation");
    await h.release("skill-close-staged");
    await h.assertPaused("skill-update-confirm");
    const releaseHolder = await holdPredecessorLock(id);
    await h.release("skill-update-confirm");
    // The retry's lock budget expires first; the compensation then waits on the
    // same id. Hold past the first budget and release inside the second.
    await sleep(3_000);
    expect(await h.readRow(successorId), "the undo wrote while the predecessor id was held").not.toBeNull();
    expect((await versionsOf(id)).map((v) => v.kind)).toEqual(["create", "update"]);
    const holder = await releaseHolder();
    expect(holder.status, (await holder.clone().text()).slice(0, 300)).toBeGreaterThanOrEqual(400);
    const res = await pending;
    const text = await res.clone().text();
    expect(res.status, text.slice(0, 300)).toBe(500);
    expect((await res.clone().json()).error).toBe("skill_update_unconfirmed");
    expect(await h.readRow(successorId), "the undo did not complete after the holder released").toBeNull();
    expect((await versionsOf(id)).map((v) => v.kind)).toEqual(["create"]);
    expect((await h.readRow(id))?.validTo ?? null).toBeNull();
    expect(await liveHeadsOf(id)).toEqual([id]);
  }, 180_000);
});

describe("flair#2950 — a feed skill head that disappears in the pre-lock window fails closed", () => {
  function feedSkill(id: string, content: string): Promise<Response> {
    return h.signed(owner, "POST", "/FeedMemories", {
      id, agentId: owner.id, content, trigger: `when ${content} applies`,
      tags: ["skill"], durability: "persistent", visibility: "shared",
    });
  }

  async function resolveThenMutate(id: string, mutate: () => Promise<void>): Promise<Response> {
    h.arm("skill-head-resolved");
    const pending = feedSkill(id, `changed ${id}`);
    await h.assertPaused("skill-head-resolved");
    await mutate();
    await h.release("skill-head-resolved");
    return pending;
  }

  it("an existing head closed between the pre-lock resolve and acquisition refuses skill_target_changed", async () => {
    const id = "msw-feed-closed-head";
    await seedSkill(id);
    const res = await resolveThenMutate(id, () => h.rawUpdate(id, { validTo: new Date().toISOString() }));
    const body = await res.clone().json() as any;
    expect(res.status, JSON.stringify(body)).toBe(409);
    // validateSkillSnapshots runs before the head-missing branch: the addressed
    // row's stored snapshot no longer matches the closed row.
    expect(body).toEqual({ error: "skill_target_changed" });
    expect((await h.readRow(id))?.validTo, "the refused write reopened or replaced the head").toBeString();
    expect(h.writesBy(id, "feed-skill-ingest"), "the refused skill write reached the head").toEqual([]);
  }, 180_000);

  it("an existing head deleted between the pre-lock resolve and acquisition refuses skill_target_changed", async () => {
    const id = "msw-feed-deleted-head";
    await seedSkill(id);
    const res = await resolveThenMutate(id, () => h.ops({ operation: "delete", database: "flair", table: "Memory", ids: [id] }));
    const body = await res.clone().json() as any;
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body).toEqual({ error: "skill_target_changed" });
    expect(await h.readRow(id), "the refused write recreated the deleted head").toBeNull();
    expect(h.writesBy(id, "feed-skill-ingest"), "the refused skill write reached the deleted head").toEqual([]);
  }, 180_000);

  it("a first-version create whose live head is deleted in the pre-lock window does not close the stale head", async () => {
    // A head exists for the subject, but the subject row itself is absent, so
    // this is a first-version create that would close the live head. The head
    // is deleted between the pre-lock resolve and the acquisition. The write
    // must resolve the head again: it creates the subject and does not put the
    // stale head back.
    const subject = "msw-feed-create-head-gone-subject";
    const head = "msw-feed-create-head-gone";
    await h.seedMemory({
      id: head, agentId: owner.id, content: "live head for the absent subject",
      tags: ["skill"], trigger: "when it applies", durability: "persistent", visibility: "shared",
      skillSubjectId: subject, embedding: [0.1, 0.2, 0.3], embeddingModel: CURRENT_MODEL_ID,
    }, {});
    const res = await resolveThenMutate(subject, () => h.ops({ operation: "delete", database: "flair", table: "Memory", ids: [head] }));
    const body = await res.clone().json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect((await h.readRow(subject))?.content).toBe(`changed ${subject}`);
    expect(await h.readRow(head), "the write recreated the deleted head from its pre-lock read").toBeNull();
  }, 180_000);

  it("a first-version create whose target is closed in the pre-lock window refuses skill_target_changed", async () => {
    const id = "msw-feed-create-window";
    const res = await resolveThenMutate(id, async () => {
      const now = new Date().toISOString();
      await h.ops({
        operation: "insert", database: "flair", table: "Memory",
        records: [{
          id, agentId: owner.id, content: "concurrent first version", trigger: "when it applies",
          tags: ["skill"], durability: "persistent", visibility: "shared",
          skillSubjectId: id, instanceToken: "msw-create-window-token", createdAt: now,
        }],
      });
      await h.rawUpdate(id, { validTo: now });
    });
    const body = await res.clone().json() as any;
    expect(res.status, JSON.stringify(body)).toBe(409);
    // The create targeted an absent row; the concurrent first version makes
    // the target snapshot differ, so validateSkillSnapshots refuses.
    expect(body).toEqual({ error: "skill_target_changed" });
    const row = await h.readRow(id);
    expect(row?.content, "the refused create overwrote the concurrent first version").toBe("concurrent first version");
    expect(row?.validTo, "the concurrent first version was reopened").toBeString();
    expect(h.writesBy(id, "feed-skill-ingest"), "the refused create reached the table").toEqual([]);
  }, 180_000);
});
