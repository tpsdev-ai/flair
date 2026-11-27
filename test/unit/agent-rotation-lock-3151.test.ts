// agent-rotation-lock-3151.test.ts — flair#3151 lock module: identity-checked
// release, and refusal of a lock path that is not a regular file.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
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
import * as fs from "node:fs";
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

  it("release keeps a replacement lock whose inode differs only above 2^53", () => {
    const dir = tempDir();
    const lockPath = join(dir, "agent-a.rotate-key.lock");
    // Adjacent values above 2^53 that a JavaScript number cannot distinguish:
    // 2^54 and 2^54 + 1 both convert to 2^54, but differ as bigint.
    const created = { dev: 2n ** 54n, ino: 2n ** 54n };
    const replacement = { dev: 2n ** 54n, ino: 2n ** 54n + 1n };
    expect(Number(created.ino)).toBe(Number(replacement.ino));
    expect(created.ino).not.toBe(replacement.ino);

    const statFor = (identity: { dev: bigint; ino: bigint }, bigint: boolean) =>
      bigint
        ? { dev: identity.dev, ino: identity.ino, isFile: () => true }
        : { dev: Number(identity.dev), ino: Number(identity.ino), isFile: () => true };

    // Inject the create-time identity and the release-time identity: the
    // module asks for whichever representation it compares in.
    const fstat = spyOn(fs, "fstatSync").mockImplementation(((_fd: number, opts?: { bigint?: boolean }) =>
      statFor(created, opts?.bigint === true)) as unknown as typeof fs.fstatSync);
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((_p: string, opts?: { bigint?: boolean }) =>
      statFor(replacement, opts?.bigint === true)) as unknown as typeof fs.lstatSync);

    try {
      const res = acquireAgentRotationLock({ id: "agent-a", keysDir: dir });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const next = join(dir, "replacement");
      writeFileSync(next, "replacement\n");
      renameSync(next, res.lock.path);

      res.lock.release();
      expect(readFileSync(res.lock.path, "utf-8")).toBe("replacement\n");
    } finally {
      fstat.mockRestore();
      lstat.mockRestore();
    }
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

  it("reports an lstat error as an unchecked path", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "agent-a.rotate-key.lock"), "");
    const stat = spyOn(fs, "lstatSync").mockImplementation(() => {
      throw Object.assign(new Error("fixture I/O error"), { code: "EIO" });
    });
    let res;
    try {
      res = acquireAgentRotationLock({ id: "agent-a", keysDir: dir });
    } finally {
      stat.mockRestore();
    }
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("could not check the lock path (EIO)");
    expect(res.message).not.toContain("not a regular file");
  });

  for (const variant of ["symlink", "fifo", "blank", "partial"] as const) {
    it(`refuses the ${variant} lock record before a key read or request within the child's 4 s timeout`, () => {
      const dir = tempDir();
      const keysDir = join(dir, "keys");
      mkdirSync(keysDir, { mode: 0o700 });
      const keyPath = join(keysDir, "agent-a.key");
      const seed = Buffer.alloc(32, 7);
      writeFileSync(keyPath, seed, { mode: 0o600 });
      const lockPath = join(keysDir, "agent-a.rotate-key.lock");
      writeFileSync(lockPath, variant === "blank" ? "" : variant === "partial" ? "123 2026-11-26T00:00:00Z" : "123 timestamp host\n");
      if (variant === "symlink") writeFileSync(join(keysDir, "target"), "456 timestamp target-host\n");
      const before = readdirSync(keysDir).sort();
      const fixture = join(import.meta.dirname, "..", "fixtures", "agent-rotation-lock-race.ts");
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
      const started = Date.now();
      const run = spawnSync("bun", [fixture, keysDir, variant], {
        env: { ...env, HOME: dir }, encoding: "utf-8", timeout: 4_000,
      });
      expect(run.error, `${variant}: ${run.stderr}`).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(JSON.parse(run.stdout.trim().split("\n").at(-1)!)).toEqual({
        code: 1, keyReads: 0, requests: 0, swaps: variant === "symlink" || variant === "fifo" ? 1 : 0,
      });
      expect(run.stderr).toContain("an existing lock");
      expect(run.stderr).toContain("an unreadable or malformed lock record");
      expect(run.stderr).toContain(lockPath);
      expect(readFileSync(keyPath).equals(seed)).toBe(true);
      expect(readdirSync(keysDir).sort()).toEqual(before);
      if (variant === "symlink") expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
      if (variant === "fifo") expect(lstatSync(lockPath).isFIFO()).toBe(true);
    }, 15_000);
  }

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
