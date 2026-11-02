/**
 * migrations-state-writers-2866.test.ts — real writer processes on one real
 * migration state file (flair#2866).
 *
 * A lock held by a live process on this host is not broken by age, so a second
 * local writer is refused while the holder runs. A dead holder's lock is
 * broken by the next writer. The state writer accepts only a live handle for
 * the state file's lock: a handle whose lock file was replaced refuses the
 * write instead of publishing its read-modify-write snapshot, and releasing a
 * former handle leaves the successor's lock file in place.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acquireMigrationLock } from "../../resources/migrations/lock.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const WRITER = resolve(import.meta.dir, "../fixtures/migration-state-writer.ts");
const STATE_WRITE_PAUSE = "migration-state-write";
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

function spawnWriter(id: string, holdUntil?: string) {
  return Bun.spawn([process.execPath, "run", WRITER, statePath, id, pauseDir, holdUntil ?? ""], {
    cwd: REPO_ROOT,
    env: { ...process.env, FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readState(): Record<string, any> {
  return JSON.parse(readFileSync(statePath, "utf-8"));
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
    const a = spawnWriter("mig-a", "release-a");
    await waitFor(join(pauseDir, "written.mig-a"), "writer A's entry");
    const aHolder = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(aHolder.pid).toBe(a.pid);

    a.kill(9);
    await waitExit(a, "A");

    const b = spawnWriter("mig-b", "release-b");
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
    const b = spawnWriter("mig-b", "release-b");
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
});
