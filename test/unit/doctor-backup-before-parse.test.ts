/**
 * doctor-backup-before-parse.test.ts — flair#1778 slice 2c-i-c, fixture C6.
 *
 * The existing backup-before-parse fixtures (test/unit/hook-install.test.ts)
 * drive the HOOK-INSTALL writers only, so a mutation on a DOCTOR writer cannot
 * fail them. This adds the doctor-writer counterpart: malformed settings bytes
 * → the migrated doctor writer REFUSES by name, writes NOTHING to the target,
 * and the sibling `<path>.bak` holds the malformed bytes EXACTLY (the backup
 * runs on the IN-LOCK bytes BEFORE the parse, exactly like `installHook`).
 *
 * FAILS-ON-MAIN (292a1152): the raw doctor writers took no backup on the parse
 * failure, so `<path>.bak` would not exist.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixContinuityCaptureHooks, fixSessionStartHook } from "../../src/doctor-client.ts";
import { hookBackupPath } from "../../src/hook-install.ts";

const AGENT = "backupbot";

let isoHome: string;
beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-2cic-backup-"));
});
afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
});

const settingsPath = () => join(isoHome, ".claude", "settings.json");

function writeMalformed(bytes: string): void {
  mkdirSync(join(isoHome, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), bytes);
}

describe("C6 — a DOCTOR hook writer backs up the in-lock bytes before parsing", () => {
  it("fixSessionStartHook: malformed bytes → refuses by name, target untouched, <path>.bak == the malformed bytes", () => {
    const malformed = "{ not valid json, definitely broken";
    writeMalformed(malformed);

    const res = fixSessionStartHook(isoHome, AGENT);

    expect(res.ok).toBe(false);
    expect(res.message).toContain(settingsPath()); // refuses BY NAME
    // Nothing written to the target — never truncated, never a partial write.
    expect(readFileSync(settingsPath(), "utf-8")).toBe(malformed);
    // The backup exists and holds the malformed bytes exactly.
    expect(existsSync(hookBackupPath(settingsPath()))).toBe(true);
    expect(readFileSync(hookBackupPath(settingsPath()), "utf-8")).toBe(malformed);
    // The backup may hold secret material, so it is 0600 (round 2).
    expect(statSync(hookBackupPath(settingsPath())).mode & 0o777).toBe(0o600);
  });

  it("fixContinuityCaptureHooks: malformed bytes → refuses by name, target untouched, <path>.bak == the malformed bytes", () => {
    const malformed = "not json at all {{{";
    writeMalformed(malformed);

    const res = fixContinuityCaptureHooks(isoHome, AGENT, "http://127.0.0.1:19926");

    expect(res.ok).toBe(false);
    expect(res.message).toContain(settingsPath());
    expect(readFileSync(settingsPath(), "utf-8")).toBe(malformed);
    expect(existsSync(hookBackupPath(settingsPath()))).toBe(true);
    expect(readFileSync(hookBackupPath(settingsPath()), "utf-8")).toBe(malformed);
    // The backup may hold secret material, so it is 0600 (round 2).
    expect(statSync(hookBackupPath(settingsPath())).mode & 0o777).toBe(0o600);
  });
});
