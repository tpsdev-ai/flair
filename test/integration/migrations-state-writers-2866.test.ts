/**
 * migrations-state-writers-2866.test.ts — real writer processes on one real
 * migration state file (flair#2866).
 *
 * Acquisition, reclaim and release of the migration lock are serialized by a
 * directory mutex. These tests pause real children at the mutex and lock
 * transitions: a prepared mutex directory is complete before publication, a
 * live mutex owner excludes every other child, a dead mutex generation can be
 * recovered by one successor at a time, and release removes the lock file only
 * when its identity is still the one the handle published. The state writer
 * accepts only a live handle for the state file's lock, read from lock.ts's
 * module-private identity.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acquireMigrationLock } from "../../resources/migrations/lock.ts";
import { MigrationStateWriteRefusedError, writeMigrationStateEntry } from "../../resources/migrations/state.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const WRITER = resolve(import.meta.dir, "../fixtures/migration-state-writer.ts");
const STATE_WRITE_PAUSE = "migration-state-write";
const GUARD_PUBLISH_PAUSE = "migration-lock-guard-publish";
const GUARD_PUBLISHED_PAUSE = "migration-lock-guard-published";
const GUARD_RECLAIM_PAUSE = "migration-lock-guard-reclaim";
const PUBLISH_PAUSE = "migration-lock-publish";
const PUBLISHED_PAUSE = "migration-lock-published";
const RECLAIM_PAUSE = "migration-lock-reclaim";
const RECLAIMED_PAUSE = "migration-lock-reclaimed";
const RELEASE_REVOKED_PAUSE = "migration-lock-release-revoked";
const RELEASE_GUARD_PAUSE = "migration-lock-release-guard";
const RELEASE_VERIFIED_PAUSE = "migration-lock-release-verified";
const RELEASE_UNLINKED_PAUSE = "migration-lock-release-unlinked";
const TOUCH_VERIFIED_PAUSE = "migration-lock-touch-verified";
const EXIT_TIMEOUT_MS = 15_000;

interface Child {
  pid: number;
  exited: Promise<number>;
  kill: (code?: number) => void;
}

let root: string;
let statePath: string;
let pauseDir: string;
const children: Child[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-state-writers-2866-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-state-writers-pause-2866-"));
  statePath = join(root, ".migrations", "state.json");
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  for (const child of children) {
    try {
      child.kill(9);
    } catch {
      /* already gone */
    }
  }
  for (const child of children) {
    await Promise.race([
      child.exited,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  children.length = 0;
  rmSync(root, { recursive: true, force: true });
  rmSync(pauseDir, { recursive: true, force: true });
});

async function waitFor(path: string, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (${path})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitExit(proc: Child, what: string): Promise<number> {
  const result = await Promise.race([
    proc.exited,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), EXIT_TIMEOUT_MS)),
  ]);
  if (result === "timeout") {
    proc.kill(9);
    await proc.exited;
    throw new Error(`writer ${what} did not exit within ${EXIT_TIMEOUT_MS} ms`);
  }
  return result;
}

function spawnWriter(
  id: string,
  options: { statePath?: string; holdUntil?: string; markers?: string; mode?: "write" | "touch" | "release" } = {},
): Child {
  const targetState = options.statePath ?? statePath;
  const markerDir = options.markers ?? pauseDir;
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      WRITER,
      targetState,
      id,
      markerDir,
      options.holdUntil ?? "",
      options.mode ?? "write",
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const child: Child = { pid: proc.pid, exited: proc.exited, kill: (code?: number) => proc.kill(code) };
  children.push(child);
  return child;
}

function arm(point: string): void {
  writeFileSync(join(pauseDir, `arm.${point}`), "");
}

function setGo(point: string): void {
  writeFileSync(join(pauseDir, `go.${point}`), "");
}

function paused(point: string): string {
  return join(pauseDir, `paused.${point}`);
}

function lockPath(): string {
  return join(dirname(statePath), "lock");
}

function guardPath(): string {
  return `${lockPath()}.guard`;
}

function ownerEntries(): string[] {
  if (!existsSync(guardPath())) return [];
  return readdirSync(guardPath()).filter((name) => name.startsWith("owner-"));
}

function readState(): Record<string, any> {
  return readStateAt(statePath);
}

function readStateAt(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function installSuccessor(): { bytes: string; holder: Record<string, unknown> } {
  const holder = { pid: 424242, hostname: "host-b", startedAt: "2026-01-01T00:00:00.000Z" };
  const bytes = JSON.stringify(holder);
  const temp = join(dirname(lockPath()), `.successor.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temp, bytes);
  renameSync(temp, lockPath());
  return { bytes, holder };
}

/** A real dead local holder: a child writes an entry, then is killed while holding the lock. */
async function seedDeadHolder(id: string): Promise<{ pid: number; holder: Record<string, unknown> }> {
  const dead = spawnWriter(id, { holdUntil: `go.release-${id}` });
  await waitFor(join(pauseDir, `written.${id}`), `writer ${id}'s entry`);
  const holder = JSON.parse(readFileSync(lockPath(), "utf-8"));
  expect(holder.pid).toBe(dead.pid);
  dead.kill(9);
  expect(await waitExit(dead, id)).not.toBe(0);
  return { pid: dead.pid, holder };
}

describe("concurrent migration state writers (flair#2866)", () => {
  it("refuses a second local writer while the lock holder is alive, however old the file", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({ "mig-prior": { lastOutcome: "halted", reason: "prior" } }, null, 2) + "\n",
    );
    arm(STATE_WRITE_PAUSE);

    const a = spawnWriter("mig-a");
    await waitFor(paused(STATE_WRITE_PAUSE), "writer A's state-write pause");

    // A still holds the lock. Make the file look stale by age: the holder is
    // on this host and its pid is alive, so age alone must not break it.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath(), old, old);

    const b = spawnWriter("mig-b");
    expect(await waitExit(b, "B")).toBe(3);
    const refusal = readFileSync(join(pauseDir, "lock-failed.mig-b"), "utf-8");
    expect(refusal).toContain(`held by pid ${a.pid}`);
    expect(refusal).toContain(hostname());
    expect(refusal).toContain(lockPath());

    // A completes and publishes its own entry; every prior entry survives.
    setGo(STATE_WRITE_PAUSE);
    expect(await waitExit(a, "A")).toBe(0);

    const state = readState();
    expect(state["mig-a"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
    expect(state["mig-prior"].lastOutcome).toBe("halted");
    expect(state["mig-prior"].reason).toBe("prior");
    expect(existsSync(join(pauseDir, "written.mig-a"))).toBe(true);
  }, 30_000);

  it("breaks a dead holder's lock and lets the successor write", async () => {
    const dead = await seedDeadHolder("mig-d");

    const b = spawnWriter("mig-b", { holdUntil: "go.release-b" });
    await waitFor(join(pauseDir, "written.mig-b"), "writer B's entry");
    const bHolder = JSON.parse(readFileSync(lockPath(), "utf-8"));
    expect(bHolder.pid).toBe(b.pid);
    expect(bHolder.pid).not.toBe(dead.pid);

    setGo("release-b");
    expect(await waitExit(b, "B")).toBe(0);

    const state = readState();
    expect(state["mig-d"].lastOutcome).toBe("success");
    expect(state["mig-b"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
  }, 30_000);

  it("releasing a former handle does not remove the successor's lock", async () => {
    const former = acquireMigrationLock({ lockPath: lockPath() });
    if (!former.acquired) throw new Error(`migration lock unavailable: ${former.reason}`);

    // The lock file is removed as it would be after an age-based takeover.
    unlinkSync(lockPath());
    const b = spawnWriter("mig-b", { holdUntil: "go.release-b" });
    await waitFor(join(pauseDir, "written.mig-b"), "writer B's entry");
    const bHolder = JSON.parse(readFileSync(lockPath(), "utf-8"));
    expect(bHolder.pid).toBe(b.pid);

    former.release();
    expect(existsSync(lockPath())).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), "utf-8"))).toEqual(bHolder);

    setGo("release-b");
    expect(await waitExit(b, "B")).toBe(0);
    expect(readState()["mig-b"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
    // B's own release removed the file it still held.
    expect(existsSync(lockPath())).toBe(false);
  }, 30_000);

  it("a handle whose public fields are changed cannot write another lock's state file or release that lock", async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "flair-state-writers-other-2866-"));
    const otherState = join(otherRoot, ".migrations", "state.json");
    mkdirSync(dirname(otherState), { recursive: true, mode: 0o700 });
    try {
      const ownLockPath = lockPath();
      const otherLockPath = join(dirname(otherState), "lock");
      const own = acquireMigrationLock({ lockPath: ownLockPath });
      if (!own.acquired) throw new Error(`migration lock unavailable: ${own.reason}`);

      const b = spawnWriter("mig-b", { statePath: otherState, holdUntil: "go.release-b" });
      await waitFor(join(pauseDir, "written.mig-b"), "writer B's entry");
      const bHolder = JSON.parse(readFileSync(otherLockPath, "utf-8"));
      expect(bHolder.pid).toBe(b.pid);

      // Both mutation routes the verdict names: assignment and
      // Object.defineProperty. Assignment throws on the prototype getter in
      // strict mode; defineProperty shadows it on the instance.
      try {
        (own as unknown as { lockPath: string }).lockPath = otherLockPath;
      } catch {
        /* assignment refused */
      }
      try {
        (own as unknown as { holder: unknown }).holder = bHolder;
      } catch {
        /* assignment refused */
      }
      Object.defineProperty(own, "lockPath", { value: otherLockPath, configurable: true });
      Object.defineProperty(own, "holder", { value: bHolder, configurable: true });
      expect((own as unknown as { lockPath: string }).lockPath).toBe(otherLockPath);

      let refusal: unknown;
      try {
        await writeMigrationStateEntry(otherState, "forged", { lastOutcome: "success" }, own);
      } catch (err) {
        refusal = err;
      }
      expect(refusal).toBeInstanceOf(MigrationStateWriteRefusedError);
      expect(readStateAt(otherState)["forged"]).toBeUndefined();

      // The private identity still names this handle's own state file.
      await writeMigrationStateEntry(statePath, "mig-a", { lastOutcome: "success" }, own);
      expect(readState()["mig-a"]).toMatchObject({ lastOutcome: "success" });

      own.release();
      expect(existsSync(ownLockPath)).toBe(false);
      expect(existsSync(otherLockPath)).toBe(true);
      expect(JSON.parse(readFileSync(otherLockPath, "utf-8"))).toEqual(bHolder);

      setGo("release-b");
      expect(await waitExit(b, "B")).toBe(0);
      expect(readStateAt(otherState)["mig-b"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("publication and exclusive ownership (flair#2866)", () => {
  it("before the mutex is published, its populated staging directory is complete and another writer takes ownership", async () => {
    arm(GUARD_PUBLISH_PAUSE);
    const a = spawnWriter("mig-a", { holdUntil: "go.release-a" });
    await waitFor(paused(GUARD_PUBLISH_PAUSE), "A's mutex publication pause");

    expect(existsSync(guardPath())).toBe(false);
    expect(existsSync(lockPath())).toBe(false);
    const staging = readdirSync(dirname(lockPath())).filter((name) => name.includes(".lock.guard.") && name.endsWith(".stage"));
    expect(staging.length).toBe(1);
    const stagedOwners = readdirSync(join(dirname(lockPath()), staging[0])).filter((name) => name.startsWith("owner-"));
    expect(stagedOwners.length).toBe(1);
    const staged = JSON.parse(readFileSync(join(dirname(lockPath()), staging[0], stagedOwners[0]), "utf-8"));
    expect(staged.pid).toBe(a.pid);
    expect(staged.generation).toBe(stagedOwners[0].slice("owner-".length, -".json".length));

    // B takes the lock while A is still paused before publishing the mutex.
    const b = spawnWriter("mig-b", { holdUntil: "go.release-b" });
    await waitFor(join(pauseDir, "written.mig-b"), "B's entry");

    setGo(GUARD_PUBLISH_PAUSE);
    expect(await waitExit(a, "A")).toBe(3);
    const refusal = readFileSync(join(pauseDir, "lock-failed.mig-a"), "utf-8");
    expect(refusal).toContain(`held by pid ${b.pid}`);

    const holder = JSON.parse(readFileSync(lockPath(), "utf-8"));
    expect(holder.pid).toBe(b.pid);
    expect(readState()["mig-a"]).toBeUndefined();
    expect(readState()["mig-b"]).toMatchObject({ lastOutcome: "success" });

    setGo("release-b");
    expect(await waitExit(b, "B")).toBe(0);
  }, 30_000);

  it("after the mutex is published, a competing writer is refused by the live mutex owner", async () => {
    arm(GUARD_PUBLISHED_PAUSE);
    const a = spawnWriter("mig-a", { holdUntil: "go.release-a" });
    await waitFor(paused(GUARD_PUBLISHED_PAUSE), "A's mutex publication pause");

    const owners = ownerEntries();
    expect(owners.length).toBe(1);
    const record = JSON.parse(readFileSync(join(guardPath(), owners[0]), "utf-8"));
    expect(record.pid).toBe(a.pid);

    const b = spawnWriter("mig-b");
    expect(await waitExit(b, "B")).toBe(3);
    expect(readFileSync(join(pauseDir, "lock-failed.mig-b"), "utf-8")).toContain("mutex is held");

    setGo(GUARD_PUBLISHED_PAUSE);
    await waitFor(join(pauseDir, "written.mig-a"), "A's entry");
    expect(ownerEntries()).toEqual([]);
    setGo("release-a");
    expect(await waitExit(a, "A")).toBe(0);
    expect(readState()["mig-a"]).toMatchObject({ lastOutcome: "success" });
  }, 30_000);

  it("before the lock file is published, its prepared record is complete and the mutex excludes a competitor", async () => {
    arm(PUBLISH_PAUSE);
    const a = spawnWriter("mig-a", { holdUntil: "go.release-a" });
    await waitFor(paused(PUBLISH_PAUSE), "A's lock publication pause");

    expect(existsSync(lockPath())).toBe(false);
    const temps = readdirSync(dirname(lockPath())).filter((name) => name.startsWith(".lock.") && name.endsWith(".tmp"));
    expect(temps.length).toBe(1);
    const record = JSON.parse(readFileSync(join(dirname(lockPath()), temps[0]), "utf-8"));
    expect(record.pid).toBe(a.pid);
    expect(record.hostname).toBe(hostname());
    expect(typeof record.startedAt).toBe("string");

    const b = spawnWriter("mig-b");
    expect(await waitExit(b, "B")).toBe(3);
    expect(readFileSync(join(pauseDir, "lock-failed.mig-b"), "utf-8")).toContain("mutex is held");

    setGo(PUBLISH_PAUSE);
    await waitFor(join(pauseDir, "written.mig-a"), "A's entry");
    expect(JSON.parse(readFileSync(lockPath(), "utf-8")).pid).toBe(a.pid);
    setGo("release-a");
    expect(await waitExit(a, "A")).toBe(0);
  }, 30_000);

  it("after the lock file is published, the record is complete and the mutex still excludes a competitor", async () => {
    arm(PUBLISHED_PAUSE);
    const a = spawnWriter("mig-a", { holdUntil: "go.release-a" });
    await waitFor(paused(PUBLISHED_PAUSE), "A's lock publication pause");

    const record = JSON.parse(readFileSync(lockPath(), "utf-8"));
    expect(record.pid).toBe(a.pid);
    expect(record.hostname).toBe(hostname());

    const b = spawnWriter("mig-b");
    expect(await waitExit(b, "B")).toBe(3);
    expect(readFileSync(join(pauseDir, "lock-failed.mig-b"), "utf-8")).toContain("mutex is held");

    setGo(PUBLISHED_PAUSE);
    await waitFor(join(pauseDir, "written.mig-a"), "A's entry");
    setGo("release-a");
    expect(await waitExit(a, "A")).toBe(0);
  }, 30_000);
});

describe("three-contender reclaim (flair#2866)", () => {
  it("holds a dead holder's replacement under the mutex and refuses the other contenders", async () => {
    await seedDeadHolder("mig-d");

    arm(RECLAIM_PAUSE);
    const a = spawnWriter("mig-a", { holdUntil: "go.release-a" });
    await waitFor(paused(RECLAIM_PAUSE), "A's reclaim pause");

    const b = spawnWriter("mig-b");
    const c = spawnWriter("mig-c");
    expect(await waitExit(b, "B")).toBe(3);
    expect(await waitExit(c, "C")).toBe(3);
    expect(readFileSync(join(pauseDir, "lock-failed.mig-b"), "utf-8")).toContain("mutex is held");
    expect(readFileSync(join(pauseDir, "lock-failed.mig-c"), "utf-8")).toContain("mutex is held");

    setGo(RECLAIM_PAUSE);
    await waitFor(join(pauseDir, "written.mig-a"), "A's entry");
    expect(JSON.parse(readFileSync(lockPath(), "utf-8")).pid).toBe(a.pid);

    // The successful successor stays open; the others retry and are refused.
    const b2 = spawnWriter("mig-b2");
    const c2 = spawnWriter("mig-c2");
    expect(await waitExit(b2, "B2")).toBe(3);
    expect(await waitExit(c2, "C2")).toBe(3);
    expect(readFileSync(join(pauseDir, "lock-failed.mig-b2"), "utf-8")).toContain("held by pid");
    expect(readFileSync(join(pauseDir, "lock-failed.mig-c2"), "utf-8")).toContain("held by pid");

    setGo("release-a");
    expect(await waitExit(a, "A")).toBe(0);
    expect(readState()["mig-a"]).toMatchObject({ lastOutcome: "success" });
    expect(readState()["mig-d"]).toMatchObject({ lastOutcome: "success" });
  }, 40_000);

  it("after the reclaimer is killed at the replacement boundary, exactly one contender wins", async () => {
    await seedDeadHolder("mig-d");

    arm(RECLAIM_PAUSE);
    const a = spawnWriter("mig-a");
    await waitFor(paused(RECLAIM_PAUSE), "A's reclaim pause");
    const b = spawnWriter("mig-b");
    const c = spawnWriter("mig-c");
    expect(await waitExit(b, "B")).toBe(3);
    expect(await waitExit(c, "C")).toBe(3);

    a.kill(9);
    await waitExit(a, "A");

    const survivors = [spawnWriter("mig-b2", { holdUntil: "go.release-win" }), spawnWriter("mig-c2", { holdUntil: "go.release-win" })];
    const first = await Promise.race([
      waitFor(join(pauseDir, "written.mig-b2"), "B2").then(() => "b2" as const),
      waitFor(join(pauseDir, "written.mig-c2"), "C2").then(() => "c2" as const),
    ]);
    const winner = first === "b2" ? survivors[0] : survivors[1];
    const winnerId = first === "b2" ? "mig-b2" : "mig-c2";
    const loserId = first === "b2" ? "mig-c2" : "mig-b2";
    await waitFor(join(pauseDir, `lock-failed.${loserId}`), "the losing contender's refusal");
    expect(readState()[winnerId]).toMatchObject({ lastOutcome: "success" });
    expect(readState()[loserId]).toBeUndefined();

    setGo("release-win");
    expect(await waitExit(winner, winnerId)).toBe(0);
    expect(readState()["mig-d"]).toMatchObject({ lastOutcome: "success" });
  }, 40_000);
});

describe("three-contender mutex recovery (flair#2866)", () => {
  it("a resumed cleanup names the old generation and cannot remove the successor's owner entry", async () => {
    // Leave a published mutex whose owner is dead.
    arm(GUARD_PUBLISHED_PAUSE);
    const dead = spawnWriter("mig-dead");
    await waitFor(paused(GUARD_PUBLISHED_PAUSE), "the mutex holder's pause");
    const deadOwners = ownerEntries();
    expect(deadOwners.length).toBe(1);
    dead.kill(9);
    await waitExit(dead, "dead");
    // The killed child's pause markers are not a signal that a later child paused.
    for (const prefix of ["paused", "claimed", "released"]) {
      rmSync(join(pauseDir, `${prefix}.${GUARD_PUBLISHED_PAUSE}`), { force: true });
    }
    rmSync(paused(GUARD_PUBLISHED_PAUSE), { force: true });

    // P pauses after inspecting that dead generation, before unlinking it.
    arm(GUARD_RECLAIM_PAUSE);
    const p = spawnWriter("mig-p");
    await waitFor(paused(GUARD_RECLAIM_PAUSE), "P's dead-generation pause");

    // B recovers the dead mutex, acquires the migration lock, writes, and releases both.
    const b = spawnWriter("mig-b");
    await waitFor(join(pauseDir, "written.mig-b"), "B's entry");
    expect(await waitExit(b, "B")).toBe(0);
    expect(existsSync(lockPath())).toBe(false);

    // C publishes its own generation and remains inside the mutex.
    arm(GUARD_PUBLISHED_PAUSE);
    const c = spawnWriter("mig-c", { holdUntil: "go.release-c" });
    await waitFor(paused(GUARD_PUBLISHED_PAUSE), "C's mutex publication pause");
    const cOwners = ownerEntries();
    expect(cOwners.length).toBe(1);
    expect(cOwners[0]).not.toBe(deadOwners[0]);
    const cOwnerBytes = readFileSync(join(guardPath(), cOwners[0]), "utf-8");

    // P resumes its old cleanup: it names the dead generation, gets ENOENT,
    // re-inspects, and refuses against C's live generation.
    setGo(GUARD_RECLAIM_PAUSE);
    expect(await waitExit(p, "P")).toBe(3);
    expect(readFileSync(join(guardPath(), cOwners[0]), "utf-8")).toBe(cOwnerBytes);
    expect(ownerEntries()).toEqual(cOwners);

    setGo(GUARD_PUBLISHED_PAUSE);
    await waitFor(join(pauseDir, "written.mig-c"), "C's entry");
    setGo("release-c");
    expect(await waitExit(c, "C")).toBe(0);
    expect(readState()["mig-c"]).toMatchObject({ lastOutcome: "success" });
  }, 45_000);
});

describe("release under the mutex (flair#2866)", () => {
  it("after revocation, a successor installed before the mutex is taken is left unchanged", async () => {
    arm(RELEASE_REVOKED_PAUSE);
    const a = spawnWriter("mig-a", { holdUntil: "go.release-now", mode: "release" });
    await waitFor(join(pauseDir, "written.mig-a"), "A's entry");
    setGo("release-now");
    await waitFor(paused(RELEASE_REVOKED_PAUSE), "A's revocation pause");

    const successor = installSuccessor();
    setGo(RELEASE_REVOKED_PAUSE);
    expect(await waitExit(a, "A")).toBe(0);
    expect(readFileSync(lockPath(), "utf-8")).toBe(successor.bytes);
  }, 30_000);

  it("after the mutex is acquired, a successor installed before the identity check is left unchanged", async () => {
    arm(RELEASE_GUARD_PAUSE);
    const a = spawnWriter("mig-a", { holdUntil: "go.release-now", mode: "release" });
    await waitFor(join(pauseDir, "written.mig-a"), "A's entry");
    setGo("release-now");
    await waitFor(paused(RELEASE_GUARD_PAUSE), "A's mutex-acquisition pause");

    const successor = installSuccessor();
    setGo(RELEASE_GUARD_PAUSE);
    expect(await waitExit(a, "A")).toBe(0);
    expect(readFileSync(lockPath(), "utf-8")).toBe(successor.bytes);
  }, 30_000);

  it("after identity verification, a competing writer is excluded and the successor takes over after release", async () => {
    arm(RELEASE_VERIFIED_PAUSE);
    const a = spawnWriter("mig-a", { holdUntil: "go.release-now", mode: "release" });
    await waitFor(join(pauseDir, "written.mig-a"), "A's entry");
    setGo("release-now");
    await waitFor(paused(RELEASE_VERIFIED_PAUSE), "A's identity-verification pause");

    const b = spawnWriter("mig-b");
    expect(await waitExit(b, "B")).toBe(3);
    expect(readFileSync(join(pauseDir, "lock-failed.mig-b"), "utf-8")).toContain("mutex is held");

    setGo(RELEASE_VERIFIED_PAUSE);
    expect(await waitExit(a, "A")).toBe(0);
    expect(existsSync(lockPath())).toBe(false);

    const b2 = spawnWriter("mig-b2", { holdUntil: "go.release-b2" });
    await waitFor(join(pauseDir, "written.mig-b2"), "B2's entry");
    const holder = JSON.parse(readFileSync(lockPath(), "utf-8"));
    expect(holder.pid).toBe(b2.pid);
    setGo("release-b2");
    expect(await waitExit(b2, "B2")).toBe(0);
  }, 40_000);

  it("after the lock file is unlinked, the mutex still excludes a writer until release ends", async () => {
    arm(RELEASE_UNLINKED_PAUSE);
    const a = spawnWriter("mig-a", { holdUntil: "go.release-now", mode: "release" });
    await waitFor(join(pauseDir, "written.mig-a"), "A's entry");
    setGo("release-now");
    await waitFor(paused(RELEASE_UNLINKED_PAUSE), "A's unlink pause");

    expect(existsSync(lockPath())).toBe(false);
    const b = spawnWriter("mig-b");
    expect(await waitExit(b, "B")).toBe(3);
    expect(readFileSync(join(pauseDir, "lock-failed.mig-b"), "utf-8")).toContain("mutex is held");

    setGo(RELEASE_UNLINKED_PAUSE);
    expect(await waitExit(a, "A")).toBe(0);

    const b2 = spawnWriter("mig-b2", { holdUntil: "go.release-b2" });
    await waitFor(join(pauseDir, "written.mig-b2"), "B2's entry");
    setGo("release-b2");
    expect(await waitExit(b2, "B2")).toBe(0);
  }, 40_000);
});

describe("descriptor heartbeat (flair#2866)", () => {
  it("updates the verified descriptor and leaves a successor's bytes and mtime unchanged", async () => {
    arm(TOUCH_VERIFIED_PAUSE);
    const a = spawnWriter("mig-a", { holdUntil: "go.touch-now", mode: "touch" });
    await waitFor(join(pauseDir, "written.mig-a"), "A's entry");
    setGo("touch-now");
    await waitFor(paused(TOUCH_VERIFIED_PAUSE), "A's descriptor-verification pause");

    const replacement = { pid: 424242, hostname: "host-b", startedAt: "2025-01-01T00:00:00.000Z" };
    const bytes = JSON.stringify(replacement);
    const temp = join(dirname(lockPath()), `.successor.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
    writeFileSync(temp, bytes);
    renameSync(temp, lockPath());
    const fixed = new Date("2025-02-02T03:04:05.000Z");
    utimesSync(lockPath(), fixed, fixed);
    const before = statSync(lockPath()).mtimeMs;

    setGo(TOUCH_VERIFIED_PAUSE);
    await waitFor(join(pauseDir, "touched.mig-a"), "A's touch");
    expect(await waitExit(a, "A")).toBe(0);

    expect(readFileSync(lockPath(), "utf-8")).toBe(bytes);
    expect(statSync(lockPath()).mtimeMs).toBe(before);
  }, 30_000);
});
