// agent-rotation-lock-3151.test.ts — flair#3151 lock module: identity-checked
// release, and refusal of a lock path that is not a regular file.
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentRotationLock } from "../../src/lib/agent-rotation-lock.js";

const cleanup: Array<() => void> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-3151-unit-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe("flair#3151 — agent rotation lock", () => {
  it("release removes the lock file it created", () => {
    const dir = tempDir();
    const res = acquireAgentRotationLock({ id: "agent-a", keysDir: dir });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(existsSync(res.lock.path)).toBe(true);
    res.lock.release();
    expect(existsSync(res.lock.path)).toBe(false);
  });

  it("release leaves a different file at the lock path in place", () => {
    const dir = tempDir();
    const res = acquireAgentRotationLock({ id: "agent-a", keysDir: dir });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Created while the lock file still exists, so the two have distinct
    // inodes without depending on whether a freed inode is reused.
    const replacement = join(dir, "replacement");
    writeFileSync(replacement, "replacement\n");
    renameSync(replacement, res.lock.path);

    res.lock.release();
    expect(readFileSync(res.lock.path, "utf-8")).toBe("replacement\n");
  });

  it("refuses a lock path that is a directory", () => {
    const dir = tempDir();
    const lockPath = join(dir, "agent-a.rotate-key.lock");
    mkdirSync(lockPath);

    const res = acquireAgentRotationLock({ id: "agent-a", keysDir: dir, retry: { attempts: 2, delayMs: 1 } });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain(lockPath);
    expect(res.message).toContain("not a regular file");
    expect(res.message).toMatch(/only once no rotation of that agent is running/);
  });

  it("refuses a lock path that is a symlink without reading its target", () => {
    const dir = tempDir();
    const target = join(dir, "target");
    writeFileSync(target, "target\n");
    const lockPath = join(dir, "agent-a.rotate-key.lock");
    symlinkSync(target, lockPath);

    const res = acquireAgentRotationLock({ id: "agent-a", keysDir: dir, retry: { attempts: 2, delayMs: 1 } });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("not a regular file");
    expect(res.message).toContain("a symlink");
    expect(readFileSync(target, "utf-8")).toBe("target\n");
  });

  it("a FIFO at the lock path is refused within the child's budget and touches no key file", () => {
    const dir = tempDir();
    const keysDir = join(dir, "keys");
    mkdirSync(keysDir);
    const id = "agent-a";
    const keyPath = join(keysDir, `${id}.key`);
    const seed = Buffer.alloc(32, 7);
    writeFileSync(keyPath, seed);
    chmodSync(keyPath, 0o600);
    const lockPath = join(keysDir, `${id}.rotate-key.lock`);
    const made = spawnSync("mkfifo", [lockPath], { timeout: 5_000 });
    expect(made.status, "mkfifo must create the pipe").toBe(0);

    const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
    const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const key of ["FLAIR_ADMIN_PASS", "FLAIR_AGENT_ID", "FLAIR_TOKEN", "HDB_ADMIN_PASSWORD", "FLAIR_KEY_DIR", "FLAIR_TEST_ROTATE_KEY_PAUSE"]) delete childEnv[key];
    childEnv.HOME = dir;

    const started = Date.now();
    const run = spawnSync("bun", [
      cliPath, "agent", "rotate-key", id,
      "--ops-port", "11911", "--port", "11912",
      "--admin-pass", "throwaway-admin-pass-not-a-secret", "--admin-user", "admin",
      "--keys-dir", keysDir,
    ], { env: childEnv, encoding: "utf-8", timeout: 8_000 });
    const elapsed = Date.now() - started;

    expect(run.status, String(run.stderr).slice(0, 500)).toBe(1);
    expect(run.stderr).toContain(lockPath);
    expect(run.stderr).toContain("not a regular file");
    expect(run.stderr).toMatch(/only once no rotation of that agent is running/);
    expect(elapsed).toBeLessThan(4_000);
    expect(readFileSync(keyPath).equals(seed)).toBe(true);
    expect(readdirSync(keysDir).sort()).toEqual([`${id}.key`, `${id}.rotate-key.lock`].sort());
    expect(lstatSync(lockPath).isFIFO()).toBe(true);
  }, 20_000);
});
