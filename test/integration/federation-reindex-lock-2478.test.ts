/**
 * federation-reindex-lock-2478.test.ts — flair#2478 slice 3c (real Harper).
 *
 * The federation merge of an incoming Memory row and the batch reindex writer
 * take the id's per-id Memory write lock: an owner PUT/PATCH racing either one
 * is answered `memory_busy` while the writer holds the lock, and the writer
 * commits before releasing it. A writer that cannot take the lock writes
 * nothing and reports the row (the merge as `merge_target_busy`, the reindex
 * result as `skipped`). The composed component traces every Memory write by
 * the lock phase that ran it, so each writer's own field set is asserted.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { startHarper, stopHarper, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { RaceHarness, composeTracedComponent, expectRefused, newAgent, waitForPath } from "../helpers/embedding-writer-race";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";

const owner = newAgent("frl-owner");
const peerKeys = nacl.sign.keyPair();
const PEER = "frl-peer";

let h: RaceHarness;
let pauseDir: string;
let home: string;
let component: ProbeComponent;

function federatedPush(id: string, content: string): Promise<Response> {
  const body = signBodyFresh(
    {
      instanceId: PEER,
      records: [{
        originatorInstanceId: PEER,
        table: "Memory",
        id,
        updatedAt: new Date().toISOString(),
        data: { id, agentId: owner.id, content, contentHash: `hash-${content}`, durability: "standard" },
      }],
      lamportClock: Date.now(),
    },
    peerKeys.secretKey,
  );
  return fetch(`${h.harper.httpURL}/FederationSync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
}

function reindex(agentId: string): Promise<Response> {
  return h.admin("POST", "/MemoryReindex", { agentId });
}

async function seed(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await h.seedMemory({ id, agentId: owner.id, content: `original ${id}`, contentHash: `hash-original-${id}`, durability: "standard", ...extra }, {});
}

/** A fresh agent + a Memory row it owns, so a reindex run targets exactly one row. */
async function seedOwned(id: string) {
  const agent = newAgent(`frl-reindex-owner-${randomUUID()}`);
  await h.seedAgent(agent);
  await h.seedMemory({ id, agentId: agent.id, content: `original ${id}`, contentHash: `hash-original-${id}` }, {});
  return agent;
}

/** Run `trigger` paused at `point`, compete once paused, release, return both. */
async function withPaused<T>(point: string, trigger: () => Promise<Response>, compete: () => Promise<T>) {
  h.arm(point);
  const pending = trigger();
  const paused = await waitForPath(join(pauseDir, `paused.${point}`), 60_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    h.letGo(point);
  }
  const response = await pending;
  if (!paused) console.error(`${point} not reached: ${response.status} ${await response.clone().text()}`);
  return { response, competed, paused };
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478s3c-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478s3c-pause-"));
  component = composeTracedComponent();
  h = new RaceHarness(pauseDir);
  h.harper = await startHarper({
    homeDir: home,
    cwd: component.dir,
    harperBinDir: component.sourceRoot,
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  h.assertOwnInstance();
  await h.seedAgent(owner);
  await h.ops({
    operation: "upsert", database: "flair", table: "Peer",
    records: [{ id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: new Date().toISOString() }],
  });
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

describe("flair#2478 slice 3c — the federated Memory merge holds the id's lock (real Harper)", () => {
  it("CONTROL: an uncontended merge lands as one incremental update of the merge's fields", async () => {
    const id = `frl-control-${randomUUID()}`;
    await seed(id);
    const res = await federatedPush(id, `merged ${id}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as any;
    expect(body.merged, JSON.stringify(body)).toBe(1);
    const row = await h.readRow(id);
    expect(row?.content, "the ordinary merge did not land").toBe(`merged ${id}`);
    expect(row?.visibility, "the merge changed the untouched stored visibility").toBe("shared");
    const writes = h.writesBy(id, "federation-merge");
    expect(writes.length, "no Memory write was traced under the merge's lock phase").toBe(1);
    expect(writes[0].method, "the merge wrote a full row").toBe("update");
    expect(writes[0].fields).toContain("content");
    expect(writes[0].fields).not.toContain("visibility");
    expect(writes[0].fields).not.toContain("instanceToken");
  }, 120_000);

  it("an owner PATCH racing the merge at federation-merge is refused memory_busy; the merge lands", async () => {
    const id = `frl-patch-staged-${randomUUID()}`;
    await seed(id);
    const { response, competed, paused } = await withPaused(
      "federation-merge",
      () => federatedPush(id, `merged ${id}`),
      () => h.signed(owner, "PATCH", `/Memory/${encodeURIComponent(id)}`, { content: `owner ${id}` }),
    );
    expect(paused, "the merge never paused under its lock").toBe(true);
    await expectRefused(competed as Response, "memory_busy");
    expect(response.status, await response.clone().text()).toBe(200);
    const row = await h.readRow(id);
    expect(row?.content, "the merge that held the lock did not land").toBe(`merged ${id}`);
  }, 120_000);

  it("an owner PUT racing the merge at federation-merge-commit is refused memory_busy; the merge lands", async () => {
    const id = `frl-put-confirm-${randomUUID()}`;
    await seed(id);
    const { response, competed, paused } = await withPaused(
      "federation-merge-commit",
      () => federatedPush(id, `merged ${id}`),
      () => h.signed(owner, "PUT", `/Memory/${encodeURIComponent(id)}`, { id, agentId: owner.id, content: `owner ${id}`, visibility: "shared" }),
    );
    expect(paused, "the merge never paused before its commit").toBe(true);
    await expectRefused(competed as Response, "memory_busy");
    expect(response.status, await response.clone().text()).toBe(200);
    const row = await h.readRow(id);
    expect(row?.content, "the merge that held the lock did not land").toBe(`merged ${id}`);
  }, 120_000);

  it("a second merge of the same id is reported merge_target_busy, never written over the holder", async () => {
    const id = `frl-busy-${randomUUID()}`;
    await seed(id);
    const { response, competed } = await withPaused(
      "federation-merge",
      () => federatedPush(id, `first ${id}`),
      () => federatedPush(id, `second ${id}`),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const second = await (competed as Response).json() as any;
    expect(second.merged, JSON.stringify(second)).toBe(0);
    expect(second.skippedReasons?.merge_target_busy, JSON.stringify(second)).toBe(1);
    expect(second.refused, JSON.stringify(second)).toContainEqual({ table: "Memory", id, reason: "merge_target_busy" });
    expect((await h.readRow(id))?.content, "the skipped merge still changed the row").toBe(`first ${id}`);
  }, 120_000);
});

describe("flair#2478 slice 3c — the batch reindex writer holds the id's lock (real Harper)", () => {
  it("CONTROL: an uncontended reindex re-PUTs the row under the reindex lock phase", async () => {
    const id = `frl-reindex-control-${randomUUID()}`;
    const agent = await seedOwned(id);
    const res = await reindex(agent.id);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as any;
    expect(body.stats.reindexed, JSON.stringify(body.stats)).toBeGreaterThan(0);
    const writes = h.writesBy(id, "reindex-put");
    expect(writes.length, "no Memory write was traced under the reindex lock phase").toBe(1);
  }, 120_000);

  it("an owner PATCH racing the reindex at reindex-put is refused memory_busy; the re-PUT completes", async () => {
    const id = `frl-reindex-patch-${randomUUID()}`;
    const agent = await seedOwned(id);
    const { response, competed, paused } = await withPaused(
      "reindex-put",
      () => reindex(agent.id),
      () => h.signed(agent, "PATCH", `/Memory/${encodeURIComponent(id)}`, { content: `owner ${id}` }),
    );
    expect(paused, "the reindex never paused under its lock").toBe(true);
    await expectRefused(competed as Response, "memory_busy");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as any;
    expect(body.stats.skipped, JSON.stringify(body.stats)).toBe(0);
  }, 120_000);

  it("an owner PUT racing the reindex at reindex-put-commit is refused memory_busy; the re-PUT completes", async () => {
    const id = `frl-reindex-put-${randomUUID()}`;
    const agent = await seedOwned(id);
    const { response, competed, paused } = await withPaused(
      "reindex-put-commit",
      () => reindex(agent.id),
      () => h.signed(agent, "PUT", `/Memory/${encodeURIComponent(id)}`, { id, agentId: agent.id, content: `owner ${id}`, visibility: "shared" }),
    );
    expect(paused, "the reindex never paused before its commit").toBe(true);
    await expectRefused(competed as Response, "memory_busy");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as any;
    expect(body.stats.skipped, JSON.stringify(body.stats)).toBe(0);
  }, 120_000);

  it("a reindex row whose id is held is counted and named as skipped", async () => {
    const id = `frl-reindex-busy-${randomUUID()}`;
    const agent = await seedOwned(id);
    const { response, competed } = await withPaused(
      "federation-merge",
      () => federatedPush(id, `held ${id}`),
      () => reindex(agent.id),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await (competed as Response).json() as any;
    expect(body.stats.skipped, JSON.stringify(body.stats)).toBe(1);
    expect(body.stats.skippedSamples, JSON.stringify(body.stats)).toContainEqual({ id, reason: "busy" });
    expect((await h.readRow(id))?.content, "the skipped reindex still changed the row").toBe(`held ${id}`);
  }, 120_000);
});
