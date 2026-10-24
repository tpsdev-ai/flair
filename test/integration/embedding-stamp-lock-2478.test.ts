/**
 * embedding-stamp-lock-2478.test.ts — flair#2478 slice 3 (embeddings): the
 * embedding-stamp migration's two write paths against owner writes of the same
 * id, real Harper.
 *
 *  - The HTTP delegation: for an ordinary id the migration sends the re-embed
 *    `PATCH /Memory/<id>` over loopback. That PATCH takes the id's per-id Memory
 *    write lock (phase `patch-reembed`) with the owner budget, re-reads the
 *    committed row under it, embeds the stored text and commits before the
 *    release. A refused PATCH (`503 memory_busy`, `write_outcome_unknown`,
 *    `memory_provider_timeout`) leaves the row uncounted, and the migration
 *    logs the refusal; the next scan decides whether the row is still stale
 *    (an owner write can make it current meanwhile, as the owner-first case
 *    shows).
 *  - The `.content`-suffix fallback: for an id the by-id PATCH cannot address,
 *    the migration computes the vector first, then takes the id's lock
 *    (phase `embedding-stamp-content-suffix`) with one non-waiting
 *    acquisition per attempt; a retry acquires it again. On a held id or an
 *    outcome-unknown marker that attempt writes nothing and the row is left
 *    uncounted (after an earlier unconfirmed attempt for the row, the log says
 *    the outcome is unknown); the next scan decides whether it is still stale. Under the lock it re-reads the committed row
 *    and writes only if the row is the one it embedded; it stages an
 *    incremental update of the four embedding fields, confirms the committed
 *    row, commits, and verifies the committed row before the release. After a
 *    readable read-back mismatch it retries, at most 3 attempts; a retry
 *    after an unconfirmed attempt, finding the vector that attempt staged
 *    (a match within a relative tolerance) beside a changed text, re-embeds the current
 *    text, also for a row with an empty owner (whose stored text hash is null).
 *
 * Owner PUT/PATCH/DELETE refuse a `.content`-suffixed id, so the fallback's
 * owner cases name the id in the body of a PUT or PATCH: while the fallback
 * holds the id that write is refused `503 memory_busy`; with the id free it is
 * refused `400` by the id guard. A DELETE of such a row is a lock-bypassing
 * operations-API delete.
 *
 * Each boot pauses the migration's boot cycle at the armed points of its rows
 * in turn, rows being processed in id order: the request's or the fallback's
 * own points, and a point before the lock (the HTTP path's
 * `embedding-stamp-regen-pre`, the fallback's
 * `embedding-stamp-content-suffix-pre`). The next row's first point is armed
 * before the current pause is released. Run results come from the
 * migration's test-only run log. Seeded rows carry an explicit visibility so
 * the visibility backfill leaves them alone; the stale rows carry a stamp from
 * no current model so the migration selects them.
 *
 * Home-isolated ephemeral Harper; every URL is asserted to be this test's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent, cosine, expectEmptyOwnerVector, expectRefused, newAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { computeContentHash } from "../../resources/memory-feed-lib.ts";

const owner = newAgent("esl2478-owner");
const CURRENT_MODEL_ID = getModelId();
const STALE_MODEL = "esl2478-ancient-model-v0";
const STALE_EMBEDDING = [0.1, 0.1, 0.1];
const ORIGINAL = "the stale note about the lighthouse keeper's logbook and the autumn storms";
const OWNER_TEXT = "an owner edit about the village bakery's new sourdough starter schedule";
const EDITED = "a lock-bypassing edit about glacier survey stakes and their melt readings";
const hashOf = (text: string) => computeContentHash(owner.id, text);

const HTTP_WRITER = "patch-reembed";
const SUFFIX_WRITER = "embedding-stamp-content-suffix";
const GATE = "embedding-stamp-regen-pre";
const STAGED = "memory-reembed-staged";
const CONFIRMED = "memory-reembed-commit";
const COMMITTED = "memory-patch-committed";
const S_GATE = "embedding-stamp-content-suffix-pre";
const S_STAGED = "embedding-stamp-content-suffix";
const S_CONFIRMED = "embedding-stamp-content-suffix-commit";
const S_VERIFY = "embedding-stamp-content-suffix-verify";
const S_COMMITTED = "embedding-stamp-content-suffix-committed";

let component: ProbeComponent;
let home: string;
let pauseDir: string;
let installDir: string;
let h: RaceHarness;
const vectors = new Map<string, number[]>();
async function vectorOf(text: string): Promise<number[]> {
  if (!vectors.has(text)) vectors.set(text, await h.serverEmbedding(text));
  return vectors.get(text)!;
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
function staleRow(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, agentId: owner.id, content: ORIGINAL, embedding: STALE_EMBEDDING, embeddingModel: STALE_MODEL, ...extra };
}
function ownerWrite(verb: "PUT" | "PATCH", id: string, content: string): Promise<Response> {
  return verb === "PUT"
    ? h.signed(owner, "PUT", memPath(id), { agentId: owner.id, content, visibility: "private", durability: "standard" })
    : h.signed(owner, "PATCH", memPath(id), { content, visibility: "private" });
}
/** A PUT or PATCH naming a `.content`-suffixed id in its body (the URL names the base id). */
function suffixWrite(verb: "PUT" | "PATCH", id: string): Promise<Response> {
  const base = id.slice(0, -".content".length);
  return h.admin(verb, memPath(base), verb === "PUT"
    ? { id, agentId: owner.id, content: OWNER_TEXT, visibility: "private" }
    : { id, content: OWNER_TEXT });
}

/** Every run result the migration logged (test-only instrumentation). */
function runs(): { processed: number; touchedIds: string[]; unconfirmedIds?: string[] }[] {
  const path = join(pauseDir, "embedding-stamp-runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
const touched = (id: string) => runs().filter((run) => run.touchedIds.includes(id)).length;

const serverLog = () => h.serverLog();

async function expectBoundTo(row: any, text: string, other?: string): Promise<void> {
  expect(row?.embeddingModel).toBe(CURRENT_MODEL_ID);
  expect(row?.embeddedContentHash, "the stored vector is not bound to the expected text").toBe(hashOf(text));
  expect(Array.isArray(row?.embedding) && row.embedding.length > 100, "no server vector stored").toBe(true);
  const own = cosine(row.embedding, await vectorOf(text));
  expect(own, "the stored vector is not the server's vector for the expected text").toBeGreaterThan(0.999);
  if (other !== undefined) expect(own).toBeGreaterThan(cosine(row.embedding, await vectorOf(other)));
}
async function expectStillStale(id: string, content: string): Promise<void> {
  const row = await h.readRow(id);
  expect(row?.content).toBe(content);
  expect(row?.embeddingModel, `${id}: a vector was written`).toBe(STALE_MODEL);
  expect(row?.embedding).toEqual(STALE_EMBEDDING);
}

function cycleCompletedCleanly(migrations: any): boolean {
  if (migrations?.cyclePhase !== "done" || migrations?.lastCycleError) return false;
  return Array.isArray(migrations?.migrations) && migrations.migrations.length > 0 &&
    migrations.migrations.every((m: any) => m?.state === "completed");
}
async function waitForCycleDone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await h.admin("GET", "/HealthDetail");
    if (res.ok && cycleCompletedCleanly((await res.json() as any)?.migrations)) return true;
    await Bun.sleep(100);
  }
  return false;
}
/** Poll until the embedding-stamp migration is reported halted with a reason containing `reason`. */
async function waitForHalt(reason: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await h.admin("GET", "/HealthDetail");
    if (res.ok) {
      const ms = (await res.json() as any)?.migrations?.migrations;
      if (Array.isArray(ms) && ms.some((m: any) => m?.id === "embedding-stamp" && m?.state === "halted" && String(m?.reason ?? "").includes(reason))) return true;
    }
    await Bun.sleep(100);
  }
  return false;
}
async function waitForRun(predicate: (run: { processed: number; touchedIds: string[]; unconfirmedIds?: string[] }) => boolean, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runs().some(predicate)) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function boot(extraEnv: Record<string, string> = {}): Promise<void> {
  h.harper = await startHarper({
    homeDir: home, cwd: component.dir, harperBinDir: component.sourceRoot, ...(installDir ? { installDir } : {}),
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir, ...extraEnv },
  });
  h.assertOwnInstance();
  installDir = h.harper.installDir;
}
/** Insert `rows`, stop, arm `first` and boot again: the boot cycle pauses at the
 *  first row's first point. */
async function seedAndReboot(rows: Record<string, unknown>[], first: string, extraEnv: Record<string, string> = {}): Promise<void> {
  // Armed before the insert, so a follow-up cycle that starts before the stop
  // pauses before its commit instead of processing the rows.
  h.arm(first);
  for (const row of rows) await h.seedMemory(row, {});
  await stopHarper(h.harper, { keepInstallDir: true });
  rmSync(join(pauseDir, "embedding-stamp-runs.jsonl"), { force: true });
  h.arm(first);
  await boot(extraEnv);
}
/** Arm `next` (a different point), then release `point`. A point is never
 *  re-armed while it is paused: arming clears that pause's markers. */
async function handOff(point: string, next?: string): Promise<void> {
  expect(next, "a point cannot be armed while it is paused").not.toBe(point);
  if (next) h.arm(next);
  await h.release(point);
}
/** Release `point`, then arm it again. Only where the migration cannot reach the
 *  point again within the owner budget (its request waits on a held id). */
async function releaseAndRearm(point: string): Promise<void> {
  await h.release(point);
  h.arm(point);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478s3-stamp-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478s3-stamp-pause-"));
  component = composeTracedComponent();
  h = new RaceHarness(pauseDir);
  await boot();
  expect(await waitForCycleDone(90_000), "the first boot cycle did not finish").toBe(true);
  await h.seedAgent(owner);
  for (const text of [ORIGINAL, OWNER_TEXT, EDITED]) await vectorOf(text);
}, 240_000);

afterAll(async () => {
  if (h?.harper) await stopHarper(h.harper).catch(() => {});
  if (installDir) rmSync(installDir, { recursive: true, force: true, maxRetries: 4 });
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  component?.cleanup();
}, HARPER_STOP_BUDGET_MS);


describe("flair#2478 — the migration's HTTP delegation holds the id's lock through its commit (real Harper)", () => {
  it("held after staging, after confirmation and after commit: owner PUT, PATCH and DELETE are refused; DELETEs after the release leave no row; drift stores only the current text's vector", async () => {
    // a1 contention; a2-a4 DELETE at each held point; a5 drift after staging;
    // a6 drift before the request; a7 uncontended control.
    const ids = ["esl-a1", "esl-a2", "esl-a3", "esl-a4", "esl-a5", "esl-a6", "esl-a7"];
    await seedAndReboot(ids.map((id) => staleRow(id)), STAGED);

    // a1: an owner PUT and PATCH at each held point.
    for (const [point, next] of [[STAGED, CONFIRMED], [CONFIRMED, COMMITTED], [COMMITTED, STAGED]] as const) {
      await h.assertPaused(point);
      for (const verb of ["PUT", "PATCH"] as const) {
        const body = await expectRefused(await ownerWrite(verb, "esl-a1", OWNER_TEXT), "memory_busy");
        expect(body).toEqual({ error: "memory_busy", caller: owner.id });
      }
      const held = await h.readRow("esl-a1");
      expect(held.content).toBe(ORIGINAL);
      expect(held.visibility).toBe("shared");
      if (point === COMMITTED) await expectBoundTo(held, ORIGINAL);
      else expect(held.embeddingModel, `${point}: committed before its commit`).toBe(STALE_MODEL);
      await handOff(point, next);
    }

    // a2: DELETE after staging. a1's request has returned.
    await h.assertPaused(STAGED);
    h.expectIncrementalWrites("esl-a1", HTTP_WRITER);
    const put = await ownerWrite("PUT", "esl-a1", OWNER_TEXT);
    expect(put.status, await put.clone().text()).toBe(200);
    const afterPut = await h.readRow("esl-a1");
    expect(afterPut.content).toBe(OWNER_TEXT);
    expect(afterPut.visibility).toBe("private");
    await expectBoundTo(afterPut, OWNER_TEXT);
    const patch = await h.signed(owner, "PATCH", memPath("esl-a1"), { content: EDITED, visibility: "shared" });
    expect(patch.status, await patch.clone().text()).toBe(204);
    const afterPatch = await h.readRow("esl-a1");
    expect(afterPatch.content).toBe(EDITED);
    expect(afterPatch.visibility).toBe("shared");

    // The request holds the id past the DELETE's wait budget: the DELETE is
    // refused and changes nothing. Once the next row reaches `next`, this row's
    // request has answered, and a DELETE leaves no row.
    const deleteAt = async (id: string, point: string, next: string) => {
      await h.assertPaused(point);
      const before = await h.readRow(id);
      const body = await expectRefused(await h.signed(owner, "DELETE", memPath(id)), "memory_busy");
      expect(body).toEqual({ error: "memory_busy", caller: owner.id });
      expect(await h.readRow(id), `${id}: the refused DELETE changed the row`).toEqual(before);
      await handOff(point, next);
      await h.assertPaused(next);
      await expectBoundTo(await h.readRow(id), ORIGINAL);
      const del = await h.signed(owner, "DELETE", memPath(id));
      expect(del.status, await del.clone().text()).toBe(200);
      expect(await h.readRow(id)).toBeNull();
    };
    await deleteAt("esl-a2", STAGED, GATE);
    // a3: DELETE after confirmation.
    await handOff(GATE, CONFIRMED);
    await deleteAt("esl-a3", CONFIRMED, GATE);
    // a4: DELETE after commit, before unlock.
    await handOff(GATE, COMMITTED);
    await deleteAt("esl-a4", COMMITTED, STAGED);
    for (const id of ["esl-a2", "esl-a3", "esl-a4"]) expect(await h.readRow(id), `${id}: a row exists after the DELETE`).toBeNull();

    // a5: the text changes after the request staged its write; nothing is written.
    await h.assertPaused(STAGED);
    await h.rawUpdate("esl-a5", { content: EDITED });
    await handOff(STAGED, GATE);
    // a6: the text changes after the migration's scan, before its request.
    await h.assertPaused(GATE);
    await expectStillStale("esl-a5", EDITED);
    await h.rawUpdate("esl-a6", { content: EDITED });
    await h.release(GATE);

    // a7 runs uncontended; a5 is re-embedded on a later batch.
    expect(await waitForCycleDone(90_000), "the cycle did not finish").toBe(true);
    await expectBoundTo(await h.readRow("esl-a6"), EDITED, ORIGINAL);
    await expectBoundTo(await h.readRow("esl-a7"), ORIGINAL);
    await expectBoundTo(await h.readRow("esl-a5"), EDITED, ORIGINAL);
    expect(runs()[0]).toEqual({ processed: 6, touchedIds: ["esl-a1", "esl-a2", "esl-a3", "esl-a4", "esl-a6", "esl-a7"] });
    expect(runs()[1]).toEqual({ processed: 1, touchedIds: ["esl-a5"] });
    for (const id of ["esl-a1", "esl-a2", "esl-a3", "esl-a4", "esl-a5", "esl-a6", "esl-a7"]) h.expectIncrementalWrites(id, HTTP_WRITER);
    for (const id of ["esl-a2", "esl-a3", "esl-a4"]) expect(await h.readRow(id)).toBeNull();
  }, 300_000);

  it("owner first: a held id refuses the migration's request, the owner's values stand and the row is not counted", async () => {
    const ids = ["esl-b1", "esl-b2", "esl-b3", "esl-b4"];
    await seedAndReboot(ids.map((id) => staleRow(id)), GATE);

    // b1, b2: an owner PUT / PATCH holds the id when the migration's request arrives.
    for (const [id, verb, point] of [["esl-b1", "PUT", "memory-put"], ["esl-b2", "PATCH", "memory-patch"]] as const) {
      await h.assertPaused(GATE);
      h.arm(point);
      const pendingOwner = ownerWrite(verb, id, OWNER_TEXT);
      try {
        await h.assertPaused(point);
        // The request waits out its budget on the held id, so the gate can be
        // armed again after this release.
        await releaseAndRearm(GATE);
        // The next row reached the gate, so this row's request was answered.
        await h.assertPaused(GATE);
        expect(h.writesBy(id, HTTP_WRITER), `${id}: the refused request wrote`).toEqual([]);
        const refused = `[embedding-stamp] ${id}: the re-embed request was refused 503 memory_busy`;
        expect(await h.waitForLog(refused), `the refusal of ${id} was not logged within 30s: ${refused}`).toBe(true);
        expect(serverLog()).toContain(refused);
        expect((await h.readRow(id)).content).toBe(ORIGINAL);
        await h.release(point);
      } finally {
        h.letGo(point);
      }
      const res = await pendingOwner;
      expect(res.status, await res.clone().text()).toBe(verb === "PUT" ? 200 : 204);
      const row = await h.readRow(id);
      expect(row.content).toBe(OWNER_TEXT);
      expect(row.visibility).toBe("private");
      await expectBoundTo(row, OWNER_TEXT, ORIGINAL);
    }

    // b3: the owner's PUT commits after the scan; the request plans from the
    // owner's committed row.
    const put = await ownerWrite("PUT", "esl-b3", OWNER_TEXT);
    expect(put.status, await put.clone().text()).toBe(200);
    await handOff(GATE, STAGED);
    await h.assertPaused(STAGED);
    await handOff(STAGED, GATE);
    await h.assertPaused(GATE);
    const b3 = await h.readRow("esl-b3");
    expect(b3.content).toBe(OWNER_TEXT);
    expect(b3.visibility).toBe("private");
    await expectBoundTo(b3, OWNER_TEXT, ORIGINAL);
    h.expectIncrementalWrites("esl-b3", HTTP_WRITER);

    // b4: an unreadable post-commit read. The request answers
    // write_outcome_unknown, the row is not counted, and the id is fenced.
    await handOff(GATE, "memory-reembed-verify");
    await h.assertPaused("memory-reembed-verify");
    writeFileSync(join(pauseDir, "arm.memory-get-fail.esl-b4"), "");
    await h.release("memory-reembed-verify");
    expect(await waitForCycleDone(90_000), "the cycle did not finish").toBe(true);
    const unreadable = "[embedding-stamp] esl-b4: the re-embed request was refused 503 write_outcome_unknown";
    expect(await h.waitForLog(unreadable), `the unreadable-read refusal was not logged within 30s: ${unreadable}`).toBe(true);
    expect(serverLog()).toContain(unreadable);
    await expectRefused(await ownerWrite("PUT", "esl-b4", OWNER_TEXT), "write_outcome_unknown");
    expect(runs()[0]).toEqual({ processed: 1, touchedIds: ["esl-b3"] });
    for (const id of ["esl-b1", "esl-b2", "esl-b4"]) expect(touched(id), `${id} was counted`).toBe(0);
  }, 300_000);
});

describe("flair#2478 — the migration's `.content`-suffix fallback writes under the id's lock (real Harper)", () => {
  it("held after staging, after confirmation and after commit: a write naming the id is refused; deletes leave no row; drift, a held id and an unknown outcome are not counted", async () => {
    // c1 contention; c2-c4 delete at each held point; c5 drift after staging;
    // c6 drift after the vector, before the lock; c7 unreadable post-commit
    // read; c8 the id held by another writer; c9 uncontended control.
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"].map((n) => `esl-${n}.content`);
    await seedAndReboot(ids.map((id) => staleRow(id)), S_STAGED);
    const [c1, c2, c3, c4, c5, c6, c7, c8, c9] = ids;

    // c1: a PUT and a PATCH naming the id at each held point.
    for (const [point, next] of [[S_STAGED, S_CONFIRMED], [S_CONFIRMED, S_COMMITTED], [S_COMMITTED, S_STAGED]] as const) {
      await h.assertPaused(point);
      for (const verb of ["PUT", "PATCH"] as const) {
        // The busy refusal carries the code and the caller's id, nothing else.
        const body = await expectRefused(await suffixWrite(verb, c1), "memory_busy");
        expect(body, `${verb} at ${point}`).toEqual({ error: "memory_busy", caller: h.harper.admin.username });
      }
      const held = await h.readRow(c1);
      expect(held.content).toBe(ORIGINAL);
      if (point === S_COMMITTED) await expectBoundTo(held, ORIGINAL);
      else expect(held.embeddingModel, `${point}: committed before its commit`).toBe(STALE_MODEL);
      await handOff(point, next);
    }

    // c2: a lock-bypassing delete after staging. c1 has returned.
    await h.assertPaused(S_STAGED);
    h.expectIncrementalWrites(c1, SUFFIX_WRITER);
    // With the id free, the same writes are refused by the id guard and write nothing.
    for (const verb of ["PUT", "PATCH"] as const) {
      const res = await suffixWrite(verb, c1);
      expect(res.status, await res.clone().text()).toBe(400);
    }
    const c1Row = await h.readRow(c1);
    expect(c1Row.content).toBe(ORIGINAL);
    await expectBoundTo(c1Row, ORIGINAL);

    const deleteAt = async (id: string, point: string, next: string) => {
      await h.assertPaused(point);
      await h.ops({ operation: "delete", database: "flair", table: "Memory", ids: [id] });
      expect(await h.readRow(id)).toBeNull();
      await handOff(point, next);
    };
    await deleteAt(c2, S_STAGED, S_GATE);
    // c3: delete after confirmation.
    await handOff(S_GATE, S_CONFIRMED);
    await deleteAt(c3, S_CONFIRMED, S_GATE);
    // c4: delete after commit, before unlock.
    await handOff(S_GATE, S_COMMITTED);
    await deleteAt(c4, S_COMMITTED, S_STAGED);
    for (const id of [c2, c3, c4]) expect(await h.readRow(id), `${id}: a row exists after the delete`).toBeNull();

    // c5: the text changes after the write was staged.
    await h.assertPaused(S_STAGED);
    await h.rawUpdate(c5, { content: EDITED });
    await handOff(S_STAGED, S_GATE);
    // c6: the text changes after the vector was computed, before the lock.
    await h.assertPaused(S_GATE);
    await expectStillStale(c5, EDITED);
    await h.rawUpdate(c6, { content: EDITED });
    await handOff(S_GATE, S_VERIFY);

    // c7: an unreadable post-commit read leaves the row uncounted.
    await h.assertPaused(S_VERIFY);
    await expectStillStale(c6, EDITED);
    expect(h.writesBy(c6, SUFFIX_WRITER), "the changed row was written").toEqual([]);
    writeFileSync(join(pauseDir, `arm.memory-get-fail.${c7}`), "");
    await handOff(S_VERIFY, S_GATE);

    // c8: another writer holds the id when the fallback tries its lock.
    await h.assertPaused(S_GATE);
    const unconfirmedC7 = `[embedding-stamp] ${c7}: the content-suffix re-embed did not confirm its committed row; outcome: unconfirmed`;
    expect(await h.waitForLog(unconfirmedC7), `the unconfirmed outcome of ${c7} was not logged within 30s: ${unconfirmedC7}`).toBe(true);
    expect(serverLog()).toContain(unconfirmedC7);
    h.arm("memory-patch-entry");
    const holder = suffixWrite("PATCH", c8);
    try {
      await h.assertPaused("memory-patch-entry");
      await h.release(S_GATE);
      const busyC8 = `[embedding-stamp] ${c8}: the per-id write lock answered busy`;
      expect(await h.waitForLog(busyC8), `the held retry of ${c8} was not logged as busy within 30s: ${busyC8}`).toBe(true);
      expect(serverLog()).toContain(busyC8);
      expect(h.writesBy(c8, SUFFIX_WRITER), "the fallback wrote a held id").toEqual([]);
      await expectStillStale(c8, ORIGINAL);
      await h.release("memory-patch-entry");
    } finally {
      h.letGo("memory-patch-entry");
    }
    expect((await holder).status).toBe(400);

    // c9 runs uncontended; c5, c6 and c8 are re-embedded on later batches.
    expect(await waitForCycleDone(90_000), "the cycle did not finish").toBe(true);
    await expectBoundTo(await h.readRow(c9), ORIGINAL);
    await expectBoundTo(await h.readRow(c5), EDITED, ORIGINAL);
    await expectBoundTo(await h.readRow(c6), EDITED, ORIGINAL);
    await expectBoundTo(await h.readRow(c8), ORIGINAL);
    // c3's row was deleted after its confirmation, and c7's post-commit read
    // was unreadable: neither is counted as done, and both are reported by id
    // (flair#2840).
    expect(runs()[0]).toEqual({ processed: 3, touchedIds: [c1, c4, c9], unconfirmedIds: [c3, c7] });
    for (const id of [c5, c6, c8]) expect(touched(id), `${id} was not counted exactly once`).toBe(1);
    expect(touched(c7), "the unconfirmed row was counted").toBe(0);
    for (const id of [c1, c5, c6, c8, c9]) h.expectIncrementalWrites(id, SUFFIX_WRITER);
  }, 300_000);

  it("a row with an empty owner, text changed between the fallback's confirmation and its commit: its retry stores the new text's vector, never the old", async () => {
    // An empty owner stores a null text hash, which passes the migration's hash
    // comparison for any text: the retry compares the stored vector with the one
    // its unconfirmed attempt staged and, on a match beside the changed text,
    // re-embeds the current text.
    const e1 = "esl-e1.content";
    await seedAndReboot([staleRow(e1, { agentId: "" })], S_CONFIRMED);
    await h.assertPaused(S_CONFIRMED);
    await h.rawUpdate(e1, { content: EDITED });
    await h.release(S_CONFIRMED);
    expect(await waitForCycleDone(90_000), "the cycle did not finish").toBe(true);
    const row = await h.readRow(e1);
    expect(row.content).toBe(EDITED);
    expectEmptyOwnerVector(row, CURRENT_MODEL_ID, await vectorOf(EDITED), await vectorOf(ORIGINAL));
    expect(touched(e1), `${e1} was not counted exactly once`).toBe(1);
    h.expectIncrementalWrites(e1, SUFFIX_WRITER);
    expect(h.writesBy(e1, SUFFIX_WRITER), "the fallback did not write the new text's vector after its own").toHaveLength(2);
  }, 300_000);

  it("after an attempt committed and its read-back did not show the write, a held id on the retry is logged as an unknown outcome, not as nothing written", async () => {
    // Attempt 1 commits after the text changed in its confirmation-to-commit
    // window, so its read-back is readable but does not show the write. The
    // retry computes the new text's vector; a write naming the id then holds it
    // when the retry tries its lock.
    const f1 = "esl-f1.content";
    const holderPoint = "memory-patch-entry";
    await seedAndReboot([staleRow(f1)], S_CONFIRMED);
    let holder: Promise<Response> | undefined;
    try {
      await h.assertPaused(S_CONFIRMED);
      await h.rawUpdate(f1, { content: EDITED });
      // Attempt 1 has passed the pre-lock point; this arms the retry's.
      h.arm(S_GATE);
      await h.release(S_CONFIRMED);
      await h.assertPaused(S_GATE);
      h.arm(holderPoint);
      holder = suffixWrite("PATCH", f1);
      await h.assertPaused(holderPoint);
      await h.release(S_GATE);
      const line = `[embedding-stamp] ${f1}: the per-id write lock answered busy; this attempt wrote nothing, but an earlier attempt's write was not confirmed, so the outcome is unknown`;
      expect(await h.waitForLog(line), "the held retry was not logged as an unknown outcome").toBe(true);
      const unconfirmedF1 = `[embedding-stamp] ${f1}: the content-suffix re-embed did not confirm its committed row; outcome: unconfirmed`;
      expect(await h.waitForLog(unconfirmedF1), `the unconfirmed outcome of ${f1} was not logged within 30s: ${unconfirmedF1}`).toBe(true);
      expect(serverLog()).toContain(unconfirmedF1);
      expect(serverLog()).not.toContain(`[embedding-stamp] ${f1}: the per-id write lock answered busy; nothing was written`);
      // Only attempt 1 wrote, and the row was not counted.
      expect(h.writesBy(f1, SUFFIX_WRITER)).toHaveLength(1);
      await h.release(holderPoint);
    } finally {
      h.letGo(S_CONFIRMED);
      h.letGo(S_GATE);
      h.letGo(holderPoint);
    }
    expect((await holder!).status).toBe(400);
    // The row is still stale (the old text's hash beside the new text); a later
    // batch of the cycle re-embeds and counts it.
    expect(await waitForCycleDone(90_000), "the cycle did not finish").toBe(true);
    await expectBoundTo(await h.readRow(f1), EDITED, ORIGINAL);
    expect(touched(f1), `${f1} was not counted exactly once`).toBe(1);
    h.expectIncrementalWrites(f1, SUFFIX_WRITER);
    expect(h.writesBy(f1, SUFFIX_WRITER)).toHaveLength(2);
  }, 300_000);

  it("after an attempt committed and its read-back did not show the write, a retry whose fresh read throws logs the unconfirmed outcome once, and the error still halts the migration", async () => {
    // Attempt 1 commits after the text changed in its confirmation-to-commit
    // window and reads its row back (a readable mismatch) while still holding
    // the lock. The retry's fresh read of the row is armed to throw.
    const f2 = "esl-f2.content";
    const readFault = join(pauseDir, `arm.memory-get-fail.${f2}`);
    await seedAndReboot([staleRow(f2)], S_CONFIRMED);
    try {
      await h.assertPaused(S_CONFIRMED);
      await h.rawUpdate(f2, { content: EDITED });
      await handOff(S_CONFIRMED, S_COMMITTED);
      await h.assertPaused(S_COMMITTED);
      writeFileSync(readFault, "");
      await h.release(S_COMMITTED);
      // The read failure propagates as before: run() throws and the runner halts the migration.
      expect(await waitForHalt("run() threw mid-batch: test component: forced Memory read failure", 60_000), "the migration did not halt on the retry's read failure").toBe(true);
      expect(existsSync(readFault), "the retry's fresh read was not attempted").toBe(false);
    } finally {
      h.letGo(S_CONFIRMED);
      h.letGo(S_COMMITTED);
      rmSync(readFault, { force: true });
    }
    const line = `[embedding-stamp] ${f2}: the content-suffix re-embed did not confirm its committed row; outcome: unconfirmed`;
    expect(await h.waitForLog(line), `the unconfirmed outcome of ${f2} was not logged within 30s: ${line}`).toBe(true);
    expect(serverLog().split(line).length - 1, "the unconfirmed outcome was not logged exactly once").toBe(1);
    expect(h.writesBy(f2, SUFFIX_WRITER)).toHaveLength(1);
    expect(touched(f2), `${f2} was counted`).toBe(0);
    // The halted row is not left for the next case's boot.
    await h.ops({ operation: "delete", database: "flair", table: "Memory", ids: [f2] });
  }, 300_000);
});

describe("flair#2478 — the migration under the locked-provider bound (real Harper)", () => {
  it("the HTTP delegation is refused memory_provider_timeout and writes nothing; the fallback computes its vector before the lock", async () => {
    await seedAndReboot([staleRow("esl-d1"), staleRow("esl-d2.content")], GATE, { FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS: "1" });
    await h.assertPaused(GATE);
    await h.release(GATE);
    expect(await waitForRun((run) => run.touchedIds.includes("esl-d2.content")), "the fallback row was not counted").toBe(true);
    await expectBoundTo(await h.readRow("esl-d2.content"), ORIGINAL);
    h.expectIncrementalWrites("esl-d2.content", SUFFIX_WRITER);
    const refused = "[embedding-stamp] esl-d1: the re-embed request was refused 503 memory_provider_timeout";
    expect(await h.waitForLog(refused), `the provider-timeout refusal of esl-d1 was not logged within 30s: ${refused}`).toBe(true);
    expect(serverLog()).toContain(refused);
    await expectStillStale("esl-d1", ORIGINAL);
    expect(touched("esl-d1")).toBe(0);
  }, 240_000);
});
