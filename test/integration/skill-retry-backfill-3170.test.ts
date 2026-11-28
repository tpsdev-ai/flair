/**
 * skill-retry-backfill-3170.test.ts — flair#3170: an identical skill POST
 * retry is not refused by the previous write's embedding backfill.
 *
 * A skill POST that supersedes a target present in the request snapshot reads
 * that target as committed when it still exists, then plans under the lock.
 * The only change the window between the snapshot read and the committed read
 * accepts is the previous write's embedding backfill fields; any other change
 * to the target in that window answers 409 `skill_target_changed`. A target
 * deleted between the snapshot read and the committed read answers 409
 * `skill_target_changed`, with no row recreated and no InstructionVersion
 * appended. This file makes the ordering
 * deterministic with three test-only pause points:
 * `memory-post-target-read` holds the retry after its request transaction opened
 * and before it takes the target's lock and reads it,
 * `memory-post-committed-read` holds it after its request-snapshot read and
 * before its committed target read, and
 * `memory-post-skill-plan` holds it before its plan runs under the lock.
 *
 * The instance is home-isolated and ephemeral; every URL is asserted to be
 * this test's own. The backfill cases need the embedding model.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, type ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, newAgent } from "../helpers/embedding-writer-race";
import { SEED_SKILL_ROW_ID } from "../../resources/seed-ids.js";
import { promotionContentHash } from "../../resources/promotion-binding.ts";

// An administrator agent: its supplied short vector is stored as sent, which
// leaves the middleware's backfill a vector to compute.
const writer = newAgent("srb3170-writer");
const TARGET_READ = "memory-post-target-read";
const COMMITTED_READ = "memory-post-committed-read";
const PLAN = "memory-post-skill-plan";
const BACKFILL_COMMIT = "backfill-embedding-commit";
const SHORT_EMBEDDING = [0.01, 0.02, 0.03];
const MODEL_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";
const HAS_MODEL = existsSync(join(process.env.FLAIR_MODELS_DIR ?? join(process.cwd(), "models"), MODEL_FILE));

let component: ProbeComponent;
let home: string;
let pauseDir: string;
let h: RaceHarness;

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
async function callProbe(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${h.harper.httpURL}/SeedPostCallerTxnProbe/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: h.authHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  expect(res.status, `probe ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}
async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await h.ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows : [];
}
function skillBody(content: string) {
  return {
    agentId: writer.id, content, trigger: "when the same skill POST is retried",
    tags: ["skill"], durability: "persistent", embedding: SHORT_EMBEDDING,
  };
}
const PROMOTED_AT = "2026-01-01T00:00:00.000Z";
/** Stamp a valid promotion verdict over the row's stored content. */
async function stampPromoted(id: string): Promise<void> {
  const row = await h.readRow(id);
  await h.rawUpdate(id, {
    promotionStatus: "approved", promotedAt: PROMOTED_AT, promotedBy: "reviewer",
    promotionContentHash: promotionContentHash(row.content),
  });
}
/** The stamp must survive a normal Memory read (a mismatch is suppressed). */
async function assertReadsApproved(id: string): Promise<void> {
  const res = await h.signed(writer, "GET", memPath(id));
  const text = await res.text();
  expect(res.status, `read ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  expect(JSON.parse(text).promotionStatus, "the promotion stamp did not read as approved").toBe("approved");
}
/** Poll until the row holds a vector longer than the seeded short one. */
async function waitForLongVector(id: string, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let row = await h.readRow(id);
  while (Date.now() < deadline && !(row?.embedding?.length > 100)) {
    await Bun.sleep(50);
    row = await h.readRow(id);
  }
  return row;
}

/** Poll /HealthDetail until the boot migration cycle reports done; returns the last phase read. */
async function waitForBootCycle(timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let phase = "";
  while (Date.now() < deadline) {
    const res = await h.admin("GET", "/HealthDetail");
    const text = await res.text();
    phase = res.ok ? String(JSON.parse(text)?.migrations?.cyclePhase) : `HTTP ${res.status}`;
    if (phase === "done") return phase;
    await Bun.sleep(100);
  }
  return phase;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-3170-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-3170-pause-"));
  component = componentWithReplayProbe({ probe: {
    source: join("test", "fixtures", "seed-post-caller-txn-3170", "probe.js"),
    target: join("dist", "resources", "zz-seed-post-caller-txn-3170.js"),
    out: "seed-post-caller-txn-3170",
  } });
  h = new RaceHarness(pauseDir);
  h.harper = await startHarper({
    homeDir: home, cwd: component.dir, harperBinDir: component.sourceRoot,
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  h.assertOwnInstance();
  await h.seedAgent(writer, "admin");
  // flair#3179: the boot migration cycle can re-embed a row a case has just
  // POSTed, inside that case's race window. Let the cycle finish before any case runs.
  expect(await waitForBootCycle(120_000), "the boot migration cycle did not reach done").toBe("done");
}, 240_000);

afterAll(async () => {
  if (h?.harper) {
    const installDir = h.harper.installDir;
    await stopHarper(h.harper).catch(() => {});
    rmSync(installDir, { recursive: true, force: true, maxRetries: 4 });
  }
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  component?.cleanup();
}, HARPER_STOP_BUDGET_MS);

(HAS_MODEL ? describe : describe.skip)("flair#3170 — a skill POST retry and the previous write's backfill (real Harper)", () => {
  it("STEP 1: the identical retry commits a successor when the backfill commits after the request transaction opens and before the target read", async () => {
    const skillId = `srb-skill-${randomUUID()}`;
    const body = skillBody("a skill whose identical retry must not be refused");
    h.arm(BACKFILL_COMMIT);
    const first = await h.signed(writer, "POST", memPath(skillId), body);
    const firstText = await first.text();
    expect(first.status, `first ${first.status}: ${firstText.slice(0, 200)}`).toBeLessThan(300);
    expect(JSON.parse(firstText).id).toBe(skillId);
    // The first write's backfill is about to commit the vector.
    await h.assertPaused(BACKFILL_COMMIT);
    h.arm(TARGET_READ);
    const retry = h.signed(writer, "POST", memPath(skillId), body);
    try {
      await h.assertPaused(TARGET_READ);
      await h.release(BACKFILL_COMMIT);
      const backfilled = await waitForLongVector(skillId);
      expect(backfilled.embedding.length, "the backfill wrote no vector").toBeGreaterThan(100);
      await h.release(TARGET_READ);
    } finally {
      h.letGo(TARGET_READ);
      h.letGo(BACKFILL_COMMIT);
    }
    const res = await retry;
    const text = await res.text();
    expect(res.status, `retry ${res.status}: ${text.slice(0, 200)}`).toBeLessThan(300);
    const successorId = JSON.parse(text).id as string;
    expect(successorId).not.toBe(skillId);
    const successor = await h.readRow(successorId);
    expect(successor?.agentId).toBe(writer.id);
    expect(successor?.supersedes).toBe(skillId);
    // Drain the successor's own backfill so it cannot consume STEP 2's arm.
    expect((await waitForLongVector(successorId)).embedding.length).toBeGreaterThan(100);
  }, 120_000);

  it("STEP 2: the identical retry commits a successor when the body omits tags and the stored row carries the skill tag", async () => {
    const skillId = `srb-skill-${randomUUID()}`;
    const firstBody = skillBody("a skill whose retry omits the tag it inherits");
    const retryBody: Record<string, unknown> = { ...firstBody };
    delete retryBody.tags;
    h.arm(BACKFILL_COMMIT);
    const first = await h.signed(writer, "POST", memPath(skillId), firstBody);
    const firstText = await first.text();
    expect(first.status, `first ${first.status}: ${firstText.slice(0, 200)}`).toBeLessThan(300);
    expect(JSON.parse(firstText).id).toBe(skillId);
    // The first write's backfill is about to commit the vector.
    await h.assertPaused(BACKFILL_COMMIT);
    h.arm(TARGET_READ);
    const retry = h.signed(writer, "POST", memPath(skillId), retryBody);
    try {
      await h.assertPaused(TARGET_READ);
      await h.release(BACKFILL_COMMIT);
      const backfilled = await waitForLongVector(skillId);
      expect(backfilled.embedding.length, "the backfill wrote no vector").toBeGreaterThan(100);
      await h.release(TARGET_READ);
    } finally {
      h.letGo(TARGET_READ);
      h.letGo(BACKFILL_COMMIT);
    }
    const res = await retry;
    const text = await res.text();
    expect(res.status, `retry ${res.status}: ${text.slice(0, 200)}`).toBeLessThan(300);
    const successorId = JSON.parse(text).id as string;
    expect(successorId).not.toBe(skillId);
    const successor = await h.readRow(successorId);
    expect(successor?.agentId).toBe(writer.id);
    expect(successor?.supersedes).toBe(skillId);
    expect(successor?.tags).toContain("skill");
  }, 120_000);

  it("CONTROL: a target deleted after the request-snapshot read and before the committed read answers 409 skill_target_changed without a row or a version", async () => {
    const skillId = `srb-skill-${randomUUID()}`;
    const body = skillBody("a skill deleted under the retry");
    const first = await h.signed(writer, "POST", memPath(skillId), body);
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    // The first write's own backfill must not be a competing change here.
    expect((await waitForLongVector(skillId)).embedding.length).toBeGreaterThan(100);
    const versionsBefore = await versionsOf(skillId);
    h.arm(COMMITTED_READ);
    const retry = h.signed(writer, "POST", memPath(skillId), body);
    let deleted = false;
    try {
      await h.assertPaused(COMMITTED_READ);
      await h.ops({ operation: "delete", database: "flair", table: "Memory", ids: [skillId] });
      expect(await h.readRow(skillId), "the target row was not deleted").toBeNull();
      deleted = true;
    } finally {
      h.letGo(COMMITTED_READ);
    }
    expect(deleted, "the target delete did not commit").toBe(true);
    const res = await retry;
    const text = await res.text();
    expect(res.status, `retry ${res.status}: ${text.slice(0, 200)}`).toBe(409);
    expect(JSON.parse(text).error).toBe("skill_target_changed");
    expect(await h.readRow(skillId), "the retry recreated the deleted target").toBeNull();
    expect(await versionsOf(skillId), "the retry appended a version row").toEqual(versionsBefore);
  }, 120_000);

  it("CONTROL: a content and promotion change another writer commits to a content-omitting POST's target answers 409 skill_target_changed without a successor or a version", async () => {
    const skillId = `srb-skill-${randomUUID()}`;
    const body = skillBody("a promoted skill another writer changes under the retry");
    const first = await h.signed(writer, "POST", memPath(skillId), body);
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    // The first write's own backfill must not be a competing change here.
    expect((await waitForLongVector(skillId)).embedding.length).toBeGreaterThan(100);
    await stampPromoted(skillId);
    await assertReadsApproved(skillId);
    const versionsBefore = await versionsOf(skillId);
    const noContent = { agentId: writer.id, trigger: "when the same skill POST is retried", tags: ["skill"], durability: "persistent" };
    h.arm(COMMITTED_READ);
    const retry = h.signed(writer, "POST", memPath(skillId), noContent);
    let changed = false;
    try {
      await h.assertPaused(COMMITTED_READ);
      await h.rawUpdate(skillId, {
        content: "another writer replaced this skill's content",
        promotionStatus: null, promotedAt: null, promotedBy: null, promotionContentHash: null,
      });
      changed = true;
    } finally {
      h.letGo(COMMITTED_READ);
    }
    expect(changed, "the competing change did not commit").toBe(true);
    const res = await retry;
    const text = await res.text();
    expect(res.status, `retry ${res.status}: ${text.slice(0, 200)}`).toBe(409);
    expect(JSON.parse(text).error).toBe("skill_target_changed");
    const target = await h.readRow(skillId);
    expect(target?.content, "the retry overwrote the target").toBe("another writer replaced this skill's content");
    expect(target?.promotionStatus ?? null, "the retry restored a cleared stamp").toBeNull();
    const successors = await h.ops({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "supersedes", search_value: skillId, get_attributes: ["*"] });
    expect(Array.isArray(successors) ? successors : [], "the retry created a successor").toEqual([]);
    expect(await versionsOf(skillId), "the retry appended a version row").toEqual(versionsBefore);
  }, 120_000);

  it("CONTROL: a promotion-only change another writer commits under a content-identical POST answers 409 skill_target_changed without a successor or a version", async () => {
    const skillId = `srb-skill-${randomUUID()}`;
    const body = skillBody("a promoted skill whose stamp another writer clears under the retry");
    const first = await h.signed(writer, "POST", memPath(skillId), body);
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    // The first write's own backfill must not be a competing change here.
    expect((await waitForLongVector(skillId)).embedding.length).toBeGreaterThan(100);
    await stampPromoted(skillId);
    await assertReadsApproved(skillId);
    const versionsBefore = await versionsOf(skillId);
    h.arm(COMMITTED_READ);
    const retry = h.signed(writer, "POST", memPath(skillId), body);
    let cleared = false;
    try {
      await h.assertPaused(COMMITTED_READ);
      await h.rawUpdate(skillId, {
        promotionStatus: null, promotedAt: null, promotedBy: null, promotionContentHash: null,
      });
      cleared = true;
    } finally {
      h.letGo(COMMITTED_READ);
    }
    expect(cleared, "the promotion clear did not commit").toBe(true);
    const res = await retry;
    const text = await res.text();
    expect(res.status, `retry ${res.status}: ${text.slice(0, 200)}`).toBe(409);
    expect(JSON.parse(text).error).toBe("skill_target_changed");
    const target = await h.readRow(skillId);
    expect(target?.content, "the retry overwrote the target").toBe(body.content);
    expect(target?.promotionStatus ?? null, "the retry restored a cleared stamp").toBeNull();
    const successors = await h.ops({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "supersedes", search_value: skillId, get_attributes: ["*"] });
    expect(Array.isArray(successors) ? successors : [], "the retry created a successor").toEqual([]);
    expect(await versionsOf(skillId), "the retry appended a version row").toEqual(versionsBefore);
  }, 120_000);

  it("CONTROL: a content change another writer commits after the target read and before the plan still answers 409 skill_target_changed", async () => {
    const skillId = `srb-skill-${randomUUID()}`;
    const body = skillBody("a skill another writer changes under the retry");
    const first = await h.signed(writer, "POST", memPath(skillId), body);
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    // The first write's own backfill must not be the change this case tests.
    expect((await waitForLongVector(skillId)).embedding.length).toBeGreaterThan(100);
    h.arm(PLAN);
    const retry = h.signed(writer, "POST", memPath(skillId), body);
    let changed = false;
    try {
      await h.assertPaused(PLAN);
      await h.rawUpdate(skillId, { content: "another writer replaced this skill's content" });
      changed = true;
    } finally {
      h.letGo(PLAN);
    }
    expect(changed, "the competing change did not commit").toBe(true);
    const res = await retry;
    const text = await res.text();
    expect(res.status, `retry ${res.status}: ${text.slice(0, 200)}`).toBe(409);
    expect(JSON.parse(text).error).toBe("skill_target_changed");
  }, 120_000);
});

describe("flair#3170 — an in-place reserved seed POST in a caller-owned transaction (real Harper)", () => {
  it("a caller abort leaves the row's content and its version unchanged", async () => {
    const seed = {
      id: SEED_SKILL_ROW_ID, agentId: writer.id, content: "seed skill v1",
      tags: ["skill"], durability: "persistent", visibility: "shared", trigger: "when seeding",
    };
    const created = await callProbe({ record: seed, abort: false });
    expect(created, JSON.stringify(created)).toEqual({ aborted: false, written: true, staged: { content: "seed skill v1", version: 1 } });

    const before = await h.readRow(SEED_SKILL_ROW_ID);
    expect(before?.content).toBe("seed skill v1");
    const versionsBefore = await versionsOf(SEED_SKILL_ROW_ID);
    expect(versionsBefore.length, "the seed create appended no version").toBeGreaterThan(0);
    const nextVersion = Math.max(...versionsBefore.map((row) => Number(row.version))) + 1;

    const aborted = await callProbe({ record: { ...seed, content: "seed skill v2" }, abort: true });
    expect(aborted, JSON.stringify(aborted)).toEqual({
      aborted: true, written: true, staged: { content: "seed skill v2", version: nextVersion },
    });

    const after = await h.readRow(SEED_SKILL_ROW_ID);
    expect(after?.content, "the caller abort did not undo the in-place write").toBe("seed skill v1");
    expect(await versionsOf(SEED_SKILL_ROW_ID), "the caller abort left a version row").toEqual(versionsBefore);
  }, 120_000);
});
