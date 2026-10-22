/**
 * auto-embed-lock-2478.test.ts — flair#2478 slice 3 (embeddings): the auth
 * middleware's embedding backfill (resources/auth-middleware.ts
 * `backfillEmbedding`, started by the middleware's post-response hook after a
 * successful Memory write signed by a verified Ed25519 agent) against owner
 * writes of the same id, real Harper.
 *
 * The backfill reads the row and computes its vector with no lock held, then
 * takes the id's per-id Memory write lock (phase `auto-embed`): one
 * non-waiting acquisition per attempt, and a retry acquires it again. A held
 * id, or an id with an unresolved write outcome, is skipped and logged.
 * Holding the lock, the shared write-back helper's first read is the committed
 * row: a row that already holds a full vector is not written, and a row whose
 * text changed is not written (the backfill releases the lock, re-reads and
 * re-embeds, at most 3 attempts). It stages an incremental update of `embedding`,
 * `embeddingModel` and `embeddedContentHash` (asserted from the real-Harper
 * write trace), confirms the committed row, commits, and reads the committed
 * row back (identity, the written fields, and the text the vector was computed
 * from) before the release.
 *
 * The matrix: backfill first, held after staging, after its confirmation and
 * after its commit while still locked, against an owner PUT and PATCH (refused
 * `503 memory_busy`; after release the owner's content and visibility are
 * stored); owner first (PUT and PATCH hold the id: the backfill is skipped; an
 * owner write committed while the vector was computed: the backfill writes
 * nothing over it); an owner DELETE at each held point and a DELETE that read
 * the row first (no row remains); text drift before the lock, after staging and
 * in the confirmation-to-commit window (only the current text's vector is
 * stored); an uncontended control; an unreadable read-back (logged; the id is
 * not fenced); an id fenced by an owner write's unknown outcome (skipped); the
 * locked-provider bound (the backfill computes its vector before the lock).
 *
 * The backfill is triggered by a metadata-only owner PATCH (no text change, so
 * the PATCH itself embeds nothing) on a row whose stored vector is short. A
 * valid Basic-admin Memory write returns from the middleware before that hook
 * and starts no backfill (pinned below, beside a signed write of the same row
 * that does).
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
import { RaceHarness, composeTracedComponent, cosine, expectEmptyOwnerVector, expectRefused, newAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";
import { computeContentHash } from "../../resources/memory-feed-lib.ts";

const owner = newAgent("ael2478-owner");
// An administrator agent (Ed25519): the only HTTP writer that passes this
// middleware's backfill for a row with an empty owner.
const adminAgent = newAgent("ael2478-admin");
const CURRENT_MODEL_ID = getModelId();
const SEED_MODEL_ID = stripEnginePrefix(CURRENT_MODEL_ID);
const SHORT_EMBEDDING = [0.1, 0.1, 0.1];
const ORIGINAL = "the original note about the community orchard's grafting workshop";
const OWNER_TEXT = "an owner edit about the river ferry's revised winter crossing times";
const EDITED = "a lock-bypassing edit about seismograph calibration and station drift";
const WRITER = "auto-embed";
const FIELDS = ["embedding", "embeddedContentHash", "embeddingModel"];
const hashOf = (text: string) => computeContentHash(owner.id, text);

const ENTRY = "backfill-embedding-entry";
const STAGED = "backfill-embedding-staged";
const CONFIRMED = "backfill-embedding-commit";
const COMMITTED = "backfill-embedding-committed";
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
let triggers = 0;
const vectors = new Map<string, number[]>();
async function vectorOf(text: string): Promise<number[]> {
  if (!vectors.has(text)) vectors.set(text, await h.serverEmbedding(text));
  return vectors.get(text)!;
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
function seed(id: string): Promise<void> {
  return h.seedMemory({ id, agentId: owner.id, content: ORIGINAL }, { embedding: SHORT_EMBEDDING, embeddingModel: SEED_MODEL_ID });
}
/** A metadata-only owner PATCH: it embeds nothing, and its success starts the backfill for `id`. */
async function trigger(id: string): Promise<void> {
  const res = await h.signed(owner, "PATCH", memPath(id), { subject: `trigger-${++triggers}` });
  expect(res.status, await res.clone().text()).toBe(204);
}
function ownerWrite(verb: "PUT" | "PATCH", id: string, content: string): Promise<Response> {
  return verb === "PUT"
    ? h.signed(owner, "PUT", memPath(id), { agentId: owner.id, content, visibility: "private", durability: "standard" })
    : h.signed(owner, "PATCH", memPath(id), { content, visibility: "private" });
}
const ownerSuccess = (verb: "PUT" | "PATCH") => (verb === "PUT" ? 200 : 204);

async function expectBoundTo(row: any, text: string, other?: string): Promise<void> {
  expect(row?.embeddingModel).toBe(CURRENT_MODEL_ID);
  expect(row?.embeddedContentHash, "the stored vector is not bound to the expected text").toBe(hashOf(text));
  expect(Array.isArray(row?.embedding) && row.embedding.length > 100, "no server vector stored").toBe(true);
  const own = cosine(row.embedding, await vectorOf(text));
  expect(own, "the stored vector is not the server's vector for the expected text").toBeGreaterThan(0.999);
  if (other !== undefined) expect(own).toBeGreaterThan(cosine(row.embedding, await vectorOf(other)));
}
async function expectUnembedded(id: string, content: string): Promise<void> {
  const row = await h.readRow(id);
  expect(row?.content).toBe(content);
  expect(row?.embedding, `${id}: a vector was written`).toEqual(SHORT_EMBEDDING);
  expect(row?.embeddingModel).toBe(SEED_MODEL_ID);
}
/** Poll until the row holds a full vector stamped with the current model. */
async function waitForVector(id: string, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let row = await h.readRow(id);
  while (Date.now() < deadline && !(row?.embeddingModel === CURRENT_MODEL_ID && row?.embedding?.length > 100)) {
    await Bun.sleep(100);
    row = await h.readRow(id);
  }
  return row;
}
/** Arm `next`, then release `point`. */
async function handOff(point: string, next: string): Promise<void> {
  h.arm(next);
  await h.release(point);
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
  home = mkdtempSync(join(tmpdir(), "flair-2478s3-autoembed-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478s3-autoembed-pause-"));
  component = composeTracedComponent();
  h = new RaceHarness(pauseDir);
  await bootHarper();
  // An administrator by its Agent row's role: the middleware decides admin from the
  // Agent row it verifies the signature against (resources/agent-auth.ts agentIsAdmin).
  await h.seedAgent(adminAgent, "admin");
  await h.seedAgent(owner);
  for (const text of [ORIGINAL, OWNER_TEXT, EDITED]) await vectorOf(text);
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

describe("flair#2478 — the auth auto-embed holds the id's lock through its commit (real Harper)", () => {
  it("CONTROL: an uncontended backfill stores the vector for the stored text with one incremental update", async () => {
    const id = "ael-control";
    await seed(id);
    await trigger(id);
    const row = await waitForVector(id);
    expect(row.content).toBe(ORIGINAL);
    expect(row.visibility).toBe("shared");
    await expectBoundTo(row, ORIGINAL);
    h.expectIncrementalWrites(id, WRITER, FIELDS);
    expect(h.writesBy(id, WRITER)).toHaveLength(1);
  }, 120_000);

  for (const [point, label] of HELD_POINTS) {
    for (const verb of VERBS) {
      it(`backfill first, held ${label}: an owner ${verb} is refused memory_busy, then the owner's values are stored`, async () => {
        const id = `ael-bg-${point}-${verb}`.toLowerCase();
        await seed(id);
        h.arm(point);
        await trigger(id);
        try {
          await h.assertPaused(point);
          const body = await expectRefused(await ownerWrite(verb, id, OWNER_TEXT), "memory_busy");
          expect(body).toEqual({ error: "memory_busy", caller: owner.id });
          const held = await h.readRow(id);
          expect(held.content, "the owner write landed while the backfill held the id").toBe(ORIGINAL);
          expect(held.visibility).toBe("shared");
          // The backfill commits before it releases the id.
          if (point === COMMITTED) await expectBoundTo(held, ORIGINAL);
          else await expectUnembedded(id, ORIGINAL);
          await h.release(point);
        } finally {
          h.letGo(point);
        }
        await expectBoundTo(await waitForVector(id), ORIGINAL);
        h.expectIncrementalWrites(id, WRITER, FIELDS);

        const ok = await ownerWrite(verb, id, OWNER_TEXT);
        expect(ok.status, await ok.clone().text()).toBe(ownerSuccess(verb));
        const stored = await h.readRow(id);
        expect(stored.content, "the owner's content is not stored").toBe(OWNER_TEXT);
        expect(stored.visibility, "the owner's visibility is not stored").toBe("private");
        await expectBoundTo(stored, OWNER_TEXT, ORIGINAL);
      }, 120_000);
    }
  }
});

describe("flair#2478 — what starts the backfill (real Harper)", () => {
  it("a Basic-admin Memory write starts no backfill; a signed owner's write of the same row does", async () => {
    // The backfill starts only from the auth middleware's post-response hook,
    // which a Memory write signed by a verified Ed25519 agent reaches; a valid
    // Basic-admin request returns before it (resources/auth-middleware.ts).
    const id = "ael-basic-admin";
    const subject = "a Basic-admin metadata edit";
    await seed(id);
    h.arm(ENTRY);
    try {
      const res = await h.admin("PATCH", memPath(id), { subject });
      expect(res.status, await res.clone().text()).toBe(204);
      expect((await h.readRow(id))?.subject, "the Basic-admin write did not land").toBe(subject);
      // A started backfill claims ENTRY once its vector is computed, as the
      // signed write below does. This one must not.
      const claimed = join(pauseDir, `claimed.${ENTRY}`);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !existsSync(claimed)) await Bun.sleep(100);
      expect(existsSync(claimed), "a Basic-admin write started a backfill").toBe(false);
      expect(h.writesBy(id, WRITER), "a backfill wrote after the Basic-admin write").toEqual([]);
      await expectUnembedded(id, ORIGINAL);

      // The same row, written by its signed owner: the backfill starts.
      await trigger(id);
      await h.assertPaused(ENTRY);
      await h.release(ENTRY);
    } finally {
      h.letGo(ENTRY);
    }
    const row = await waitForVector(id);
    expect(row.content).toBe(ORIGINAL);
    await expectBoundTo(row, ORIGINAL);
    h.expectIncrementalWrites(id, WRITER, FIELDS);
    expect(h.writesBy(id, WRITER)).toHaveLength(1);
  }, 120_000);
});

describe("flair#2478 — owner writes that hold or change the id first (real Harper)", () => {
  for (const verb of VERBS) {
    it(`owner ${verb} holds the id: the backfill is skipped, writes nothing, and the owner's values stand`, async () => {
      const id = `ael-owner-first-${verb}`.toLowerCase();
      const point = verb === "PUT" ? "memory-put" : "memory-patch";
      await seed(id);
      h.arm(ENTRY);
      await trigger(id);
      h.arm(point);
      let pendingOwner: Promise<Response> | undefined;
      try {
        await h.assertPaused(ENTRY);
        pendingOwner = ownerWrite(verb, id, OWNER_TEXT);
        await h.assertPaused(point);
        await h.release(ENTRY);
        expect(await h.waitForLog(`[auto-embed] ${id}: skipped; the per-id write lock answered busy`), "the backfill did not report the held id").toBe(true);
        expect(h.writesBy(id, WRITER), "the backfill wrote a held id").toEqual([]);
        await h.release(point);
      } finally {
        h.letGo(ENTRY);
        h.letGo(point);
      }
      const res = await pendingOwner!;
      expect(res.status, await res.clone().text()).toBe(ownerSuccess(verb));
      const stored = await h.readRow(id);
      expect(stored.content).toBe(OWNER_TEXT);
      expect(stored.visibility).toBe("private");
      await expectBoundTo(stored, OWNER_TEXT, ORIGINAL);
      expect(h.writesBy(id, WRITER)).toEqual([]);
    }, 120_000);
  }

  it("an owner PUT committed while the vector was computed: the backfill re-reads the committed row and writes nothing over it", async () => {
    const id = "ael-owner-committed";
    await seed(id);
    h.arm(ENTRY);
    await trigger(id);
    try {
      await h.assertPaused(ENTRY);
      const put = await ownerWrite("PUT", id, OWNER_TEXT);
      expect(put.status, await put.clone().text()).toBe(200);
      await handOff(ENTRY, COMMITTED);
      await h.assertPaused(COMMITTED);
      const row = await h.readRow(id);
      expect(row.content).toBe(OWNER_TEXT);
      expect(row.visibility).toBe("private");
      await expectBoundTo(row, OWNER_TEXT, ORIGINAL);
      expect(h.writesBy(id, WRITER), "the backfill wrote over the owner's committed row").toEqual([]);
      await h.release(COMMITTED);
    } finally {
      h.letGo(ENTRY);
      h.letGo(COMMITTED);
    }
  }, 120_000);
});

describe("flair#2478 — an owner DELETE racing the backfill never leaves a row (real Harper)", () => {
  for (const [point, label] of HELD_POINTS) {
    it(`a DELETE while the backfill is held ${label} leaves no row`, async () => {
      const id = `ael-delete-${point}`;
      await seed(id);
      h.arm(point);
      await trigger(id);
      try {
        await h.assertPaused(point);
        const del = await h.signed(owner, "DELETE", memPath(id));
        expect(del.status, await del.clone().text()).toBe(200);
        expect(await h.readRow(id)).toBeNull();
        if (point === COMMITTED) {
          await h.release(point);
        } else {
          // The backfill's retry re-reads the absent row and returns through
          // the after-commit point.
          await handOff(point, COMMITTED);
          await h.assertPaused(COMMITTED);
          expect(await h.readRow(id), "the backfill wrote a row after the DELETE").toBeNull();
          await h.release(COMMITTED);
        }
      } finally {
        h.letGo(point);
        h.letGo(COMMITTED);
      }
      await Bun.sleep(250);
      expect(await h.readRow(id), "a row exists after the DELETE answered success").toBeNull();
    }, 120_000);
  }

  it("a DELETE that read the row before the backfill committed still leaves no row", async () => {
    const id = "ael-delete-first";
    await seed(id);
    h.arm("memory-delete");
    const pendingDelete = h.signed(owner, "DELETE", memPath(id));
    try {
      await h.assertPaused("memory-delete");
      // The DELETE holds no per-id lock: the backfill runs to its commit.
      h.arm(COMMITTED);
      await trigger(id);
      await h.assertPaused(COMMITTED);
      await expectBoundTo(await h.readRow(id), ORIGINAL);
      await h.release(COMMITTED);
      await h.release("memory-delete");
    } finally {
      h.letGo(COMMITTED);
      h.letGo("memory-delete");
    }
    const del = await pendingDelete;
    expect(del.status, await del.clone().text()).toBe(200);
    await Bun.sleep(250);
    expect(await h.readRow(id), "a row exists after the DELETE answered success").toBeNull();
  }, 120_000);
});

describe("flair#2478 — the backfill stores a vector only for the text it was computed from (real Harper)", () => {
  for (const [point, label] of [
    [ENTRY, "after its vector, before the lock"],
    [STAGED, "after staging"],
    [CONFIRMED, "between its confirmation and its commit"],
  ] as const) {
    it(`text changed ${label}: the stored vector is the new text's`, async () => {
      const id = `ael-drift-${point}`;
      await seed(id);
      h.arm(point);
      await trigger(id);
      try {
        await h.assertPaused(point);
        await h.rawUpdate(id, { content: EDITED });
        await handOff(point, COMMITTED);
        // The backfill re-reads the new text, re-embeds it with no lock held,
        // and commits that vector.
        await h.assertPaused(COMMITTED);
        const row = await h.readRow(id);
        expect(row.content).toBe(EDITED);
        await expectBoundTo(row, EDITED, ORIGINAL);
        await h.release(COMMITTED);
      } finally {
        h.letGo(point);
        h.letGo(COMMITTED);
      }
      h.expectIncrementalWrites(id, WRITER, FIELDS);
      await Bun.sleep(250);
      await expectBoundTo(await h.readRow(id), EDITED, ORIGINAL);
    }, 120_000);
  }

  it("a row with an empty owner, text changed between its confirmation and its commit: the stored vector is the new text's, never the old", async () => {
    // An empty owner stores a null text hash, which would match any text: the
    // backfill's retry compares the stored vector with the one its unconfirmed
    // attempt staged. No
    // agent owns the row, so an administrator agent's metadata-only PATCH
    // starts the backfill.
    const id = "ael-drift-gap-no-owner";
    await h.seedMemory({ id, agentId: "", content: ORIGINAL }, { embedding: SHORT_EMBEDDING, embeddingModel: SEED_MODEL_ID });
    h.arm(CONFIRMED);
    const res = await h.signed(adminAgent, "PATCH", memPath(id), { subject: `trigger-${++triggers}` });
    expect(res.status, await res.clone().text()).toBe(204);
    try {
      await h.assertPaused(CONFIRMED);
      await h.rawUpdate(id, { content: EDITED });
      await handOff(CONFIRMED, COMMITTED);
      // The read-back finds the text changed; the retry re-reads the row, finds
      // the vector it staged for the old text beside the new text, and re-embeds
      // the new text.
      await h.assertPaused(COMMITTED);
      const row = await h.readRow(id);
      expect(row.content).toBe(EDITED);
      expectEmptyOwnerVector(row, CURRENT_MODEL_ID, await vectorOf(EDITED), await vectorOf(ORIGINAL));
      await h.release(COMMITTED);
    } finally {
      h.letGo(CONFIRMED);
      h.letGo(COMMITTED);
    }
    h.expectIncrementalWrites(id, WRITER, FIELDS);
    expect(h.writesBy(id, WRITER), "the backfill did not write the new text's vector after its own").toHaveLength(2);
    await Bun.sleep(250);
    expectEmptyOwnerVector(await h.readRow(id), CURRENT_MODEL_ID, await vectorOf(EDITED), await vectorOf(ORIGINAL));
  }, 120_000);
});

describe("flair#2478 — the backfill's unknown outcomes and the fence (real Harper)", () => {
  it("an unreadable read-back is logged; the background write does not fence the owner's id", async () => {
    const id = "ael-unknown";
    await seed(id);
    h.arm(CONFIRMED);
    await trigger(id);
    try {
      await h.assertPaused(CONFIRMED);
      writeFileSync(join(pauseDir, `arm.memory-get-fail.${id}`), "");
      await h.release(CONFIRMED);
    } finally {
      h.letGo(CONFIRMED);
    }
    // The backfill logs "[auto-embed] Outcome unconfirmed for <id>: <error>".
    expect(await h.waitForLogMatch(new RegExp(`\\[auto-embed\\][^\\n]*Outcome unconfirmed[^\\n]*${id}`)), "the unconfirmed backfill was not logged").toBe(true);
    const put = await ownerWrite("PUT", id, OWNER_TEXT);
    expect(put.status, await put.clone().text()).toBe(200);
    const stored = await h.readRow(id);
    expect(stored.content).toBe(OWNER_TEXT);
    expect(stored.visibility).toBe("private");
  }, 120_000);

  it("an id an owner write left outcome-unknown is skipped, and nothing is written", async () => {
    const id = "ael-fenced";
    await seed(id);
    h.arm(ENTRY);
    await trigger(id);
    try {
      await h.assertPaused(ENTRY);
      h.arm("memory-put-verify");
      const pendingPut = ownerWrite("PUT", id, OWNER_TEXT);
      await h.assertPaused("memory-put-verify");
      writeFileSync(join(pauseDir, `arm.memory-get-fail.${id}`), "");
      await h.release("memory-put-verify");
      await expectRefused(await pendingPut, "write_outcome_unknown");
      await h.release(ENTRY);
      expect(await h.waitForLog(`[auto-embed] ${id}: skipped; the per-id write lock answered unknown`), "the backfill did not report the fenced id").toBe(true);
    } finally {
      h.letGo(ENTRY);
      h.letGo("memory-put-verify");
    }
    expect(h.writesBy(id, WRITER), "the backfill wrote a fenced id").toEqual([]);
  }, 120_000);

  it("under a 1 ms locked-provider bound the backfill still stores its vector: it is computed before the lock", async () => {
    const installDir = h.harper.installDir;
    await stopHarper(h.harper, { keepInstallDir: true });
    await bootHarper({ FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS: "1" }, installDir);
    const id = "ael-provider-bound";
    await seed(id);
    // The bound is in force: an owner PUT whose text is embedded under the lock is refused.
    await expectRefused(await ownerWrite("PUT", id, OWNER_TEXT), "memory_provider_timeout");
    await expectUnembedded(id, ORIGINAL);
    await trigger(id);
    const row = await waitForVector(id);
    expect(row.content).toBe(ORIGINAL);
    await expectBoundTo(row, ORIGINAL);
    h.expectIncrementalWrites(id, WRITER, FIELDS);
  }, 180_000);
});
