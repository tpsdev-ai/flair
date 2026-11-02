/**
 * migrations-state-writers-2866.test.ts — real writer processes on one real
 * migration state file (flair#2866).
 *
 * A lock held by a live process on this host is not broken by age, so a second
 * local writer is refused while the holder runs. A lock is published by
 * linking a complete holder record into place, so a contender never reads a
 * partial lock; at a paused publication a second writer publishes its own lock
 * and the first refuses. A dead holder's lock is reclaimed only when the
 * reclaimer still sees the same device and inode after moving it aside; at a
 * paused reclaim a second writer's fresh lock is put back and the first
 * refuses. The state writer accepts only a live handle for the state file's
 * lock, read from lock.ts's module-private identity: changing a handle's
 * public fields does not redirect it, a handle whose lock file was replaced
 * refuses the write, and releasing a former handle leaves the successor's
 * lock file in place.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acquireMigrationLock } from "../../resources/migrations/lock.ts";
import { MigrationStateWriteRefusedError, writeMigrationStateEntry } from "../../resources/migrations/state.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const WRITER = resolve(import.meta.dir, "../fixtures/migration-state-writer.ts");
const STATE_WRITE_PAUSE = "migration-state-write";
const PUBLISH_PAUSE = "migration-lock-publish";
const RECLAIM_PAUSE = "migration-lock-reclaim";
const EXIT_TIMEOUT_MS = 10_000;

let root: string;
let statePath: string;
let pauseDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-state-writers-2866-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-state-writers-pause-2866-"));
  statePath = join(root, ".migrations", "state.json");
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
});

afterEach(() => {
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

async function waitExit(proc: { exited: Promise<number>; kill: (code?: number) => void }, what: string): Promise<number> {
  const result = await Promise.race([
    proc.exited,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), EXIT_TIMEOUT_MS)),
  ]);
  if (result === "timeout") {
    proc.kill();
    throw new Error(`writer ${what} did not exit within ${EXIT_TIMEOUT_MS} ms`);
  }
  return result;
}

function spawnWriter(id: string, options: { statePath?: string; holdUntil?: string; markers?: string } = {}) {
  const targetState = options.statePath ?? statePath;
  const markerDir = options.markers ?? pauseDir;
  return Bun.spawn([process.execPath, "run", WRITER, targetState, id, markerDir, options.holdUntil ?? ""], {
    cwd: REPO_ROOT,
    env: { ...process.env, FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readState(): Record<string, any> {
  return readStateAt(statePath);
}

function readStateAt(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("concurrent migration state writers (flair#2866)", () => {
  it("refuses a second local writer while the lock holder is alive, however old the file", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({ "mig-prior": { lastOutcome: "halted", reason: "prior" } }, null, 2) + "\n",
    );
    writeFileSync(join(pauseDir, `arm.${STATE_WRITE_PAUSE}`), "");

    const a = spawnWriter("mig-a");
    await waitFor(join(pauseDir, `paused.${STATE_WRITE_PAUSE}`), "writer A's state-write pause");

    const lockPath = join(dirname(statePath), "lock");
    expect(existsSync(lockPath)).toBe(true);
    // A still holds the lock. Make the file look stale by age: the holder is
    // on this host and its pid is alive, so age alone must not break it.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath, old, old);

    const b = spawnWriter("mig-b");
    expect(await waitExit(b, "B")).toBe(3);
    const refusal = readFileSync(join(pauseDir, "lock-failed.mig-b"), "utf-8");
    expect(refusal).toContain(`held by pid ${a.pid}`);
    expect(refusal).toContain(hostname());
    expect(refusal).toContain(lockPath);

    // A completes and publishes its own entry; every prior entry survives.
    writeFileSync(join(pauseDir, `go.${STATE_WRITE_PAUSE}`), "");
    expect(await waitExit(a, "A")).toBe(0);

    const state = readState();
    expect(state["mig-a"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
    expect(state["mig-prior"].lastOutcome).toBe("halted");
    expect(state["mig-prior"].reason).toBe("prior");
    expect(existsSync(join(pauseDir, "written.mig-a"))).toBe(true);
  }, 25_000);

  it("breaks a dead holder's lock and lets the successor write", async () => {
    const lockPath = join(dirname(statePath), "lock");
    const a = spawnWriter("mig-a", { holdUntil: "release-a" });
    await waitFor(join(pauseDir, "written.mig-a"), "writer A's entry");
    const aHolder = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(aHolder.pid).toBe(a.pid);

    a.kill(9);
    await waitExit(a, "A");

    const b = spawnWriter("mig-b", { holdUntil: "release-b" });
    await waitFor(join(pauseDir, "written.mig-b"), "writer B's entry");
    const bHolder = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(bHolder.pid).toBe(b.pid);
    expect(bHolder.pid).not.toBe(aHolder.pid);

    writeFileSync(join(pauseDir, "release-b"), "");
    expect(await waitExit(b, "B")).toBe(0);

    const state = readState();
    expect(state["mig-a"].lastOutcome).toBe("success");
    expect(state["mig-b"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
  }, 25_000);

  it("releasing a former handle does not remove the successor's lock", async () => {
    const lockPath = join(dirname(statePath), "lock");
    const former = acquireMigrationLock({ lockPath });
    if (!former.acquired) throw new Error(`migration lock unavailable: ${former.reason}`);

    // The lock file is replaced as it would be after an age-based takeover.
    unlinkSync(lockPath);
    const b = spawnWriter("mig-b", { holdUntil: "release-b" });
    await waitFor(join(pauseDir, "written.mig-b"), "writer B's entry");
    const bHolder = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(bHolder.pid).toBe(b.pid);

    former.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf-8"))).toEqual(bHolder);

    writeFileSync(join(pauseDir, "release-b"), "");
    expect(await waitExit(b, "B")).toBe(0);
    expect(readState()["mig-b"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
    // B's own release removed the file it still held.
    expect(existsSync(lockPath)).toBe(false);
  }, 25_000);

  it("publishes a complete holder record at the publication pause, and the first writer refuses the second's lock", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({ "mig-prior": { lastOutcome: "halted", reason: "prior" } }, null, 2) + "\n",
    );
    const migrationsDir = dirname(statePath);
    writeFileSync(join(pauseDir, `arm.${PUBLISH_PAUSE}`), "");

    const a = spawnWriter("mig-a");
    await waitFor(join(pauseDir, `paused.${PUBLISH_PAUSE}`), "writer A's publication pause");

    const lockPath = join(migrationsDir, "lock");
    expect(existsSync(lockPath)).toBe(false);
    const temps = readdirSync(migrationsDir).filter((name) => name.startsWith(".lock.") && name.endsWith(".tmp"));
    expect(temps.length).toBe(1);
    const record = JSON.parse(readFileSync(join(migrationsDir, temps[0]), "utf-8"));
    expect(record.pid).toBe(a.pid);
    expect(record.hostname).toBe(hostname());
    expect(typeof record.startedAt).toBe("string");

    const b = spawnWriter("mig-b", { holdUntil: "release-b" });
    await waitFor(join(pauseDir, "written.mig-b"), "writer B's entry");
    const bHolder = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(bHolder.pid).toBe(b.pid);

    writeFileSync(join(pauseDir, `go.${PUBLISH_PAUSE}`), "");
    expect(await waitExit(a, "A")).toBe(3);
    const refusal = readFileSync(join(pauseDir, "lock-failed.mig-a"), "utf-8");
    expect(refusal).toContain(`held by pid ${b.pid}`);

    expect(JSON.parse(readFileSync(lockPath, "utf-8"))).toEqual(bHolder);
    const state = readState();
    expect(state["mig-b"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
    expect(state["mig-prior"].lastOutcome).toBe("halted");
    expect(state["mig-prior"].reason).toBe("prior");

    writeFileSync(join(pauseDir, "release-b"), "");
    expect(await waitExit(b, "B")).toBe(0);
  }, 30_000);

  it("at the reclaim pause, a reclaimer that moved a successor's lock restores it and refuses", async () => {
    // A genuinely dead local holder: writer D publishes an entry, then is
    // killed before it releases, leaving its lock file behind.
    const d = spawnWriter("mig-d", { holdUntil: "release-d" });
    await waitFor(join(pauseDir, "written.mig-d"), "writer D's entry");
    d.kill(9);
    await waitExit(d, "D");
    const lockPath = join(dirname(statePath), "lock");
    const deadHolder = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(deadHolder.pid).toBe(d.pid);

    writeFileSync(join(pauseDir, `arm.${RECLAIM_PAUSE}`), "");
    const a = spawnWriter("mig-a");
    await waitFor(join(pauseDir, `paused.${RECLAIM_PAUSE}`), "writer A's reclaim pause");

    const b = spawnWriter("mig-b", { holdUntil: "release-b" });
    await waitFor(join(pauseDir, "written.mig-b"), "writer B's entry");
    const bHolder = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(bHolder.pid).toBe(b.pid);

    writeFileSync(join(pauseDir, `go.${RECLAIM_PAUSE}`), "");
    expect(await waitExit(a, "A")).toBe(3);
    const refusal = readFileSync(join(pauseDir, "lock-failed.mig-a"), "utf-8");
    expect(refusal).toContain("changed after the dead holder was inspected");

    expect(JSON.parse(readFileSync(lockPath, "utf-8"))).toEqual(bHolder);
    const state = readState();
    expect(state["mig-d"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
    expect(state["mig-b"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });

    writeFileSync(join(pauseDir, "release-b"), "");
    expect(await waitExit(b, "B")).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(readState()["mig-d"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
  }, 30_000);

  it("a handle whose public fields are changed cannot write another lock's state file or release that lock", async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "flair-state-writers-other-2866-"));
    const otherState = join(otherRoot, ".migrations", "state.json");
    mkdirSync(dirname(otherState), { recursive: true, mode: 0o700 });
    try {
      const ownLockPath = join(dirname(statePath), "lock");
      const otherLockPath = join(dirname(otherState), "lock");
      const own = acquireMigrationLock({ lockPath: ownLockPath });
      if (!own.acquired) throw new Error(`migration lock unavailable: ${own.reason}`);

      const b = spawnWriter("mig-b", { statePath: otherState, holdUntil: "release-b" });
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

      writeFileSync(join(pauseDir, "release-b"), "");
      expect(await waitExit(b, "B")).toBe(0);
      expect(readStateAt(otherState)["mig-b"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
