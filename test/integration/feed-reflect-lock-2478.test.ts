/**
 * feed-reflect-lock-2478.test.ts — flair#2478 slice 3b part 2, real Harper.
 *
 * The feed ingest (resources/MemoryFeed.ts, POST /FeedMemories), the feed dedup
 * expiry repair, and both `lastReflected` stamps (resources/Memory.ts's
 * `derivedFrom` sources and resources/MemoryReflect.ts's gathered sources)
 * take the per-memory-id write lock (resources/memory-write-lock.ts) for the id
 * they write. A writer decides on the committed row it reads under that lock,
 * stages an update of only its own fields — except the feed ingest, which is an
 * authored full-row replacement — commits before releasing, and confirms the
 * committed row. A foreground feed write that cannot take the lock waits its
 * budget and answers `503 memory_busy`; an automatic writer skips the row and
 * reports it.
 *
 * DETERMINISTIC ORDERING via the opt-in pause points
 * (FLAIR_ENABLE_TEST_FAULT_INJECTION + FLAIR_TEST_PAUSE_DIR):
 *   - feed-ingest-staged / feed-dedup-repair-staged / last-reflected-staged /
 *     reflect-sources-staged: the write is staged and the id's lock is held;
 *   - feed-ingest-commit / feed-dedup-repair-commit / last-reflected-commit /
 *     reflect-sources-commit: the last confirmation passed and the transaction
 *     has not committed;
 *   - feed-ingest-committed / feed-dedup-repair-committed /
 *     last-reflected-committed / reflect-sources-committed: the write committed
 *     and the lock is still held.
 *
 * The real-Harper write trace (test/helpers/embedding-writer-race.ts) asserts
 * each automatic writer's update names only its own field, and that the feed
 * ingest's authored replacement carries the authored row's field set and no
 * authority stamp.
 *
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent, expectRefused, newAgent } from "../helpers/embedding-writer-race";
import { computeContentHash } from "../../resources/memory-feed-lib.ts";
import { getModelId } from "../../resources/embeddings-provider.ts";

const owner = newAgent("frl-owner");
const CURRENT_MODEL_ID = getModelId();

const FEED_WRITER = "feed-ingest";
const REPAIR_WRITER = "feed-dedup-repair";
const DERIVED_WRITER = "last-reflected";
const REFLECT_WRITER = "reflect-sources";

/** The authored full-row field set the feed ingest stages for the row below. */
const FEED_FIELDS = [
  "agentId", "archived", "content", "contentHash", "createdAt", "durability",
  "id", "instanceToken", "provenance", "updatedAt", "visibility", "writeBackWriteId",
].sort();

let harper: HarperInstance;
let pauseDir: string;
let home: string;
let stubDir: string;
let component: ProbeComponent;
let h: RaceHarness;

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
const feedBody = (id: string, content: string, agentId = owner.id, visibility: string | undefined = "shared") => ({
  id, agentId, content, ...(visibility === undefined ? {} : { visibility }),
});

function seed(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  // An explicit visibility and a current embedding stamp: the boot visibility
  // backfill and the embedding-stamp migration leave the row alone.
  return h.seedMemory({
    id, agentId: owner.id, content: `content of ${id}`, embedding: [0.1, 0.2, 0.3],
    embeddingModel: CURRENT_MODEL_ID, ...extra,
  }, {});
}

async function put(agent: typeof owner, id: string, content: string, visibility = "private"): Promise<Response> {
  return h.signed(agent, "PUT", memPath(id), { agentId: agent.id, content, visibility });
}
async function patch(agent: typeof owner, id: string, content: string, visibility = "private"): Promise<Response> {
  return h.signed(agent, "PATCH", memPath(id), { content, visibility });
}
async function feed(id: string, content: string, agentId = owner.id, visibility: string | undefined = "shared"): Promise<Response> {
  return h.signed(owner, "POST", "/FeedMemories", feedBody(id, content, agentId, visibility));
}
async function expectBusy(res: Response): Promise<void> {
  const body = await expectRefused(res, "memory_busy");
  expect(body).toEqual({ error: "memory_busy", caller: owner.id });
}
async function readUntil(id: string, done: (row: any) => boolean, ms = 10_000): Promise<any> {
  const deadline = Date.now() + ms;
  let row = await h.readRow(id);
  while (!done(row) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    row = await h.readRow(id);
  }
  return row;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478-3b2-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478-3b2-pause-"));
  stubDir = mkdtempSync(join(tmpdir(), "flair-2478-3b2-stub-"));
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

describe("flair#2478 slice 3b — the feed ingest writer (real Harper)", () => {
  it("CONTROL: an uncontended feed update replaces the authored row and keeps no authority stamp", async () => {
    const id = "frl-feed-control";
    await seed(id);
    const res = await feed(id, "feed v2 control");
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    const row = await h.readRow(id);
    expect(row?.content).toBe("feed v2 control");
    expect(row?.visibility).toBe("shared");
    expect(row?.promotionStatus ?? null).toBeNull();
    const writes = h.writesBy(id, FEED_WRITER);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("put");
    expect(writes[0].fields).toEqual(FEED_FIELDS);
  }, 60_000);

  it("held after staging: an owner PUT is refused memory_busy; after release the feed write and the owner's write are stored", async () => {
    const id = "frl-feed-staged";
    await seed(id);
    h.arm("feed-ingest-staged");
    const pending = feed(id, "feed v2 staged");
    await h.assertPaused("feed-ingest-staged");
    await expectBusy(await put(owner, id, "owner put at the staged feed write"));
    await h.release("feed-ingest-staged");
    const res = await pending;
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    expect((await h.readRow(id))?.content).toBe("feed v2 staged");
    const after = await put(owner, id, "owner put after the feed write", "private");
    expect(after.status, (await after.clone().text()).slice(0, 300)).toBeLessThan(300);
    const row = await h.readRow(id);
    expect(row?.content).toBe("owner put after the feed write");
    expect(row?.visibility).toBe("private");
    expect(h.writesBy(id, FEED_WRITER)).toHaveLength(1);
  }, 120_000);

  it("held past its confirmation, before the commit: an owner PATCH is refused memory_busy; both writes are stored", async () => {
    const id = "frl-feed-commit";
    await seed(id);
    h.arm("feed-ingest-commit");
    const pending = feed(id, "feed v2 commit");
    await h.assertPaused("feed-ingest-commit");
    await expectBusy(await patch(owner, id, "owner patch at the feed commit point"));
    await h.release("feed-ingest-commit");
    const res = await pending;
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    expect((await h.readRow(id))?.content).toBe("feed v2 commit");
    const after = await patch(owner, id, "owner patch after the feed write", "private");
    expect(after.status, (await after.clone().text()).slice(0, 300)).toBeLessThan(300);
    const row = await h.readRow(id);
    expect(row?.content).toBe("owner patch after the feed write");
    expect(row?.visibility).toBe("private");
  }, 120_000);

  it("a second feed write while the id is held is refused memory_busy and writes nothing", async () => {
    const id = "frl-feed-miss";
    await seed(id);
    h.arm("feed-ingest-staged");
    const held = feed(id, "feed v2 held");
    await h.assertPaused("feed-ingest-staged");
    await expectBusy(await feed(id, "feed v3 while held"));
    await h.release("feed-ingest-staged");
    expect((await held).status).toBe(200);
    expect((await h.readRow(id))?.content).toBe("feed v2 held");
  }, 120_000);
});

describe("flair#2478 slice 3b — the feed dedup expiry repair (real Harper)", () => {
  async function seedDedup(id: string, text: string): Promise<void> {
    await seed(id, {
      content: text, contentHash: computeContentHash(owner.id, text),
      durability: "ephemeral", visibility: "private",
    });
  }

  it("CONTROL: a matching ephemeral row with no expiry is repaired with only expiresAt", async () => {
    const id = "frl-repair-control";
    const text = "the ephemeral feed row without an expiry";
    await seedDedup(id, text);
    const res = await feed(id, text, owner.id, "private");
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    const row = await h.readRow(id);
    expect(typeof row?.expiresAt).toBe("string");
    expect(row?.content).toBe(text);
    const writes = h.writesBy(id, REPAIR_WRITER);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("update");
    expect(writes[0].fields).toEqual(["expiresAt"]);
  }, 60_000);

  it("held after staging: an owner PUT is refused memory_busy, then the repair commits", async () => {
    const id = "frl-repair-staged";
    const text = "the staged ephemeral feed row";
    await seedDedup(id, text);
    h.arm("feed-dedup-repair-staged");
    const pending = feed(id, text, owner.id, "private");
    await h.assertPaused("feed-dedup-repair-staged");
    await expectBusy(await put(owner, id, "owner put at the staged repair"));
    await h.release("feed-dedup-repair-staged");
    const res = await pending;
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    const row = await h.readRow(id);
    expect(typeof row?.expiresAt).toBe("string");
    expect(row?.content).toBe(text);
  }, 120_000);

  it("held past its confirmation, before the commit: an owner PATCH is refused memory_busy, then the repair commits", async () => {
    const id = "frl-repair-commit";
    const text = "the repair commit-point ephemeral row";
    await seedDedup(id, text);
    h.arm("feed-dedup-repair-commit");
    const pending = feed(id, text, owner.id, "private");
    await h.assertPaused("feed-dedup-repair-commit");
    await expectBusy(await patch(owner, id, "owner patch at the repair commit point"));
    await h.release("feed-dedup-repair-commit");
    const res = await pending;
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    expect(typeof (await h.readRow(id))?.expiresAt).toBe("string");
  }, 120_000);

  it("a repair while the id is held skips and reports it, and returns the matched row unrepaired", async () => {
    const id = "frl-repair-miss";
    const text = "the skipped ephemeral feed row";
    await seedDedup(id, text);
    const matched = await h.readRow(id);
    h.arm("feed-dedup-repair-staged");
    const held = feed(id, text, owner.id, "private");
    await h.assertPaused("feed-dedup-repair-staged");
    const second = await feed(id, text, owner.id, "private");
    expect(second.status, (await second.clone().text()).slice(0, 300)).toBe(200);
    const skipped = await second.json();
    const fields = ["id", "agentId", "content", "durability", "visibility", "createdAt", "instanceToken"];
    for (const field of fields) expect(matched?.[field], `seeded ${field}`).toEqual(expect.any(String));
    expect(Object.fromEntries(fields.map((f) => [f, skipped[f]]))).toEqual(Object.fromEntries(fields.map((f) => [f, matched[f]])));
    expect(skipped.expiresAt ?? null).toBeNull();
    expect((await h.readRow(id))?.expiresAt ?? null).toBeNull();
    await h.release("feed-dedup-repair-staged");
    await held;
    expect(await h.waitForLog(`[MemoryFeed] dedup expiry repair skipped: busy (id ${id})`), "the skipped repair was not reported").toBe(true);
    expect(typeof (await h.readRow(id))?.expiresAt).toBe("string");
  }, 120_000);
});

describe("flair#2478 slice 3b — the derivedFrom lastReflected stamp (real Harper)", () => {
  it("CONTROL: a derived memory stamps lastReflected on its source with only that field", async () => {
    const agentId = "frl-derived-control-agent";
    const srcId = "frl-derived-control-src";
    const signer = newAgent(agentId);
    await h.seedAgent(signer);
    await h.seedMemory({ id: srcId, agentId, content: "derived source control", embedding: [0.1, 0.2, 0.3], embeddingModel: CURRENT_MODEL_ID }, {});
    const res = await h.signed(signer, "POST", "/Memory", {
      id: "frl-derived-control", agentId, content: "a derived memory", derivedFrom: [srcId], visibility: "shared",
    });
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBeLessThan(300);
    const row = await readUntil(srcId, (r) => !!r?.lastReflected);
    expect(row?.lastReflected).toBeTruthy();
    expect(row?.content).toBe("derived source control");
    const writes = h.writesBy(srcId, DERIVED_WRITER);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("update");
    expect(writes[0].fields).toEqual(["lastReflected"]);
  }, 60_000);

  it("held after staging: an owner PUT is refused memory_busy; after release the stamp and the owner's content are stored", async () => {
    const agentId = "frl-derived-staged-agent";
    const srcId = "frl-derived-staged-src";
    const signer = newAgent(agentId);
    await h.seedAgent(signer);
    await h.seedMemory({ id: srcId, agentId, content: "derived source staged", embedding: [0.1, 0.2, 0.3], embeddingModel: CURRENT_MODEL_ID }, {});
    h.arm("last-reflected-staged");
    const pending = h.signed(signer, "POST", "/Memory", {
      id: "frl-derived-staged", agentId, content: "a derived memory staged", derivedFrom: [srcId], visibility: "shared",
    });
    await h.assertPaused("last-reflected-staged");
    const busy = await h.signed(signer, "PUT", memPath(srcId), { agentId, content: "owner put at the staged stamp" });
    const body = await expectRefused(busy, "memory_busy");
    expect(body.caller).toBe(agentId);
    await h.release("last-reflected-staged");
    expect((await pending).status).toBeLessThan(300);
    expect((await h.readRow(srcId))?.lastReflected, "the stamp committed").toBeTruthy();
    const after = await h.signed(signer, "PUT", memPath(srcId), { agentId, content: "owner put after the stamp", visibility: "private" });
    expect(after.status, (await after.clone().text()).slice(0, 300)).toBeLessThan(300);
    const row = await h.readRow(srcId);
    expect(row?.content).toBe("owner put after the stamp");
    expect(row?.visibility).toBe("private");
  }, 120_000);

  it("held past its confirmation, before the commit: an owner PATCH is refused memory_busy", async () => {
    const agentId = "frl-derived-commit-agent";
    const srcId = "frl-derived-commit-src";
    const signer = newAgent(agentId);
    await h.seedAgent(signer);
    await h.seedMemory({ id: srcId, agentId, content: "derived source commit", embedding: [0.1, 0.2, 0.3], embeddingModel: CURRENT_MODEL_ID }, {});
    h.arm("last-reflected-commit");
    const pending = h.signed(signer, "POST", "/Memory", {
      id: "frl-derived-commit", agentId, content: "a derived memory commit", derivedFrom: [srcId], visibility: "shared",
    });
    await h.assertPaused("last-reflected-commit");
    const busy = await h.signed(signer, "PATCH", memPath(srcId), { content: "owner patch at the stamp commit point" });
    const body = await expectRefused(busy, "memory_busy");
    expect(body.caller).toBe(agentId);
    await h.release("last-reflected-commit");
    expect((await pending).status).toBeLessThan(300);
    expect((await h.readRow(srcId))?.lastReflected).toBeTruthy();
  }, 120_000);

  it("a stamp while the id is held is skipped and reported, and the source stays unstamped", async () => {
    const agentId = "frl-derived-miss-agent";
    const srcId = "frl-derived-miss-src";
    const signer = newAgent(agentId);
    await h.seedAgent(signer);
    await h.seedMemory({ id: srcId, agentId, content: "derived source miss", embedding: [0.1, 0.2, 0.3], embeddingModel: CURRENT_MODEL_ID }, {});
    h.arm("last-reflected-staged");
    const held = h.signed(signer, "POST", "/Memory", {
      id: "frl-derived-miss-1", agentId, content: "a derived memory miss", derivedFrom: [srcId], visibility: "shared",
    });
    await h.assertPaused("last-reflected-staged");
    const second = await h.signed(signer, "POST", "/Memory", {
      id: "frl-derived-miss-2", agentId, content: "another derived memory miss", derivedFrom: [srcId], visibility: "shared",
    });
    expect(second.status).toBeLessThan(300);
    expect((await h.readRow(srcId))?.lastReflected ?? null).toBeNull();
    await h.release("last-reflected-staged");
    await held;
    expect(await h.waitForLog(`[Memory] lastReflected stamp skipped for ${srcId} (busy)`), "the skipped stamp was not reported").toBe(true);
  }, 120_000);
});

describe("flair#2478 slice 3b — the reflect-run lastReflected stamp (real Harper)", () => {
  async function reflectSource(agentId: string, id: string): Promise<ReturnType<typeof newAgent>> {
    const signer = newAgent(agentId);
    await h.seedAgent(signer);
    await h.seedMemory({
      id, agentId, content: `reflect source ${id}`, embedding: [0.1, 0.2, 0.3],
      embeddingModel: CURRENT_MODEL_ID, durability: "standard", createdAt: new Date().toISOString(),
    }, {});
    return signer;
  }

  it("CONTROL: an execute run stamps lastReflected on a gathered source with only that field", async () => {
    const id = "frl-reflect-control";
    const signer = await reflectSource("frl-reflect-control-agent", id);
    const res = await h.signed(signer, "POST", "/ReflectMemories", { agentId: signer.id, execute: true });
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    const row = await readUntil(id, (r) => !!r?.lastReflected);
    expect(row?.lastReflected).toBeTruthy();
    expect(row?.content).toBe(`reflect source ${id}`);
    const writes = h.writesBy(id, REFLECT_WRITER);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("update");
    expect(writes[0].fields).toEqual(["lastReflected"]);
  }, 60_000);

  it("held after staging: an owner PUT is refused memory_busy; after release the stamp and the owner's content are stored", async () => {
    const id = "frl-reflect-staged";
    const signer = await reflectSource("frl-reflect-staged-agent", id);
    h.arm("reflect-sources-staged");
    const pending = h.signed(signer, "POST", "/ReflectMemories", { agentId: signer.id, execute: true });
    await h.assertPaused("reflect-sources-staged");
    const busy = await h.signed(signer, "PUT", memPath(id), { agentId: signer.id, content: "owner put at the staged reflect stamp" });
    const body = await expectRefused(busy, "memory_busy");
    expect(body.caller).toBe(signer.id);
    await h.release("reflect-sources-staged");
    expect((await pending).status).toBe(200);
    expect((await h.readRow(id))?.lastReflected, "the stamp committed").toBeTruthy();
    const after = await h.signed(signer, "PUT", memPath(id), { agentId: signer.id, content: "owner put after the reflect stamp", visibility: "private" });
    expect(after.status, (await after.clone().text()).slice(0, 300)).toBeLessThan(300);
    const row = await h.readRow(id);
    expect(row?.content).toBe("owner put after the reflect stamp");
    expect(row?.visibility).toBe("private");
  }, 120_000);

  it("held past its confirmation, before the commit: an owner PATCH is refused memory_busy", async () => {
    const id = "frl-reflect-commit";
    const signer = await reflectSource("frl-reflect-commit-agent", id);
    h.arm("reflect-sources-commit");
    const pending = h.signed(signer, "POST", "/ReflectMemories", { agentId: signer.id, execute: true });
    await h.assertPaused("reflect-sources-commit");
    const busy = await h.signed(signer, "PATCH", memPath(id), { content: "owner patch at the reflect commit point" });
    const body = await expectRefused(busy, "memory_busy");
    expect(body.caller).toBe(signer.id);
    await h.release("reflect-sources-commit");
    expect((await pending).status).toBe(200);
    expect((await h.readRow(id))?.lastReflected).toBeTruthy();
  }, 120_000);

  it("a stamp while the id is held is skipped and reported, and the source stays unstamped", async () => {
    const id = "frl-reflect-miss";
    const signer = await reflectSource("frl-reflect-miss-agent", id);
    h.arm("reflect-sources-staged");
    const held = h.signed(signer, "POST", "/ReflectMemories", { agentId: signer.id, execute: true });
    await h.assertPaused("reflect-sources-staged");
    const second = await h.signed(signer, "POST", "/ReflectMemories", { agentId: signer.id, execute: true });
    expect(second.status).toBe(200);
    expect((await h.readRow(id))?.lastReflected ?? null).toBeNull();
    await h.release("reflect-sources-staged");
    await held;
    expect(await h.waitForLog(`MemoryReflect: lastReflected stamp skipped for ${id} (busy)`), "the skipped stamp was not reported").toBe(true);
  }, 120_000);
});
