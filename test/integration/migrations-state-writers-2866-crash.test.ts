/**
 * migrations-state-writers-2866-crash.test.ts — kill boundaries around the
 * migration-lock protocol (flair#2866).
 *
 * Each case pauses a real child at one filesystem transition, kills it with
 * SIGKILL, awaits its exit, then starts a survivor. The survivor must recover
 * the mutex and either published record when present, and write its entry;
 * some kill points precede publication or follow the unlink. State committed
 * before the kill must survive. Cases cover a prepared staging directory,
 * mutex publication, lock-file publication, reclaim, and each release step.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const WRITER = resolve(import.meta.dir, "../fixtures/migration-state-writer.ts");
const EXIT_TIMEOUT_MS = 15_000;

interface Case {
  point: string;
  mode: "write" | "release";
  seedDeadLock: boolean;
}

const CASES: Case[] = [
  { point: "migration-lock-guard-publish", mode: "write", seedDeadLock: false },
  { point: "migration-lock-guard-published", mode: "write", seedDeadLock: false },
  { point: "migration-lock-publish", mode: "write", seedDeadLock: false },
  { point: "migration-lock-published", mode: "write", seedDeadLock: false },
  { point: "migration-lock-reclaim", mode: "write", seedDeadLock: true },
  { point: "migration-lock-reclaimed", mode: "write", seedDeadLock: true },
  { point: "migration-lock-release-revoked", mode: "release", seedDeadLock: false },
  { point: "migration-lock-release-guard", mode: "release", seedDeadLock: false },
  { point: "migration-lock-release-verified", mode: "release", seedDeadLock: false },
  { point: "migration-lock-release-unlinked", mode: "release", seedDeadLock: false },
];

interface Child {
  pid: number;
  exited: Promise<number>;
  kill: (code?: number) => void;
}

const cleanup: Array<{ root: string; pauseDir: string }> = [];
const children: Child[] = [];

afterEach(async () => {
  for (const child of children) {
    try {
      child.kill(9);
    } catch {
      /* already gone */
    }
  }
  for (const child of children) {
    await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  children.length = 0;
  for (const entry of cleanup) {
    rmSync(entry.root, { recursive: true, force: true });
    rmSync(entry.pauseDir, { recursive: true, force: true });
  }
  cleanup.length = 0;
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

describe("migration-lock kill boundaries (flair#2866)", () => {
  for (const testCase of CASES) {
    it(`recovers after a kill at ${testCase.point}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "flair-lock-crash-2866-"));
      const pauseDir = mkdtempSync(join(tmpdir(), "flair-lock-crash-pause-2866-"));
      cleanup.push({ root, pauseDir });
      const statePath = join(root, ".migrations", "state.json");
      const lockPath = join(dirname(statePath), "lock");
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      writeFileSync(
        statePath,
        JSON.stringify({ "mig-prior": { lastOutcome: "halted", reason: "prior" } }, null, 2) + "\n",
      );

      const spawn = (id: string, holdUntil: string, mode: "write" | "release"): Child => {
        const proc = Bun.spawn(
          [process.execPath, "run", WRITER, statePath, id, pauseDir, holdUntil, mode],
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
      };

      if (testCase.seedDeadLock) {
        const seed = spawn("mig-seed", "go.release-seed", "write");
        await waitFor(join(pauseDir, "written.mig-seed"), "the seeded entry");
        seed.kill(9);
        await waitExit(seed, "seed");
      }

      writeFileSync(join(pauseDir, `arm.${testCase.point}`), "");
      const victim = spawn("mig-victim", "go.release-victim", testCase.mode);
      if (testCase.mode === "release") {
        await waitFor(join(pauseDir, "written.mig-victim"), "the victim's entry");
        writeFileSync(join(pauseDir, "go.release-victim"), "");
      }
      await waitFor(join(pauseDir, `paused.${testCase.point}`), `the victim's pause at ${testCase.point}`);
      victim.kill(9);
      await waitExit(victim, "victim");

      const survivor = spawn("mig-survivor", "go.release-survivor", "write");
      await waitFor(join(pauseDir, "written.mig-survivor"), "the survivor's entry");
      const holder = JSON.parse(readFileSync(lockPath, "utf-8"));
      expect(holder.pid).toBe(survivor.pid);
      writeFileSync(join(pauseDir, "go.release-survivor"), "");
      expect(await waitExit(survivor, "survivor")).toBe(0);

      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state["mig-prior"]).toMatchObject({ lastOutcome: "halted", reason: "prior" });
      expect(state["mig-survivor"]).toMatchObject({ lastOutcome: "success", completedAtVersion: "writer-2866" });
      if (testCase.seedDeadLock) expect(state["mig-seed"]).toMatchObject({ lastOutcome: "success" });
      if (testCase.mode === "release") expect(state["mig-victim"]).toMatchObject({ lastOutcome: "success" });
      expect(existsSync(lockPath)).toBe(false);
      const guard = `${lockPath}.guard`;
      expect(existsSync(guard)).toBe(true);
      expect(readdirSync(guard)).toEqual([]);
    }, 30_000);
  }
});
