/**
 * reembed-lock-2478.test.ts — flair#2478 slice 3 (embeddings): the HTTP
 * re-embed (`PATCH /Memory/<id>` with `{"embedding": null, "embeddingModel":
 * null}`, resources/Memory.ts) against owner writes of the same id, real Harper.
 *
 * The re-embed holds the id's per-id Memory write lock (phase `patch-reembed`)
 * from its first stored read through its owned transaction's commit and its
 * post-commit verification. It writes only `embedding`, `embeddingModel`,
 * `updatedAt` and `embeddedContentHash`, plus `instanceToken` on a legacy row
 * that has none, as an incremental update (asserted from the real-Harper write
 * trace, the legacy row included). Each attempt re-reads the committed row inside
 * its own transaction and embeds the stored text. A text change seen at that
 * read recomputes the vector (at most 3 attempts in all, then `409
 * reembed_row_changed` when no attempt has committed); a change visible at the
 * confirmation after staging aborts that attempt, which writes nothing, and
 * answers `409 stored_row_changed` when no attempt has committed; a change committed
 * after that confirmation, before the commit, is seen only by the post-commit
 * read-back, which on a readable mismatch retries from a fresh read within the
 * same 3 attempts (recomputing for the changed text) and on the last attempt
 * answers `503 write_outcome_unknown`; an unreadable read-back answers `503
 * write_outcome_unknown`. Once an attempt's commit has resolved and no
 * read-back has shown the write (its read-back mismatched, or a step after the
 * commit threw), every exit of the request other than a later verified success
 * answers `503 write_outcome_unknown` and fences the id: both 409s above, a
 * provider timeout on the retry, and a thrown error such as the write-stamp
 * notifier's after a later commit, except a retry that finds the row gone,
 * which answers 404. A `200`
 * answer means the read-back showed the vector beside the text it was computed
 * from; a lock-bypassing write committed after that final read-back is not seen
 * by the request.
 *
 * The matrix:
 *  - re-embed first, held after staging, after its confirmation, and after its
 *    commit while still locked: an owner PUT and PATCH are refused `503
 *    memory_busy`; after release the owner's content and visibility are stored;
 *  - owner first (PUT, PATCH): the re-embed is refused `503 memory_busy` while
 *    the owner holds the id through the re-embed's wait budget (the owner is
 *    held at a pause point); a re-embed that waits inside its budget plans from
 *    the owner's committed row;
 *  - an owner DELETE at each held point is refused `503 memory_busy` and the
 *    row is unchanged; after the re-embed answers, a DELETE leaves no row; a
 *    DELETE that read the row first holds the id (the re-embed is refused
 *    `503 memory_busy` and writes nothing) and leaves no row;
 *  - text drift before the vector, after staging and in the confirmation-to-
 *    commit window; an uncontended positive control; an unreadable post-commit
 *    read (`503 write_outcome_unknown`, the id is fenced); a retry's provider
 *    call that outlasts its bound after an attempt committed unconfirmed (`503
 *    write_outcome_unknown`, the id is fenced); a later attempt whose write-stamp
 *    notifier throws after its commit, after an attempt committed unconfirmed
 *    (`503 write_outcome_unknown`, the id is fenced); a provider call that
 *    outlasts its bound on the first attempt (`503 memory_provider_timeout`,
 *    nothing written).
 *
 * Seeded rows carry an explicit visibility, an incarnation token and the
 * current model's bare stamp, so the boot migrations leave them alone.
 * Home-isolated ephemeral Harper; every URL is asserted to be this test's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { LEGACY_REEMBED_UPDATE_FIELDS, RaceHarness, composeTracedComponent, cosine, expectEmptyOwnerVector, expectRefused, newAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";
import { computeContentHash } from "../../resources/memory-feed-lib.ts";

const owner = newAgent("rl2478-owner");
const CURRENT_MODEL_ID = getModelId();
const SEED_MODEL_ID = stripEnginePrefix(CURRENT_MODEL_ID);
const STALE_EMBEDDING = [0.01, 0.02, 0.03];
const ORIGINAL = "the original note about pruning the apple trees before the spring frost";
const OWNER_TEXT = "an owner edit about the harbour ferry timetable and its winter schedule";
const EDITED = "a lock-bypassing edit about orbital telemetry windows and launch margins";
const WRITER = "patch-reembed";
const hashOf = (text: string) => computeContentHash(owner.id, text);

const STAGED = "memory-reembed-staged";
const CONFIRMED = "memory-reembed-commit";
const COMMITTED = "memory-patch-committed";
const HELD_POINTS = [
  [STAGED, "after staging"],
  [CONFIRMED, "after its confirmation, before its commit"],
  [COMMITTED, "after its commit, before unlock"],
] as const;
const VERBS = ["PUT", "PATCH"] as const;

let component: ProbeComponent;
let home: string;
let pauseDir: string;
let h: RaceHarness;
const vectors = new Map<string, number[]>();
async function vectorOf(text: string): Promise<number[]> {
  if (!vectors.has(text)) vectors.set(text, await h.serverEmbedding(text));
  return vectors.get(text)!;
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
function seed(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  return h.seedMemory({ id, agentId: owner.id, content: ORIGINAL, ...extra }, { embedding: STALE_EMBEDDING, embeddingModel: SEED_MODEL_ID });
}
function reembed(id: string): Promise<Response> {
  return h.signed(owner, "PATCH", memPath(id), { embedding: null, embeddingModel: null });
}
function ownerWrite(verb: "PUT" | "PATCH", id: string, content: string): Promise<Response> {
  return verb === "PUT"
    ? h.signed(owner, "PUT", memPath(id), { agentId: owner.id, content, visibility: "private", durability: "standard" })
    : h.signed(owner, "PATCH", memPath(id), { content, visibility: "private" });
}
const ownerSuccess = (verb: "PUT" | "PATCH") => (verb === "PUT" ? 200 : 204);

/** The stored row holds the server's vector for `text` and its binding. */
async function expectBoundTo(row: any, text: string, other?: string): Promise<void> {
  expect(row?.embeddingModel).toBe(CURRENT_MODEL_ID);
  expect(row?.embeddedContentHash, "the stored vector is not bound to the expected text").toBe(hashOf(text));
  expect(Array.isArray(row?.embedding) && row.embedding.length > 100, "no server vector stored").toBe(true);
  const own = cosine(row.embedding, await vectorOf(text));
  expect(own, "the stored vector is not the server's vector for the expected text").toBeGreaterThan(0.999);
  if (other !== undefined) expect(own).toBeGreaterThan(cosine(row.embedding, await vectorOf(other)));
}

async function bootHarper(extraEnv: Record<string, string> = {}, installDir?: string): Promise<void> {
  h.harper = await startHarper({
    homeDir: home, cwd: component.dir, harperBinDir: component.sourceRoot, ...(installDir ? { installDir } : {}),
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir, ...extraEnv },
  });
  h.assertOwnInstance();
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478s3-reembed-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478s3-reembed-pause-"));
  component = composeTracedComponent();
  h = new RaceHarness(pauseDir);
  await bootHarper();
  await h.seedAgent(owner);
  // Warm the engine once so a writer released inside another's budget embeds well within it.
  await vectorOf(ORIGINAL);
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

describe("flair#2478 — the HTTP re-embed holds the id's lock through its commit (real Harper)", () => {
  it("CONTROL: an uncontended re-embed stores the vector for the stored text with one incremental update", async () => {
    const id = "rl2478-control";
    await seed(id);
    const res = await reembed(id);
    expect(res.status, await res.clone().text()).toBe(200);
    const answered = await res.json();
    const row = await h.readRow(id);
    expect(answered).toEqual({ id, updatedAt: row.updatedAt });
    expect(row.content).toBe(ORIGINAL);
    expect(row.visibility).toBe("shared");
    expect(row.durability).toBe("standard");
    await expectBoundTo(row, ORIGINAL);
    h.expectIncrementalWrites(id, WRITER);
    expect(h.writesBy(id, WRITER)).toHaveLength(1);
  }, 120_000);

  it("a legacy row with no instanceToken: the re-embed's one incremental update names the embedding fields and the token it gives the row", async () => {
    const id = "rl2478-legacy-token";
    await seed(id, { instanceToken: undefined });
    expect((await h.readRow(id))?.instanceToken ?? null, "the seeded row carries a token").toBeNull();
    const res = await reembed(id);
    expect(res.status, await res.clone().text()).toBe(200);
    const row = await h.readRow(id);
    expect(await res.json()).toEqual({ id, updatedAt: row.updatedAt });
    expect(typeof row.instanceToken === "string" && row.instanceToken.length > 0, "the legacy row was not given a token").toBe(true);
    expect(row.content).toBe(ORIGINAL);
    expect(row.visibility).toBe("shared");
    await expectBoundTo(row, ORIGINAL);
    h.expectIncrementalWrites(id, WRITER, LEGACY_REEMBED_UPDATE_FIELDS);
    expect(h.writesBy(id, WRITER)).toHaveLength(1);
  }, 120_000);

  for (const [point, label] of HELD_POINTS) {
    for (const verb of VERBS) {
      it(`re-embed first, held ${label}: an owner ${verb} is refused memory_busy, then the owner's values are stored`, async () => {
        const id = `rl2478-bg-${point}-${verb}`.toLowerCase();
        await seed(id);
        h.arm(point);
        const pending = reembed(id);
        try {
          await h.assertPaused(point);
          const body = await expectRefused(await ownerWrite(verb, id, OWNER_TEXT), "memory_busy");
          expect(body).toEqual({ error: "memory_busy", caller: owner.id });
          const held = await h.readRow(id);
          expect(held.content, "the owner write landed while the re-embed held the id").toBe(ORIGINAL);
          expect(held.visibility).toBe("shared");
          // The re-embed commits before it releases the id: its vector is stored
          // at the after-commit point and not before.
          if (point === COMMITTED) await expectBoundTo(held, ORIGINAL);
          else expect(held.embeddingModel, `${point}: the re-embed committed before its commit`).toBe(SEED_MODEL_ID);
          await h.release(point);
        } finally {
          h.letGo(point);
        }
        const res = await pending;
        expect(res.status, await res.clone().text()).toBe(200);
        const answered = await res.json();
        const reembedded = await h.readRow(id);
        expect(answered).toEqual({ id, updatedAt: reembedded.updatedAt });
        expect(reembedded.content).toBe(ORIGINAL);
        expect(reembedded.visibility).toBe("shared");
        await expectBoundTo(reembedded, ORIGINAL);
        h.expectIncrementalWrites(id, WRITER);

        const ok = await ownerWrite(verb, id, OWNER_TEXT);
        expect(ok.status, await ok.clone().text()).toBe(ownerSuccess(verb));
        const stored = await h.readRow(id);
        expect(stored.content, "the owner's content is not stored").toBe(OWNER_TEXT);
        expect(stored.visibility, "the owner's visibility is not stored").toBe("private");
        expect(stored.embeddedContentHash).toBe(hashOf(OWNER_TEXT));
      }, 120_000);
    }
  }
});

describe("flair#2478 — an owner write that holds the id first (real Harper)", () => {
  for (const verb of VERBS) {
    it(`owner ${verb} first: the re-embed is refused memory_busy, the owner's values stand, and a later re-embed binds the owner's text`, async () => {
      const id = `rl2478-owner-first-${verb}`.toLowerCase();
      const point = verb === "PUT" ? "memory-put" : "memory-patch";
      await seed(id);
      h.arm(point);
      const pendingOwner = ownerWrite(verb, id, OWNER_TEXT);
      try {
        await h.assertPaused(point);
        const body = await expectRefused(await reembed(id), "memory_busy");
        expect(body).toEqual({ error: "memory_busy", caller: owner.id });
        expect(h.writesBy(id, WRITER), "the refused re-embed wrote").toEqual([]);
        await h.release(point);
      } finally {
        h.letGo(point);
      }
      const ownerRes = await pendingOwner;
      expect(ownerRes.status, await ownerRes.clone().text()).toBe(ownerSuccess(verb));
      const edited = await h.readRow(id);
      expect(edited.content).toBe(OWNER_TEXT);
      expect(edited.visibility).toBe("private");

      const res = await reembed(id);
      expect(res.status, await res.clone().text()).toBe(200);
      const stored = await h.readRow(id);
      expect(stored.content, "the re-embed reverted the owner's content").toBe(OWNER_TEXT);
      expect(stored.visibility, "the re-embed reverted the owner's visibility").toBe("private");
      await expectBoundTo(stored, OWNER_TEXT, ORIGINAL);
      h.expectIncrementalWrites(id, WRITER);
    }, 120_000);
  }

  it("a re-embed that waits inside its budget plans from the owner's committed row", async () => {
    const id = "rl2478-owner-first-wait";
    const point = "memory-put-committed";
    await seed(id);
    h.arm(point);
    const pendingOwner = ownerWrite("PUT", id, OWNER_TEXT);
    let pendingReembed: Promise<Response> | undefined;
    try {
      await h.assertPaused(point);
      // The owner PUT has committed and still holds the id: the re-embed waits.
      pendingReembed = reembed(id);
      await Bun.sleep(300);
      expect((await h.readRow(id)).content).toBe(OWNER_TEXT);
      expect(h.writesBy(id, WRITER), "the re-embed wrote while the owner held the id").toEqual([]);
      await h.release(point);
    } finally {
      h.letGo(point);
    }
    expect((await pendingOwner).status).toBe(200);
    const res = await pendingReembed!;
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await h.readRow(id);
    expect(stored.content).toBe(OWNER_TEXT);
    expect(stored.visibility).toBe("private");
    await expectBoundTo(stored, OWNER_TEXT, ORIGINAL);
  }, 120_000);
});

describe("flair#2478 — an owner DELETE racing the re-embed never leaves a row (real Harper)", () => {
  for (const [point, label] of HELD_POINTS) {
    it(`a DELETE while the re-embed is held ${label} is refused memory_busy; after the re-embed answers, a DELETE leaves no row`, async () => {
      const id = `rl2478-delete-${point}`;
      await seed(id);
      h.arm(point);
      const pending = reembed(id);
      try {
        await h.assertPaused(point);
        // The re-embed holds the id past the DELETE's wait budget.
        const before = await h.readRow(id);
        const body = await expectRefused(await h.signed(owner, "DELETE", memPath(id)), "memory_busy");
        expect(body).toEqual({ error: "memory_busy", caller: owner.id });
        expect(await h.readRow(id), "the refused DELETE changed the row").toEqual(before);
        await h.release(point);
      } finally {
        h.letGo(point);
      }
      const res = await pending;
      expect(res.status, await res.clone().text()).toBe(200);
      await expectBoundTo(await h.readRow(id), ORIGINAL);
      const del = await h.signed(owner, "DELETE", memPath(id));
      expect(del.status, await del.clone().text()).toBe(200);
      expect(await h.readRow(id)).toBeNull();
      await Bun.sleep(250);
      expect(await h.readRow(id), "a row exists after the DELETE answered success").toBeNull();
    }, 120_000);
  }

  it("a DELETE that read the row before the re-embed committed still leaves no row", async () => {
    const id = "rl2478-delete-first";
    await seed(id);
    h.arm("memory-delete");
    const pendingDelete = h.signed(owner, "DELETE", memPath(id));
    try {
      await h.assertPaused("memory-delete");
      // The DELETE holds the id from its first read: the re-embed waits out its
      // budget, is refused and writes nothing.
      const before = await h.readRow(id);
      const body = await expectRefused(await reembed(id), "memory_busy");
      expect(body).toEqual({ error: "memory_busy", caller: owner.id });
      expect(h.writesBy(id, WRITER), "the refused re-embed wrote").toEqual([]);
      expect(await h.readRow(id), "the refused re-embed changed the row").toEqual(before);
      await h.release("memory-delete");
    } finally {
      h.letGo("memory-delete");
    }
    const del = await pendingDelete;
    expect(del.status, await del.clone().text()).toBe(200);
    await Bun.sleep(250);
    expect(await h.readRow(id), "a row exists after the DELETE answered success").toBeNull();
    expect(h.writesBy(id, WRITER), "the re-embed wrote the deleted id").toEqual([]);
  }, 120_000);
});

describe("flair#2478 — a re-embed racing a text change at the tested points (after its first read, after staging, between its confirmation and its commit, an empty-owner row): the final read-back finds the new text's vector or the write is refused (real Harper)", () => {
  it("text changed after the re-embed's first read, before its vector: the vector for the new text is stored", async () => {
    const id = "rl2478-drift-plan";
    const point = "memory-reembed";
    await seed(id);
    h.arm(point);
    const pending = reembed(id);
    try {
      await h.assertPaused(point);
      await h.rawUpdate(id, { content: EDITED });
      await h.release(point);
    } finally {
      h.letGo(point);
    }
    const res = await pending;
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await h.readRow(id);
    expect(stored.content).toBe(EDITED);
    await expectBoundTo(stored, EDITED, ORIGINAL);
    h.expectIncrementalWrites(id, WRITER);
  }, 120_000);

  it("text changed after the re-embed staged its write: 409 stored_row_changed and the stale vector is not written", async () => {
    const id = "rl2478-drift-staged";
    await seed(id);
    h.arm(STAGED);
    const pending = reembed(id);
    try {
      await h.assertPaused(STAGED);
      await h.rawUpdate(id, { content: EDITED });
      await h.release(STAGED);
    } finally {
      h.letGo(STAGED);
    }
    const res = await pending;
    const text = await res.text();
    expect(res.status, text).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    const stored = await h.readRow(id);
    expect(stored.content).toBe(EDITED);
    expect(stored.embeddingModel, "the stale re-embed's stamp landed").toBe(SEED_MODEL_ID);
    expect(stored.embedding).toEqual(STALE_EMBEDDING);
    expect(stored.embeddedContentHash ?? null).toBeNull();
  }, 120_000);

  it("text changed between the re-embed's confirmation and its commit: the answered vector is the new text's", async () => {
    const id = "rl2478-drift-gap";
    await seed(id);
    h.arm(CONFIRMED);
    const pending = reembed(id);
    try {
      await h.assertPaused(CONFIRMED);
      await h.rawUpdate(id, { content: EDITED });
      await h.release(CONFIRMED);
    } finally {
      h.letGo(CONFIRMED);
    }
    const res = await pending;
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await h.readRow(id);
    expect(stored.content).toBe(EDITED);
    await expectBoundTo(stored, EDITED, ORIGINAL);
    h.expectIncrementalWrites(id, WRITER);
  }, 120_000);

  it("a row with an empty owner, text changed between the re-embed's confirmation and its commit: the answered vector is the new text's", async () => {
    // An empty owner stores no text hash; the re-embed binds its vector by the
    // stored text it re-reads, never by that hash. An administrator re-embeds it.
    const id = "rl2478-drift-gap-no-owner";
    await seed(id, { agentId: "" });
    h.arm(CONFIRMED);
    const pending = h.admin("PATCH", memPath(id), { embedding: null, embeddingModel: null });
    try {
      await h.assertPaused(CONFIRMED);
      await h.rawUpdate(id, { content: EDITED });
      await h.release(CONFIRMED);
    } finally {
      h.letGo(CONFIRMED);
    }
    const res = await pending;
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await h.readRow(id);
    expect(await res.json()).toEqual({ id, updatedAt: stored.updatedAt });
    expect(stored.content).toBe(EDITED);
    expectEmptyOwnerVector(stored, CURRENT_MODEL_ID, await vectorOf(EDITED), await vectorOf(ORIGINAL));
    h.expectIncrementalWrites(id, WRITER);
  }, 120_000);
});

describe("flair#2478 — the re-embed's unknown and bounded outcomes (real Harper)", () => {
  it("an unreadable post-commit read answers write_outcome_unknown, and later owner writes of the id are refused", async () => {
    const id = "rl2478-unknown";
    const point = "memory-reembed-verify";
    await seed(id);
    h.arm(point);
    const pending = reembed(id);
    try {
      await h.assertPaused(point);
      writeFileSync(join(pauseDir, `arm.memory-get-fail.${id}`), "");
      await h.release(point);
    } finally {
      h.letGo(point);
    }
    const body = await expectRefused(await pending, "write_outcome_unknown");
    expect(body.outcome).toBe("unconfirmed");
    for (const [verb, send] of [
      ["PUT", () => ownerWrite("PUT", id, OWNER_TEXT)],
      ["PATCH", () => ownerWrite("PATCH", id, OWNER_TEXT)],
      ["DELETE", () => h.signed(owner, "DELETE", memPath(id))],
      ["re-embed", () => reembed(id)],
    ] as const) {
      const res = await send();
      const text = await res.text();
      expect(res.status, `${verb}: ${text}`).toBe(503);
      expect(JSON.parse(text).error, verb).toBe("write_outcome_unknown");
    }
    expect((await h.readRow(id)).content).toBe(ORIGINAL);
  }, 120_000);

  it("after an attempt committed and its read-back did not show the write, a provider timeout on the retry answers write_outcome_unknown and fences the id", async () => {
    // Attempt 1 commits after the text changed in its confirmation-to-commit
    // window, so its read-back is readable but does not show the write. The
    // retry recomputes for the new text, and that provider call is held inside
    // its bound (the default bound, under the suite's boot) until it is refused.
    const id = "rl2478-unknown-after-timeout";
    const recompute = "memory-reembed-recompute";
    await seed(id);
    h.arm(CONFIRMED);
    h.arm(recompute);
    const pending = reembed(id);
    try {
      await h.assertPaused(CONFIRMED);
      await h.rawUpdate(id, { content: EDITED });
      await h.release(CONFIRMED);
      await h.assertPaused(recompute);
      const res = await pending;
      const text = await res.text();
      expect(res.status, text).toBe(503);
      // The same body the last attempt's unconfirmed outcome answers.
      expect(JSON.parse(text)).toEqual({
        error: "write_outcome_unknown",
        outcome: "unconfirmed",
        message: "the write outcome is unknown. Read the affected row before writing again.",
      });
    } finally {
      h.letGo(CONFIRMED);
      h.letGo(recompute);
    }
    const logged = `[reembed] ${id}: a committed attempt's write is not confirmed; this attempt ended with memory_provider_timeout; outcome: unconfirmed`;
    expect(await h.waitForLog(logged), `the server log did not record the unconfirmed provider-timeout outcome within 30s: ${logged}`).toBe(true);
    expect(h.serverLog()).toContain(logged);
    // Attempt 1's write landed: the row holds the old text's vector beside the new text.
    const stored = await h.readRow(id);
    expect(stored.content).toBe(EDITED);
    await expectBoundTo(stored, ORIGINAL, EDITED);
    h.expectIncrementalWrites(id, WRITER);
    expect(h.writesBy(id, WRITER)).toHaveLength(1);
    // The id is fenced, as after any unconfirmed outcome.
    const res = await ownerWrite("PUT", id, OWNER_TEXT);
    const body = await res.text();
    expect(res.status, body).toBe(503);
    expect(JSON.parse(body).error).toBe("write_outcome_unknown");
  }, 150_000);

  it("after an attempt committed and its read-back did not show the write, a later attempt whose write-stamp notifier throws after its commit answers write_outcome_unknown and fences the id", async () => {
    // Attempt 1 commits after the text changed in its confirmation-to-commit
    // window and waits before its read-back, which then does not show the
    // write. The retry recomputes for the new text and commits; the
    // embedding-space notifier that runs after that commit is armed to throw.
    const id = "rl2478-unknown-after-notifier";
    const verify = "memory-reembed-verify";
    const fault = join(pauseDir, "arm.guard-stamp-fail");
    await seed(id);
    h.arm(CONFIRMED);
    h.arm(verify);
    const pending = reembed(id);
    try {
      await h.assertPaused(CONFIRMED);
      await h.rawUpdate(id, { content: EDITED });
      await h.release(CONFIRMED);
      // Attempt 1 has committed and notified; the next notification is the retry's.
      await h.assertPaused(verify);
      writeFileSync(fault, "");
      await h.release(verify);
      const res = await pending;
      const text = await res.text();
      expect(res.status, text).toBe(503);
      expect(JSON.parse(text)).toEqual({
        error: "write_outcome_unknown",
        outcome: "unconfirmed",
        message: "the write outcome is unknown. Read the affected row before writing again.",
      });
      expect(existsSync(fault), "the notifier fault was not consumed").toBe(false);
    } finally {
      h.letGo(CONFIRMED);
      h.letGo(verify);
      rmSync(fault, { force: true });
    }
    const logged = `[reembed] ${id}: a committed attempt's write is not confirmed; the call ended with an error (Error); outcome: unconfirmed`;
    expect(await h.waitForLog(logged), `the server log did not record the unconfirmed notifier-failure outcome within 30s: ${logged}`).toBe(true);
    expect(h.serverLog()).toContain(logged);
    // The retry's write landed before its notifier threw.
    const stored = await h.readRow(id);
    expect(stored.content).toBe(EDITED);
    await expectBoundTo(stored, EDITED, ORIGINAL);
    h.expectIncrementalWrites(id, WRITER);
    expect(h.writesBy(id, WRITER)).toHaveLength(2);
    // The id is fenced, as after any unconfirmed outcome.
    const res = await ownerWrite("PUT", id, OWNER_TEXT);
    const body = await res.text();
    expect(res.status, body).toBe(503);
    expect(JSON.parse(body).error).toBe("write_outcome_unknown");
  }, 120_000);

  it("a provider call that outlasts its bound under the lock is refused memory_provider_timeout and writes nothing", async () => {
    const installDir = h.harper.installDir;
    await stopHarper(h.harper, { keepInstallDir: true });
    await bootHarper({ FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS: "1" }, installDir);
    const id = "rl2478-provider-timeout";
    await seed(id);
    const body = await expectRefused(await reembed(id), "memory_provider_timeout");
    expect(body.message).toContain("nothing was written");
    const stored = await h.readRow(id);
    expect(stored.embeddingModel).toBe(SEED_MODEL_ID);
    expect(stored.embedding).toEqual(STALE_EMBEDDING);
    expect(h.writesBy(id, WRITER)).toEqual([]);
    // The refusal released the id: a metadata-only owner PATCH (no provider
    // call) is not held off.
    const patch = await h.signed(owner, "PATCH", memPath(id), { visibility: "private" });
    expect(patch.status, await patch.clone().text()).toBe(204);
    expect((await h.readRow(id)).visibility).toBe("private");
  }, 180_000);
});
