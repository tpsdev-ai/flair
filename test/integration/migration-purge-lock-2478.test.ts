/**
 * migration-purge-lock-2478.test.ts — flair#2478 slice 3b part 3, real Harper.
 *
 *  - The synthetic CI migration (resources/migrations/synthetic-test-migration.ts)
 *    re-stamps its own rows' `source` field. It is an automatic writer: it takes
 *    the row's per-id Memory write lock with one non-waiting acquisition, reads
 *    the committed row under it, stages an update of `source` only, commits and
 *    confirms the committed row before the release. A held row, an unresolved
 *    write outcome on it or a table with no lock writes nothing, logs the skip,
 *    and leaves the row pending for the next scan.
 *  - POST /MemoryPurge (resources/MemoryPurge.ts) deletes its target rows. It is
 *    an operator-initiated foreground writer: it takes the sorted per-id locks
 *    of its whole target set with the owner budget, re-resolves the set under
 *    them, and holds them across the delete, the deletion-history write and
 *    their commits. A set held for the whole budget answers `503 memory_busy`
 *    with the caller id and nothing else.
 *
 * DETERMINISTIC ORDERING via the opt-in pause points
 * (FLAIR_ENABLE_TEST_FAULT_INJECTION + FLAIR_TEST_PAUSE_DIR):
 *   - synthetic-test-staged / synthetic-test-confirm: the write-back staged its
 *     update (resp. passed its committed-row confirmation) and has not
 *     committed; the lock is held. synthetic-test-committed: committed, still
 *     locked.
 *   - memory-purge-staged / memory-purge-commit: the row delete (resp. every
 *     write of the target) is staged and the transaction has not committed;
 *     the lock is held. memory-purge-committed: the delete committed and was
 *     confirmed, still locked.
 *
 * The real-Harper write trace (test/helpers/embedding-writer-race.ts) asserts
 * the synthetic migration's update names only `source`, and that the purge
 * makes no field write on the row (its Memory write is the row delete).
 *
 * Seeded rows carry an explicit visibility and a current embedding stamp so the
 * boot visibility backfill and the embedding-stamp migration leave them alone.
 * Throwaway HOME + data dir, ephemeral ports; every URL is asserted to be this
 * test's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent, expectRefused, newAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";

const owner = newAgent("msp-owner");
/** The synthetic migration's reserved agent, as the row owner the test writes as. */
const reservedOwner = newAgent("__flair_migration_synthetic_test_agent__");
const CURRENT_MODEL_ID = getModelId();
const MARKER = "synthetic-ci-schema-stamp-done";

const SYNTHETIC_WRITER = "synthetic-test-migration";
const PURGE_WRITER = "memory-purge";

const P_STAGED = "synthetic-test-staged";
const P_CONFIRM = "synthetic-test-confirm";
const P_COMMITTED = "synthetic-test-committed";
const U_STAGED = "memory-purge-staged";
const U_COMMIT = "memory-purge-commit";
const U_COMMITTED = "memory-purge-committed";

let component: ProbeComponent;
let home: string;
let pauseDir: string;
let installDir: string;
let h: RaceHarness;

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
const purgePath = "/MemoryPurge";

function row(id: string, agentId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, agentId, content: `content of ${id}`, source: "not-yet",
    embedding: [0.1, 0.2, 0.3], embeddingModel: CURRENT_MODEL_ID, ...extra,
  };
}

function ownerWrite(verb: "PUT" | "PATCH", id: string, text: string): Promise<Response> {
  return verb === "PUT"
    ? h.signed(reservedOwner, "PUT", memPath(id), { agentId: reservedOwner.id, content: text, visibility: "private", durability: "standard" })
    : h.signed(reservedOwner, "PATCH", memPath(id), { content: text, visibility: "private" });
}

async function expectBusy(res: Response, caller: string): Promise<void> {
  const body = await expectRefused(res, "memory_busy");
  expect(body).toEqual({ error: "memory_busy", caller });
}

function cycleCompletedCleanly(migrations: any): boolean {
  if (migrations?.cyclePhase !== "done" || migrations?.lastCycleError) return false;
  return Array.isArray(migrations?.migrations) && migrations.migrations.length > 0 &&
    migrations.migrations.every((m: any) => m?.state === "completed");
}
async function waitForCycleDone(timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await h.admin("GET", "/HealthDetail");
    if (res.ok && cycleCompletedCleanly((await res.json() as any)?.migrations)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function boot(extraEnv: Record<string, string> = {}): Promise<void> {
  h.harper = await startHarper({
    homeDir: home, cwd: component.dir, harperBinDir: component.sourceRoot, ...(installDir ? { installDir } : {}),
    serverEnv: {
      FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir,
      FLAIR_ENABLE_TEST_MIGRATIONS: "1", ...extraEnv,
    },
  });
  h.assertOwnInstance();
  installDir = h.harper.installDir;
}
/** Insert `rows`, stop, arm `first`, boot again: the boot cycle pauses at the
 *  first row's first armed point. The migration state file is removed with the
 *  instance stopped: a completed synthetic migration is otherwise recorded
 *  complete at this version and skipped on the next boot. */
async function seedAndReboot(rows: Record<string, unknown>[], first: string): Promise<void> {
  for (const r of rows) await h.seedMemory(r, {});
  await stopHarper(h.harper, { keepInstallDir: true });
  forgetMigrationState();
  h.arm(first);
  await boot();
}

/** Remove the runner's recorded state so the next boot re-detects (the
 *  synthetic migration is not `alwaysDetect`). */
function forgetMigrationState(): void {
  for (const path of [join(installDir, ".migrations", "state.json"), join(installDir, "data", ".migrations", "state.json")]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}
/** Arm `next` (a different point), then release `point`. */
async function handOff(point: string, next?: string): Promise<void> {
  expect(next, "a point cannot be armed while it is paused").not.toBe(point);
  if (next) h.arm(next);
  await h.release(point);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478-3b3-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478-3b3-pause-"));
  component = composeTracedComponent();
  h = new RaceHarness(pauseDir);
  await boot();
  await h.seedAgent(owner);
  await h.seedAgent(reservedOwner);
  expect(await waitForCycleDone(), "the first boot cycle did not finish").toBe(true);
}, 240_000);

afterAll(async () => {
  if (h?.harper) await stopHarper(h.harper).catch(() => {});
  if (installDir) rmSync(installDir, { recursive: true, force: true, maxRetries: 4 });
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  component?.cleanup();
}, HARPER_STOP_BUDGET_MS);

describe("flair#2478 slice 3b — the synthetic migration writer (real Harper)", () => {
  it("holds the row's lock from staging through its commit: owner PUT/PATCH are refused; the update names only `source`", async () => {
    const ids = ["smp-a1", "smp-a2", "smp-a3"];
    await seedAndReboot(ids.map((id) => row(id, reservedOwner.id)), P_STAGED);

    for (const [point, next] of [[P_STAGED, P_CONFIRM], [P_CONFIRM, P_COMMITTED], [P_COMMITTED, P_STAGED]] as const) {
      await h.assertPaused(point);
      for (const verb of ["PUT", "PATCH"] as const) {
        await expectBusy(await ownerWrite(verb, "smp-a1", "an owner edit while the migration holds the row"), reservedOwner.id);
      }
      const held = await h.readRow("smp-a1");
      expect(held.content, `${point}: an owner write landed`).toBe("content of smp-a1");
      expect(held.source, `${point}: the row was stamped before its commit`).toBe(point === P_COMMITTED ? MARKER : "not-yet");
      if (point === P_COMMITTED) h.expectIncrementalWrites("smp-a1", SYNTHETIC_WRITER, ["source"]);
      await handOff(point, next);
    }

    // The remaining rows run to completion.
    await h.release(P_STAGED);
    expect(await waitForCycleDone(), "the cycle did not finish").toBe(true);
    for (const id of ids) {
      const stored = await h.readRow(id);
      expect(stored.source, `${id} was not stamped`).toBe(MARKER);
      h.expectIncrementalWrites(id, SYNTHETIC_WRITER, ["source"]);
    }

    // The ordinary path still works once the lock is free, and the owner's
    // values are the ones stored after a successful response.
    const put = await ownerWrite("PUT", "smp-a1", "the owner's own text after the migration finished");
    expect(put.status, await put.clone().text()).toBe(200);
    const row1 = await h.readRow("smp-a1");
    expect(row1.content).toBe("the owner's own text after the migration finished");
    expect(row1.visibility).toBe("private");
  }, 300_000);

  it("reports a held row and leaves it for the next scan; an owner write that got there first is stored", async () => {
    const ids = ["smp-b1", "smp-b2"];
    await seedAndReboot(ids.map((id) => row(id, reservedOwner.id)), P_STAGED);
    await h.assertPaused(P_STAGED);

    // Hold smp-b2 with an owner PUT that has staged its write (and so holds
    // the row's lock), then let the migration reach it.
    h.arm("memory-put");
    const pendingPut = ownerWrite("PUT", "smp-b2", "the owner's text that holds the row");
    await h.assertPaused("memory-put");
    await h.release(P_STAGED);

    const refused = `[synthetic-test-migration] smp-b2: the per-id write lock answered busy`;
    expect(await h.waitForLog(refused), `the skip of smp-b2 was not logged within 30s: ${refused}`).toBe(true);
    await h.release("memory-put");
    const put = await pendingPut;
    expect(put.status, await put.clone().text()).toBe(200);
    const held = await h.readRow("smp-b2");
    expect(held.content).toBe("the owner's text that holds the row");
    expect(held.visibility).toBe("private");
    // The skipped row kept no migration write.
    expect(h.writesBy("smp-b2", SYNTHETIC_WRITER), "the skipped row was written").toEqual([]);

    // The next boot's scan picks the row up (the skip is reported, not lost).
    await stopHarper(h.harper, { keepInstallDir: true });
    forgetMigrationState();
    await boot();
    expect(await waitForCycleDone(), "the second cycle did not finish").toBe(true);
    expect((await h.readRow("smp-b2")).source).toBe(MARKER);
    expect((await h.readRow("smp-b1")).source).toBe(MARKER);
  }, 300_000);
});

describe("flair#2478 slice 3b — the purge writer (real Harper)", () => {
  it("holds the target's lock from staging through its commit: owner PUT/PATCH are refused; the row is deleted; no field write", async () => {
    await h.seedMemory(row("pmp-a1", owner.id), {});
    await h.seedMemory(row("pmp-a2", owner.id), {});
    h.arm(U_STAGED);
    const pendingPurge = h.admin("POST", purgePath, { ids: ["pmp-a1"] });

    for (const [point, next] of [[U_STAGED, U_COMMIT], [U_COMMIT, U_COMMITTED], [U_COMMITTED, U_STAGED]] as const) {
      await h.assertPaused(point);
      for (const verb of ["PUT", "PATCH"] as const) {
        const raced = verb === "PUT"
          ? h.signed(owner, "PUT", memPath("pmp-a1"), { agentId: owner.id, content: "an owner edit during the purge", visibility: "private" })
          : h.signed(owner, "PATCH", memPath("pmp-a1"), { content: "an owner edit during the purge", visibility: "private" });
        await expectBusy(await raced, owner.id);
      }
      const stored = await h.readRow("pmp-a1");
      if (point === U_COMMITTED) expect(stored, "the row survived the purge's commit").toBeNull();
      else expect(stored.content, `${point}: an owner write landed`).toBe("content of pmp-a1");
      if (point !== U_COMMITTED) await handOff(point, next);
      else await handOff(point);
    }

    const purge = await pendingPurge;
    expect(purge.status, await purge.clone().text()).toBe(200);
    expect(await purge.json()).toEqual({ removed: 1, removedIds: ["pmp-a1"] });
    expect(await h.readRow("pmp-a1")).toBeNull();
    // The purge's Memory write is the row delete; it stages no field update.
    expect(h.writesBy("pmp-a1", PURGE_WRITER), "the purge wrote fields").toEqual([]);
    expect((await h.readRow("pmp-a2")).content).toBe("content of pmp-a2");
  }, 300_000);

  it("refuses a held target with 503 memory_busy and deletes it after the owner's write is stored", async () => {
    await h.seedMemory(row("pmp-b1", owner.id), {});
    h.arm("memory-put");
    const pendingPut = h.signed(owner, "PUT", memPath("pmp-b1"), { agentId: owner.id, content: "the owner's text before the purge", visibility: "private" });
    await h.assertPaused("memory-put");

    // The purge waits its budget on the held id, then refuses with the caller
    // id and nothing else. Nothing is deleted.
    await expectBusy(await h.admin("POST", purgePath, { ids: ["pmp-b1"] }), "admin");
    expect((await h.readRow("pmp-b1")).content).toBe("content of pmp-b1");

    await h.release("memory-put");
    const put = await pendingPut;
    expect(put.status, await put.clone().text()).toBe(200);
    expect((await h.readRow("pmp-b1")).content).toBe("the owner's text before the purge");

    // With the lock free, the purge removes the row the owner wrote.
    const purge = await h.admin("POST", purgePath, { ids: ["pmp-b1"] });
    expect(purge.status, await purge.clone().text()).toBe(200);
    expect(await purge.json()).toEqual({ removed: 1, removedIds: ["pmp-b1"] });
    expect(await h.readRow("pmp-b1")).toBeNull();
  }, 300_000);

  it("CONTROL: an uncontended purge removes every named row", async () => {
    await h.seedMemory(row("pmp-c1", owner.id), {});
    await h.seedMemory(row("pmp-c2", owner.id), {});
    const purge = await h.admin("POST", purgePath, { ids: ["pmp-c1", "pmp-c2"] });
    expect(purge.status, await purge.clone().text()).toBe(200);
    expect(await purge.json()).toEqual({ removed: 2, removedIds: ["pmp-c1", "pmp-c2"] });
    expect(await h.readRow("pmp-c1")).toBeNull();
    expect(await h.readRow("pmp-c2")).toBeNull();
  }, 120_000);
});
