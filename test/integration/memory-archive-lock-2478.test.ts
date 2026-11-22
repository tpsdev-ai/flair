/**
 * memory-archive-lock-2478.test.ts — flair#2478 part 3a, real Harper: the
 * archive (POST /MemoryArchive, basement and restore) writes through the
 * checked PUT under the per-id lock it holds, and the checked write refuses a
 * token that is not live for its store and ids.
 *
 * Cases:
 *  - basement and restore controls: the write is one Memory `put` traced under
 *    the archive's lock phase, with its archive fields; the vector is kept and
 *    no pointer field is written;
 *  - each action held at `memory-locked-staged` (staged, before the commit) and
 *    at `memory-locked-committed` (committed, before the confirmation), against
 *    an owner PUT and PATCH: the owner write is refused `503 memory_busy`, and
 *    the archive's fields are stored and confirmed;
 *  - basement of a successor while its predecessor is held (an owner PUT of the
 *    predecessor is refused, the archive closes it under the lock), and
 *    basement then restore of a row with a host pointer (the pointer row and
 *    its binding are unchanged);
 *  - through the built app (a test-only probe resource,
 *    test/fixtures/checked-write-probe-2478/probe.js): a checked write on a
 *    live token succeeds; a checked patch is staged in the scope's
 *    transaction, confirmed while the lock is held, and rolled back when the
 *    scope refuses after it staged; one with a revoked token, one naming an id
 *    the token does not hold, and one with a token from a second copy of the
 *    lock module (another registry) are refused, and nothing is written.
 *
 * Seeded rows carry an explicit visibility, an incarnation token and a current
 * stamp, so boot migrations leave them alone. Home-isolated ephemeral Harper;
 * every URL is asserted to be this test's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent, expectRefused, newAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";

const owner = newAgent("mal2478-owner");
const SEED_MODEL_ID = stripEnginePrefix(getModelId());
const ORIGINAL = "the original note about the harbour crane's inspection roster";
const OWNER_TEXT = "an owner edit about the ferry terminal's new ticket hall";
const PROBE_TEXT = "a probe edit about the lighthouse keeper's storm log";
const ARCHIVED_AT = "2026-01-02T03:04:05.000Z";
const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
const POINTER_FIELDS = ["hostSource", "hostSourceScope", "hostSourceVisibility"];

let component: ProbeComponent;
let home: string;
let pauseDir: string;
let h: RaceHarness;
let vector: number[];

type Action = "basement" | "restore";

function seed(id: string, action: Action, extra: Record<string, unknown> = {}): Promise<void> {
  const archived = action === "restore" ? { archived: true, archivedAt: ARCHIVED_AT, archivedBy: owner.id } : { archived: false };
  return h.seedMemory({ id, agentId: owner.id, content: ORIGINAL, embedding: vector, ...archived, ...extra }, { embeddingModel: SEED_MODEL_ID });
}
function archive(id: string, action: Action): Promise<Response> {
  return h.signed(owner, "POST", "/MemoryArchive", { id, action });
}
function ownerWrite(verb: "PUT" | "PATCH", id: string): Promise<Response> {
  return verb === "PUT"
    ? h.signed(owner, "PUT", memPath(id), { agentId: owner.id, content: OWNER_TEXT, visibility: "shared", durability: "standard" })
    : h.signed(owner, "PATCH", memPath(id), { content: OWNER_TEXT });
}
function probe(body: Record<string, unknown>): Promise<any> {
  return h.admin("POST", "/CheckedWriteProbe2478", body).then(async (res) => {
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    return JSON.parse(text);
  });
}

/** The archive answered 200 with the PUT's own answer, and the row holds the action's archive fields. */
async function expectArchived(res: Response, id: string, action: Action): Promise<any> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  expect(JSON.parse(text)).toEqual({ id, written: true, deduplicated: false, visibility: "shared" });
  const row = await h.readRow(id);
  expect(row?.content, "the archive's row lost its content").toBe(ORIGINAL);
  if (action === "basement") {
    expect(row.archived).toBe(true);
    expect(row.archivedBy).toBe(owner.id);
    expect(typeof row.archivedAt).toBe("string");
  } else {
    expect(row.archived).toBe(false);
    expect(row.archivedAt ?? null).toBeNull();
    expect(row.archivedBy ?? null).toBeNull();
  }
  return row;
}

/** The traced Memory writes of `id` made under a lock are one `put` by the
 *  archive's lock phase. (An owner HTTP PUT is also traced, as `unattributed`,
 *  where Harper dispatches it, before the verb takes the lock.) */
function expectArchiveWrite(id: string, action: Action): string[] {
  const writes = h.trace(id).filter((w) => w.writer !== "unattributed");
  expect(writes.map((w) => `${w.writer}:${w.method}`)).toEqual([`archive-${action}:put`]);
  return writes[0].fields;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478s1c-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478s1c-pause-"));
  component = composeTracedComponent();
  const resources = join(component.dir, "dist", "resources");
  copyFileSync(join(import.meta.dir, "..", "fixtures", "checked-write-probe-2478", "probe.js"), join(resources, "zz-checked-write-probe-2478.js"));
  copyFileSync(join(resources, "memory-write-lock.js"), join(resources, "zz-memory-write-lock-copy-2478.js"));
  h = new RaceHarness(pauseDir);
  h.harper = await startHarper({
    homeDir: home, cwd: component.dir, harperBinDir: component.sourceRoot,
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  h.assertOwnInstance();
  await h.seedAgent(owner);
  vector = await h.serverEmbedding(ORIGINAL);
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

describe("flair#2478 part 3a — the archive writes under its held lock (real Harper)", () => {
  for (const action of ["basement", "restore"] as const) {
    it(`CONTROL ${action}: one checked put of the archive fields under phase archive-${action}; vector kept, no pointer field`, async () => {
      const id = `mal-control-${action}`;
      await seed(id, action);
      const row = await expectArchived(await archive(id, action), id, action);
      expect(row.embedding, "the archive changed the stored vector").toEqual(vector);
      const fields = expectArchiveWrite(id, action);
      expect(fields).toContain("archived");
      expect(fields).toContain("embedding");
      for (const field of ["archivedAt", "archivedBy"]) {
        if (action === "basement") expect(fields).toContain(field);
        else expect(fields).not.toContain(field);
      }
      for (const field of POINTER_FIELDS) expect(fields).not.toContain(field);
      // The lock is released: the owner writes again.
      expect((await ownerWrite("PATCH", id)).status).toBe(204);
    }, 120_000);

    for (const point of ["memory-locked-staged", "memory-locked-committed"]) {
      for (const verb of ["PUT", "PATCH"] as const) {
        it(`${action} held at ${point} refuses an owner ${verb} memory_busy; the archive's fields are stored and confirmed`, async () => {
          const id = `mal-${action}-${point}-${verb.toLowerCase()}`;
          await seed(id, action);
          h.arm(point);
          const pending = archive(id, action);
          try {
            await h.assertPaused(point);
            const body = await expectRefused(await ownerWrite(verb, id), "memory_busy");
            expect(body).toEqual({ error: "memory_busy", caller: owner.id });
            await h.release(point);
          } finally {
            h.letGo(point);
          }
          await expectArchived(await pending, id, action);
          expectArchiveWrite(id, action);
        }, 120_000);
      }
    }
  }
});

describe("flair#2478 part 3a — archiving a successor and a pointer-bearing row (real Harper)", () => {
  it("basement of a successor holds its predecessor: an owner PUT of it is refused memory_busy, and the archive closes it under the lock", async () => {
    const predecessor = "mal-sup-predecessor";
    const successor = "mal-sup-successor";
    await seed(predecessor, "basement");
    await seed(successor, "basement", { supersedes: predecessor });
    h.arm("memory-locked-staged");
    const pending = archive(successor, "basement");
    try {
      await h.assertPaused("memory-locked-staged");
      const body = await expectRefused(await ownerWrite("PUT", predecessor), "memory_busy");
      expect(body).toEqual({ error: "memory_busy", caller: owner.id });
      await h.release("memory-locked-staged");
    } finally {
      h.letGo("memory-locked-staged");
    }
    const stored = await expectArchived(await pending, successor, "basement");
    expect(stored.supersedes).toBe(predecessor);
    const closed = await h.readRow(predecessor);
    expect(closed?.content, "the owner PUT of the predecessor landed").toBe(ORIGINAL);
    expect(typeof closed?.validTo, "the predecessor was not closed").toBe("string");
    expect(closed.validTo).toBe(stored.validFrom);
    expect(h.writesBy(predecessor, "archive-basement").map((w) => w.method), "the close was not written under the archive's lock").toEqual(["put"]);
  }, 120_000);

  it("basement then restore of a row with a host pointer leaves the stored pointer row and its binding unchanged", async () => {
    const id = "mal-pointer";
    await seed(id, "basement");
    const memory = await h.readRow(id);
    const pointer = {
      memoryId: id,
      hostSource: JSON.stringify({ v: 1, host: "openclaw", kind: "run", id: "run-mal2478", url: "https://host.example/path?a=1#frag" }),
      scopeAtWrite: "shared",
      authorId: owner.id,
      memoryInstanceToken: memory.instanceToken,
      receivedAt: new Date().toISOString(),
    };
    await h.ops({ operation: "insert", database: "flair", table: "MemoryHostSource", records: [pointer] });
    const readPointer = async () => {
      const rows = await h.ops({ operation: "search_by_id", database: "flair", table: "MemoryHostSource", ids: [id], get_attributes: ["*"] });
      return Array.isArray(rows) ? rows[0] ?? null : rows;
    };
    const before = await readPointer();
    expect(before).toMatchObject(pointer);
    for (const action of ["basement", "restore"] as const) {
      await expectArchived(await archive(id, action), id, action);
      expect(await readPointer(), `the pointer row changed on ${action}`).toEqual(before);
      expect((await h.readRow(id))?.instanceToken, `the row no longer binds its pointer after ${action}`).toBe(pointer.memoryInstanceToken);
    }
  }, 120_000);
});

describe("flair#2478 part 3a — checked writes through the built app (real Harper)", () => {
  it("CONTROL: a checked put on a live token for its id commits and is confirmed", async () => {
    const id = "mal-probe-control";
    await seed(id, "basement");
    const result = await probe({ op: "control", id, text: PROBE_TEXT });
    expect(result.lock).toBe("done");
    expect(result.scope).toBe("committed");
    expect(result.confirmed).toEqual([{ id, written: true, deduplicated: false, visibility: "shared" }]);
    expect((await h.readRow(id))?.content).toBe(PROBE_TEXT);
    expect(h.writesBy(id, "checked-write-probe").map((w) => w.method)).toEqual(["put"]);
  }, 120_000);

  it("CONTROL: a checked patch stages in the scope, commits, and is confirmed while the lock is held", async () => {
    const id = "mal-probe-patch";
    await seed(id, "basement");
    h.arm("memory-locked-committed");
    const pending = probe({ op: "patch-commit", id, text: PROBE_TEXT });
    try {
      await h.assertPaused("memory-locked-committed");
      // Committed, confirmation not yet run: the id is still held.
      const body = await expectRefused(await ownerWrite("PATCH", id), "memory_busy");
      expect(body).toEqual({ error: "memory_busy", caller: owner.id });
      await h.release("memory-locked-committed");
    } finally {
      h.letGo("memory-locked-committed");
    }
    const result = await pending;
    expect(result).toMatchObject({ lock: "done", scope: "committed", confirmed: 1, receipt: "staged", duringScope: ORIGINAL });
    expect((await h.readRow(id))?.content).toBe(PROBE_TEXT);
  }, 120_000);

  it("a checked patch whose scope refuses after it staged is rolled back", async () => {
    const id = "mal-probe-patch-abort";
    await seed(id, "basement");
    const result = await probe({ op: "patch-abort", id, text: PROBE_TEXT });
    expect(result).toMatchObject({ lock: "done", scope: "refused", refusedStatus: 409, receipt: "staged", duringScope: ORIGINAL });
    expect((await h.readRow(id))?.content, "the refused scope's staged patch landed").toBe(ORIGINAL);
  }, 120_000);

  it("a revoked token (its acquisition settled) is refused and nothing is written", async () => {
    const id = "mal-probe-revoked";
    await seed(id, "basement");
    expect(await probe({ op: "revoked", id, text: PROBE_TEXT })).toEqual({ refused: "revoked" });
    expect((await h.readRow(id))?.content).toBe(ORIGINAL);
    expect(h.trace(id)).toEqual([]);
  }, 120_000);

  it("a token for another id is refused, the scope aborts, and neither row is written", async () => {
    const id = "mal-probe-held";
    const otherId = "mal-probe-other";
    await seed(id, "basement");
    await seed(otherId, "basement");
    expect(await probe({ op: "wrong-id", id, otherId, text: PROBE_TEXT })).toEqual({
      write: { refused: "id_not_covered" },
      scope: { refused: "id_not_covered" },
    });
    expect((await h.readRow(otherId))?.content).toBe(ORIGINAL);
    expect(h.trace(otherId)).toEqual([]);
    expect(h.trace(id)).toEqual([]);
  }, 120_000);

  it("a token from a second copy of the lock module (another registry) is refused", async () => {
    const id = "mal-probe-foreign";
    await seed(id, "basement");
    expect(await probe({ op: "foreign-registry", id, text: PROBE_TEXT })).toEqual({
      scope: { refused: "not_a_token" },
      write: { refused: "not_a_token" },
    });
    expect((await h.readRow(id))?.content).toBe(ORIGINAL);
    expect(h.trace(id)).toEqual([]);
  }, 120_000);
});
