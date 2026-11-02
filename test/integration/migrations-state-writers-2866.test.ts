/**
 * migrations-state-writers-2866.test.ts — concurrent writers of the migration
 * state file must not drop each other's entries (flair#2866).
 *
 * Two real writer processes update DIFFERENT migration ids on the same real
 * state file. Writer A is paused by the state module's test-only pause point
 * between its read and its rename. While it is paused, writer B breaks A's
 * lock (as another runner does when it judges the file stale), acquires its
 * own, and writes. When A resumes, its proof no longer matches the lock file,
 * so it refuses with the named error and renames nothing: B's entry and the
 * entry already on disk both survive. Without the re-check A's rename would
 * publish its pre-B snapshot and B's entry would be gone.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

async function waitExit(proc: { exited: Promise<number>; kill: () => void }, what: string): Promise<number> {
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
  it("a writer whose lock was broken between read and rename refuses without dropping the winner's entry", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({ "mig-a": { lastOutcome: "halted", reason: "prior" } }, null, 2) + "\n",
    );
    writeFileSync(join(pauseDir, `arm.${STATE_WRITE_PAUSE}`), "");

    const a = spawnWriter("mig-a");
    await waitFor(join(pauseDir, `paused.${STATE_WRITE_PAUSE}`), "writer A's state-write pause");
    const lockPath = join(dirname(statePath), "lock");
    expect(existsSync(lockPath)).toBe(true);

    // Another runner judges the lock stale and breaks it, then takes its own.
    unlinkSync(lockPath);
    const b = spawnWriter("mig-b", "release-b");
    await waitFor(join(pauseDir, "written.mig-b"), "writer B's entry");

    // A resumes with its stale proof and exits after refusing (or, with the
    // re-check removed, after renaming its pre-B snapshot over B's entry).
    writeFileSync(join(pauseDir, `go.${STATE_WRITE_PAUSE}`), "");
    const aCode = await waitExit(a, "A");

    writeFileSync(join(pauseDir, "release-b"), "");
    expect(await waitExit(b, "B")).toBe(0);

    const state = readState();
    expect(state["mig-b"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
    expect(state["mig-a"].lastOutcome).toBe("halted");
    expect(state["mig-a"].reason).toBe("prior");
    expect(aCode).toBe(2);
    expect(existsSync(join(pauseDir, "refused.mig-a"))).toBe(true);
    expect(readFileSync(join(pauseDir, "refused.mig-a"), "utf-8")).toContain("MigrationStateWriteRefusedError");
    expect(existsSync(join(pauseDir, "written.mig-a"))).toBe(false);
  }, 25_000);

});
