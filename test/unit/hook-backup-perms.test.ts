/**
 * hook-backup-perms.test.ts — flair#1778 slice 2c-i-c round 2.
 *
 * The `<path>.bak` hook-config backup may hold SECRET material (a
 * `~/.claude/settings.json` carrying a token), so it must be 0600 ALWAYS —
 * both when it is created and when a pre-existing `.bak` is overwritten. The
 * old `backupBytesTo` was a bare `writeFileSync(dest, bytes)`, so under umask
 * 022 a 0600 settings.json produced a 0644 `.bak` with the bytes verbatim, and
 * because the critical-section primitive backs up on EVERY call that reaches
 * the read, a no-op run wrote it too.
 *
 * Every fixture drives the PRODUCTION writers under umask 022 in a temp HOME:
 *   (a) 0600 settings + a token → fixSessionStartHook (doctor) AND installHook
 *       (hook-install) → the `.bak` is 0600;
 *   (b) a PRE-EXISTING 0644 `.bak` → after one writer call the `.bak` is 0600
 *       (the case a create-only fix misses — RED at c45e929f);
 *   (c) a NO-OP call (the hook is already present) → the `.bak` is 0600;
 *   (d) the backup-failure refusal still fires by name → nothing written to the
 *       target.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixSessionStartHook } from "../../src/doctor-client.ts";
import { hookBackupPath, hookSettingsPath, installHook } from "../../src/hook-install.ts";

const AGENT = "permbot";
const URL = "http://127.0.0.1:19926";
// A deliberately-fake placeholder (never a real secret); we never print bytes.
const FAKE_TOKEN = "FAKE-TOKEN-fixture-not-a-secret";

let isoHome: string;
let prevUmask: number;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-2cic-perms-"));
  prevUmask = process.umask(0o022);
});
afterEach(() => {
  process.umask(prevUmask);
  rmSync(isoHome, { recursive: true, force: true });
});

const settingsPath = () => join(isoHome, ".claude", "settings.json");
const mode = (p: string) => statSync(p).mode & 0o777;

function writeSettings(modeBits: number): void {
  mkdirSync(join(isoHome, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ model: "opus", token: FAKE_TOKEN }) + "\n", { mode: modeBits });
  chmodSync(settingsPath(), modeBits); // writeFileSync's mode is create-only under umask
}

describe("fixture (a) — a NEW .bak is created 0600", () => {
  it("doctor writer (fixSessionStartHook) on a 0600 settings file → .bak 0600", () => {
    writeSettings(0o600);
    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(true);
    expect(existsSync(hookBackupPath(settingsPath()))).toBe(true);
    expect(mode(hookBackupPath(settingsPath()))).toBe(0o600);
  });

  it("hook-install writer (installHook) on a 0600 settings file → .bak 0600", () => {
    writeSettings(0o600);
    const res = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(res.ok).toBe(true);
    expect(existsSync(hookBackupPath(hookSettingsPath(isoHome, "claude-code")))).toBe(true);
    expect(mode(hookBackupPath(hookSettingsPath(isoHome, "claude-code")))).toBe(0o600);
  });
});

describe("fixture (b) — an EXISTING 0644 .bak is tightened to 0600", () => {
  it("doctor writer (fixSessionStartHook): a pre-existing 0644 .bak becomes 0600", () => {
    writeSettings(0o600);
    // A `.bak` left by an older release, world/group readable.
    writeFileSync(hookBackupPath(settingsPath()), "old backup\n", { mode: 0o644 });
    chmodSync(hookBackupPath(settingsPath()), 0o644);
    expect(mode(hookBackupPath(settingsPath()))).toBe(0o644); // precondition

    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(true);
    // A create-only fix (writeFileSync mode / openSync "wx") would leave this 0644.
    expect(mode(hookBackupPath(settingsPath()))).toBe(0o600);
  });

  it("hook-install writer (installHook): a pre-existing 0644 .bak becomes 0600", () => {
    writeSettings(0o600);
    const path = hookSettingsPath(isoHome, "claude-code");
    writeFileSync(hookBackupPath(path), "old backup\n", { mode: 0o644 });
    chmodSync(hookBackupPath(path), 0o644);

    const res = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(res.ok).toBe(true);
    expect(mode(hookBackupPath(path))).toBe(0o600);
  });
});

describe("fixture (c) — a NO-OP call still backs up 0600", () => {
  it("doctor writer (fixSessionStartHook): the second (already-present) call writes a 0600 .bak", () => {
    // First call installs the hook.
    expect(fixSessionStartHook(isoHome, AGENT).ok).toBe(true);
    // Simulate an old 0644 .bak, then make the next call a NO-OP.
    writeFileSync(hookBackupPath(settingsPath()), "old backup\n", { mode: 0o644 });
    chmodSync(hookBackupPath(settingsPath()), 0o644);

    const noop = fixSessionStartHook(isoHome, AGENT);
    expect(noop.ok).toBe(true);
    expect(noop.message).toContain("already present"); // it really was a no-op
    // The primitive backs up on no-op calls too — and it is 0600.
    expect(mode(hookBackupPath(settingsPath()))).toBe(0o600);
  });
});

describe("fixture (d) — a backup failure still refuses by name, nothing written", () => {
  it("doctor writer (fixSessionStartHook): a .bak path that cannot be replaced → named refusal, target untouched", () => {
    writeSettings(0o600);
    const before = readFileSync(settingsPath(), "utf-8");
    // The backup's destination is a DIRECTORY, so the temp→rename replace fails.
    mkdirSync(hookBackupPath(settingsPath()));

    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("backup failed before deciding");
    expect(res.message).toContain("nothing written");
    // Nothing written to the target.
    expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
    // No staging temp left behind.
    expect(readdirSync(join(isoHome, ".claude")).filter((f) => f.includes(".bak.tmp-")).length).toBe(0);
  });
});
