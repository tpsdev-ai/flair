/**
 * hook-backup-write-hardening.test.ts — flair#1778 follow-up to #1824.
 *
 * backupBytesTo re-implemented the primitive's staging write and dropped two of
 * its protections, so this pins them through the production helper:
 *   (a) SHORT WRITE — a low-level write that returns a PARTIAL count must still
 *       land the whole buffer (the writeAllSync loop). A truncated temp renamed
 *       into place is a false recovery copy.
 *   (b) WRITE / FSYNC FAILURE — a throwing write or fsync must throw AND leave
 *       no `<path>.bak.tmp-*` behind (partial token bytes).
 *   (c) SYMLINK — a `<path>.bak` planted as a symlink to a victim file must end
 *       up a REGULAR 0600 file holding the backup bytes, with the victim
 *       untouched (the temp + rename shape; a regression guard for #1824).
 *
 * The write/fsync seam is the helper's test-only `io` parameter — inert in
 * production, where the primitive calls backupBytesTo(path, bytes) only.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixSessionStartHook } from "../../src/doctor-client.ts";
import { hookBackupPath } from "../../src/hook-install.ts";
import { backupBytesTo } from "../../src/lib/settings-bytes.ts";

const AGENT = "hardenbot";

let isoHome: string;
beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1824-harden-"));
});
afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
});

const settingsPath = () => join(isoHome, ".claude", "settings.json");
const tempLeftovers = () => readdirSync(join(isoHome, ".claude")).filter((f) => f.includes(".bak.tmp-"));

describe("(a) a short-writing writeSync still lands ALL bytes", () => {
  it("a partial-count write is looped to completion; .bak holds the full buffer", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const bytes = new TextEncoder().encode("S".repeat(5000) + "\n");
    let calls = 0;
    const bak = backupBytesTo(settingsPath(), bytes, {
      write: (fd: number, buf: Buffer, off: number, len: number) => {
        calls++;
        const n = Math.min(7, len); // a short write every time
        writeSync(fd, buf, off, n);
        return n;
      },
    });
    // The loop ran (a single writeSync would have written 7 bytes)…
    expect(calls).toBeGreaterThan(1);
    // …and every byte landed.
    expect(readFileSync(bak)).toEqual(Buffer.from(bytes));
  });
});

describe("(b) a write / fsync failure throws and leaks no temp", () => {
  it("a throwing writeSync: the call throws AND no .bak.tmp-* remains", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const bytes = new TextEncoder().encode('{"token":"x"}\n');
    expect(() =>
      backupBytesTo(settingsPath(), bytes, {
        write: () => {
          throw new Error("injected write failure");
        },
      }),
    ).toThrow();
    expect(tempLeftovers()).toEqual([]);
  });

  it("a throwing fsyncSync: the call throws AND no .bak.tmp-* remains", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const bytes = new TextEncoder().encode('{"token":"x"}\n');
    expect(() =>
      backupBytesTo(settingsPath(), bytes, {
        fsync: () => {
          throw new Error("injected fsync failure");
        },
      }),
    ).toThrow();
    expect(tempLeftovers()).toEqual([]);
  });

  it("a write failure through a PRODUCTION writer refuses by name and leaks no temp", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ model: "opus" }) + "\n", { mode: 0o600 });
    // The primitive's backup runs backupBytesTo with no io, so this fixture
    // only proves the refusal path is unchanged for a genuine backup failure
    // (the destination is a directory → rename fails → named refusal).
    mkdirSync(hookBackupPath(settingsPath()));
    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("backup failed before deciding");
    expect(tempLeftovers()).toEqual([]);
  });
});

describe("(c) a symlinked .bak is replaced, not written through", () => {
  it("after one production writer call the .bak is a regular 0600 file; the victim is untouched", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const original = JSON.stringify({ model: "opus" }) + "\n";
    writeFileSync(settingsPath(), original, { mode: 0o600 });
    // Plant <path>.bak as a symlink to a victim file.
    const victim = join(isoHome, "victim.txt");
    writeFileSync(victim, "VICTIM-BYTES\n", { mode: 0o644 });
    symlinkSync(victim, hookBackupPath(settingsPath()));

    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(true);

    const bakStat = lstatSync(hookBackupPath(settingsPath()));
    expect(bakStat.isSymbolicLink()).toBe(false); // the link was replaced
    expect(bakStat.isFile()).toBe(true);
    expect(statSync(hookBackupPath(settingsPath())).mode & 0o777).toBe(0o600);
    // The .bak holds the in-lock settings bytes …
    expect(readFileSync(hookBackupPath(settingsPath()), "utf-8")).toBe(original);
    // … and the symlink's victim was NOT written through.
    expect(readFileSync(victim, "utf-8")).toBe("VICTIM-BYTES\n");
  });
});
