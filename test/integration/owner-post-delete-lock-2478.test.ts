/**
 * owner-post-delete-lock-2478.test.ts — flair#2478 slice 1 part 2: an owner
 * POST and an owner DELETE take the per-id Memory write lock, real Harper.
 *
 * Writers under test: an owner POST that names an id or a `supersedes` target,
 * and an owner DELETE. Each is foreground: it waits within the owner budget
 * and answers `503 memory_busy` on a miss.
 *
 * The matrix: the writer first, held while it still holds the lock, against an
 * owner PUT and PATCH (refused `memory_busy`; after release the writer's write
 * is stored); an owner write first, held after its commit, against the writer
 * (refused `memory_busy`; for the POST with its `supersedes` reference spelled
 * plainly, with a `.agentId` selector and percent-encoded, all of which resolve
 * to the held row); a DELETE of an older skill version, which closes the live
 * head: an uncontended control, the head held by an owner PATCH (refused
 * `memory_busy`, nothing closed), and the head replaced after the DELETE found
 * it (the DELETE locks the new head; replaced on every attempt, it answers
 * `memory_busy`); a lock-bypassing trace assertion that each writer wrote
 * under its phase. Seeded rows carry an
 * explicit visibility, an incarnation token and a bare current stamp so boot
 * migrations leave them alone. Home-isolated ephemeral Harper; every URL is
 * asserted to be this test's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent, expectRefused, newAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";

const owner = newAgent("opdl2478-owner");
const SEED_MODEL_ID = stripEnginePrefix(getModelId());
const ORIGINAL = "the original note about the harbour crane's inspection roster";
const WRITER_TEXT = "a writer edit about the lighthouse keeper's storm log";
const OWNER_TEXT = "an owner edit about the ferry terminal's new ticket hall";
const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

let component: ProbeComponent;
let home: string;
let pauseDir: string;
let h: RaceHarness;

function seed(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  return h.seedMemory({ id, agentId: owner.id, content: ORIGINAL, ...extra }, { embeddingModel: SEED_MODEL_ID });
}
function ownerWrite(verb: "PUT" | "PATCH", id: string, content: string): Promise<Response> {
  return verb === "PUT"
    ? h.signed(owner, "PUT", memPath(id), { agentId: owner.id, content, visibility: "private", durability: "standard" })
    : h.signed(owner, "PATCH", memPath(id), { content, visibility: "private" });
}
const ownerSuccess = (verb: "PUT" | "PATCH") => (verb === "PUT" ? 200 : 204);

/** A short wait: the writer whose pause point we arm must have paused. */
async function paused(point: string): Promise<boolean> {
  return (await h.assertPaused(point, 60_000), true);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478s1b-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478s1b-pause-"));
  component = composeTracedComponent();
  h = new RaceHarness(pauseDir);
  h.harper = await startHarper({
    homeDir: home, cwd: component.dir, harperBinDir: component.sourceRoot,
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  h.assertOwnInstance();
  await h.seedAgent(owner);
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

describe("flair#2478 — owner POST (real Harper)", () => {
  it("CONTROL: a create under an explicit id lands", async () => {
    const id = "opdl-post-control";
    const res = await h.signed(owner, "POST", "/Memory", { id, agentId: owner.id, content: WRITER_TEXT, visibility: "shared" });
    expect([200, 201], await res.clone().text()).toContain(res.status);
    expect((await h.readRow(id))?.content).toBe(WRITER_TEXT);
  }, 120_000);

  for (const verb of ["PUT", "PATCH"] as const) {
    it(`a POST that supersedes a row, held while it holds the lock, refuses an owner ${verb} on that row memory_busy`, async () => {
      const target = `opdl-post-sup-target-${verb.toLowerCase()}`;
      const successor = `opdl-post-sup-new-${verb.toLowerCase()}`;
      await seed(target);
      h.arm("memory-post-verify");
      const pending = h.signed(owner, "POST", "/Memory", {
        id: successor, agentId: owner.id, content: WRITER_TEXT, visibility: "private", supersedes: target,
      });
      try {
        await paused("memory-post-verify");
        const body = await expectRefused(await ownerWrite(verb, target, OWNER_TEXT), "memory_busy");
        expect(body).toEqual({ error: "memory_busy", caller: owner.id });
        await h.release("memory-post-verify");
      } finally {
        h.letGo("memory-post-verify");
      }
      const res = await pending;
      expect([200, 201], await res.clone().text()).toContain(res.status);
      expect((await h.readRow(successor))?.supersedes).toBe(target);
      const closed = await h.readRow(target);
      expect(closed, "the superseded row is gone").not.toBeNull();
      expect(typeof closed.validTo, "the superseded row was not closed").toBe("string");
      expect(h.writesBy(target, "post").length, "the close was not written under phase post").toBeGreaterThan(0);
    }, 120_000);
  }

  // Each spelling resolves to the held row's id (resources/memory-id-guard.ts
  // resolveMemoryReferenceId), the id the POST reads and closes.
  for (const [form, spell] of [
    ["plain", (id: string) => id],
    ["a `.agentId` selector", (id: string) => `${id}.agentId`],
    ["percent-encoded", (id: string) => `${id}%2EagentId`],
  ] as const) {
    it(`an owner PUT of a row, held after its commit, refuses a POST whose supersedes names that row (${form}) memory_busy; then the POST closes it`, async () => {
      const slug = form.split(" ").at(-1)!.replace(/[^a-z]/g, "");
      const target = `opdl-post-owner-first-${slug}`;
      const successor = `opdl-post-owner-first-new-${slug}`;
      await seed(target);
      h.arm("memory-put-committed");
      const pendingOwner = ownerWrite("PUT", target, OWNER_TEXT);
      const post = () => h.signed(owner, "POST", "/Memory", {
        id: successor, agentId: owner.id, content: WRITER_TEXT, visibility: "private", supersedes: spell(target),
      });
      try {
        await paused("memory-put-committed");
        const before = await h.readRow(target);
        const body = await expectRefused(await post(), "memory_busy");
        expect(body).toEqual({ error: "memory_busy", caller: owner.id });
        expect(await h.readRow(successor), "the refused POST created its successor").toBeNull();
        expect(await h.readRow(target), "the refused POST changed the held row").toEqual(before);
        await h.release("memory-put-committed");
      } finally {
        h.letGo("memory-put-committed");
      }
      expect((await pendingOwner).status).toBe(200);
      const res = await post();
      expect([200, 201], await res.clone().text()).toContain(res.status);
      expect((await h.readRow(successor))?.supersedes).toBe(target);
      const closed = await h.readRow(target);
      expect(closed?.content).toBe(OWNER_TEXT);
      expect(typeof closed?.validTo, "the superseded row was not closed").toBe("string");
      expect(h.writesBy(target, "post").length, "the close was not written under phase post").toBeGreaterThan(0);
    }, 120_000);
  }
});

const skillBody = (id: string, content: string) => ({
  id, agentId: owner.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent",
});
/** A skill subject's open versions (no `validTo`). */
async function openVersions(subject: string): Promise<any[]> {
  const rows = await h.ops({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "skillSubjectId", search_value: subject, get_attributes: ["*"],
  });
  return (rows as any[]).filter((row) => row.validTo == null);
}
/** Write a skill version of `subject` with an owner PUT of `at` (the subject's
 *  id for its first version, then its live head); return the new live head's id. */
async function writeSkillVersion(subject: string, at: string, content: string): Promise<string> {
  const res = await h.signed(owner, "PUT", memPath(at), skillBody(at, content));
  expect(res.status, await res.clone().text()).toBe(200);
  const open = await openVersions(subject);
  expect(open.length, `${subject}: not exactly one open version`).toBe(1);
  return String(open[0].id);
}
/** Two versions: `subject` is then an older version and the live head is another row. */
async function seedOlderSkillVersion(subject: string): Promise<string> {
  await writeSkillVersion(subject, subject, "the first version of the tide table procedure");
  const head = await writeSkillVersion(subject, subject, "the second version of the tide table procedure");
  expect(head, "the second version did not get its own row").not.toBe(subject);
  return head;
}
const HEAD_FOUND = ["memory-delete-head-first", "memory-delete-head-second", "memory-delete-head-third"] as const;

describe("flair#2478 — owner DELETE of an older skill version locks the live head it closes (real Harper)", () => {
  it("CONTROL: an uncontended DELETE of an older version closes the live head under phase delete", async () => {
    const stale = "opdl-skill-control";
    const head = await seedOlderSkillVersion(stale);
    const res = await h.signed(owner, "DELETE", memPath(stale));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(typeof (await h.readRow(head))?.validTo, "the live head was not closed").toBe("string");
    expect(await openVersions(stale)).toEqual([]);
    expect(h.writesBy(head, "delete").length, "the close was not written under phase delete").toBeGreaterThan(0);
  }, 120_000);

  it("the live head held by an owner PATCH: the DELETE of an older version is refused memory_busy and closes nothing; after the release it closes the head", async () => {
    const stale = "opdl-skill-head-held";
    const head = await seedOlderSkillVersion(stale);
    h.arm("memory-patch-entry");
    const holder = h.signed(owner, "PATCH", memPath(head), { subject: "a metadata edit while the DELETE runs" });
    try {
      await paused("memory-patch-entry");
      const before = [await h.readRow(stale), await h.readRow(head)];
      const body = await expectRefused(await h.signed(owner, "DELETE", memPath(stale)), "memory_busy");
      expect(body).toEqual({ error: "memory_busy", caller: owner.id });
      expect([await h.readRow(stale), await h.readRow(head)], "the refused DELETE changed a version").toEqual(before);
      expect(h.writesBy(head, "delete"), "the refused DELETE wrote the head").toEqual([]);
      await h.release("memory-patch-entry");
    } finally {
      h.letGo("memory-patch-entry");
    }
    // A PATCH of a skill row is refused by the skill-write guard and writes nothing.
    const held = await holder;
    const heldText = await held.text();
    expect(held.status, heldText).toBe(400);
    expect(JSON.parse(heldText).error).toBe("skill_write_path");
    const res = await h.signed(owner, "DELETE", memPath(stale));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(typeof (await h.readRow(head))?.validTo, "the live head was not closed").toBe("string");
    expect(await openVersions(stale)).toEqual([]);
  }, 120_000);

  it("a head replaced after the DELETE found it: the DELETE locks the new head, which an owner PATCH holds, and is refused memory_busy", async () => {
    const stale = "opdl-skill-head-moved";
    const found = await seedOlderSkillVersion(stale);
    for (const point of HEAD_FOUND) h.clearMarkers(point);
    h.arm(HEAD_FOUND[0]);
    const pendingDelete = h.signed(owner, "DELETE", memPath(stale));
    let holder: Promise<Response> | undefined;
    let replacement = "";
    try {
      await paused(HEAD_FOUND[0]);
      // A newer version replaces the head the DELETE found, and an owner PATCH
      // holds the new head; the DELETE's second attempt is not paused.
      replacement = await writeSkillVersion(stale, found, "the third version of the tide table procedure");
      h.arm("memory-patch-entry");
      holder = h.signed(owner, "PATCH", memPath(replacement), { subject: "a metadata edit while the DELETE runs" });
      await paused("memory-patch-entry");
      const before = await h.readRow(replacement);
      await h.release(HEAD_FOUND[0]);
      const body = await expectRefused(await pendingDelete, "memory_busy");
      expect(body).toEqual({ error: "memory_busy", caller: owner.id });
      expect(await h.readRow(replacement), "the refused DELETE changed the new head").toEqual(before);
      expect(h.writesBy(replacement, "delete"), "the refused DELETE wrote the new head").toEqual([]);
      await h.release("memory-patch-entry");
    } finally {
      h.letGo(HEAD_FOUND[0]);
      h.letGo("memory-patch-entry");
    }
    expect((await holder!).status).toBe(400);
    expect((await openVersions(stale)).map((row) => String(row.id))).toEqual([replacement]);
  }, 120_000);

  it("a head replaced on every attempt: the DELETE answers memory_busy after its last attempt and closes nothing", async () => {
    const stale = "opdl-skill-head-moves";
    let head = await seedOlderSkillVersion(stale);
    const first = head;
    for (const point of HEAD_FOUND) h.arm(point);
    const pendingDelete = h.signed(owner, "DELETE", memPath(stale));
    const replaced: string[] = [];
    try {
      for (const [index, point] of HEAD_FOUND.entries()) {
        await paused(point);
        head = await writeSkillVersion(stale, head, `replacement ${index + 1} of the tide table procedure`);
        replaced.push(head);
        await h.release(point);
      }
      const body = await expectRefused(await pendingDelete, "memory_busy");
      expect(body).toEqual({ error: "memory_busy", caller: owner.id });
    } finally {
      for (const point of HEAD_FOUND) h.letGo(point);
    }
    for (const id of [stale, first, ...replaced]) expect(h.writesBy(id, "delete"), `the refused DELETE wrote ${id}`).toEqual([]);
    expect((await openVersions(stale)).map((row) => String(row.id))).toEqual([replaced[replaced.length - 1]]);
    const res = await h.signed(owner, "DELETE", memPath(stale));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await openVersions(stale)).toEqual([]);
  }, 120_000);
});

describe("flair#2478 — owner DELETE (real Harper)", () => {
  it("CONTROL: an uncontended DELETE removes the row and is traced under phase delete", async () => {
    const id = "opdl-delete-control";
    await seed(id);
    const res = await h.signed(owner, "DELETE", memPath(id));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await h.readRow(id)).toBeNull();
    expect(h.writesBy(id, "delete"), "the DELETE did not delete the row exactly once, with no field write, under phase delete").toEqual([
      { writer: "delete", method: "delete", id, fields: [] },
    ]);
  }, 120_000);

  for (const verb of ["PUT", "PATCH"] as const) {
    it(`a DELETE held after its commit refuses an owner ${verb} memory_busy, then the row is gone`, async () => {
      const id = `opdl-delete-first-${verb.toLowerCase()}`;
      await seed(id);
      h.arm("memory-delete-committed");
      const pending = h.signed(owner, "DELETE", memPath(id));
      try {
        await paused("memory-delete-committed");
        const body = await expectRefused(await ownerWrite(verb, id, OWNER_TEXT), "memory_busy");
        expect(body).toEqual({ error: "memory_busy", caller: owner.id });
        await h.release("memory-delete-committed");
      } finally {
        h.letGo("memory-delete-committed");
      }
      expect((await pending).status).toBe(200);
      expect(await h.readRow(id), "the deleted row reappeared").toBeNull();
      const recreate = await h.signed(owner, "PUT", memPath(id), { agentId: owner.id, content: OWNER_TEXT, visibility: "private" });
      expect(recreate.status, await recreate.clone().text()).toBe(200);
      expect((await h.readRow(id))?.content).toBe(OWNER_TEXT);
    }, 120_000);

    it(`an owner ${verb} held after its commit refuses a DELETE memory_busy, then the DELETE applies`, async () => {
      const id = `opdl-owner-first-delete-${verb.toLowerCase()}`;
      await seed(id);
      const point = verb === "PUT" ? "memory-put-committed" : "memory-patch-committed";
      h.arm(point);
      const pending = ownerWrite(verb, id, OWNER_TEXT);
      try {
        await paused(point);
        expect((await expectRefused(await h.signed(owner, "DELETE", memPath(id)), "memory_busy")).error).toBe("memory_busy");
        await h.release(point);
      } finally {
        h.letGo(point);
      }
      expect((await pending).status).toBe(ownerSuccess(verb));
      const res = await h.signed(owner, "DELETE", memPath(id));
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await h.readRow(id)).toBeNull();
    }, 120_000);
  }
});
