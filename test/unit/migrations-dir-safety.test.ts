/**
 * migrations-dir-safety.test.ts — resources/migrations/dir-safety.ts's 0700
 * enforcement (Sherlock verdict: "0700 via stat-verify after creation
 * (umask can override mkdir mode) and before writes; refuse with the path +
 * actual perms named in the error.")
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, chmodSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSecureDir, verifySecureDir, writeSecureFile, UnsafeDirectoryError } from "../../resources/migrations/dir-safety.ts";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-migration-dirsafety-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("ensureSecureDir — creation", () => {
  it("creates a fresh directory at 0700", () => {
    const dir = join(testRoot, "fresh");
    ensureSecureDir(dir);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("is idempotent — calling it again on an already-0700 dir doesn't throw", () => {
    const dir = join(testRoot, "fresh");
    ensureSecureDir(dir);
    expect(() => ensureSecureDir(dir)).not.toThrow();
  });

  it("creates nested parent directories as needed", () => {
    const dir = join(testRoot, "a", "b", "c");
    ensureSecureDir(dir);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("remediates a world/group-readable EXISTING directory back to 0700 (the umask-widened-mkdir case)", () => {
    const dir = join(testRoot, "widened");
    mkdirSync(dir);
    chmodSync(dir, 0o755); // simulate a permissive umask having widened it
    expect(statSync(dir).mode & 0o777).toBe(0o755);

    ensureSecureDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("verifySecureDir — refusal", () => {
  it("throws UnsafeDirectoryError naming the path and actual octal perms for a group/other-readable dir", () => {
    const dir = join(testRoot, "insecure");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o755);

    let thrown: unknown;
    try {
      verifySecureDir(dir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnsafeDirectoryError);
    const err = thrown as UnsafeDirectoryError;
    expect(err.path).toBe(dir);
    expect(err.actualMode).toBe(0o755);
    expect(err.message).toContain(dir);
    expect(err.message).toContain("0755");
  });

  it("does NOT throw for a genuinely 0700 directory", () => {
    const dir = join(testRoot, "secure");
    mkdirSync(dir, { mode: 0o700 });
    expect(() => verifySecureDir(dir)).not.toThrow();
  });

  it("refuses a world-writable directory too (not just world-readable)", () => {
    const dir = join(testRoot, "writable");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o707);
    expect(() => verifySecureDir(dir)).toThrow(UnsafeDirectoryError);
  });
});

describe("writeSecureFile — re-verifies at write time, not only creation", () => {
  it("writes the file when the directory is still 0700", () => {
    const dir = join(testRoot, "ok");
    ensureSecureDir(dir);
    const file = join(dir, "manifest.json");
    writeSecureFile(file, "{}", dir);
    expect(existsSync(file)).toBe(true);
  });

  it("refuses to write when the directory was re-permissioned AFTER creation (write-time check, per Kern's requirement)", () => {
    const dir = join(testRoot, "was-secure");
    ensureSecureDir(dir);
    // Something else on the host widened it between creation and this write.
    chmodSync(dir, 0o755);
    const file = join(dir, "manifest.json");
    expect(() => writeSecureFile(file, "{}", dir)).toThrow(UnsafeDirectoryError);
    expect(existsSync(file)).toBe(false);
  });
});
