/**
 * doctor-hook-report-parity.test.ts — flair#1778 slice 2c-i-c, fixture C4.
 *
 * REPORT PARITY — a REGRESSION guard, NOT a fails-on-main check: every line
 * `flair doctor --fix` and `flair init` print for the four migrated hook
 * writers (fixed / already-present / held / refused / --skip-hook) is
 * byte-identical to what the raw writers printed before the migration, and
 * each REFUSAL MAPPING row (unparseable JSON / a held pin / a backup failure)
 * resolves to the expected string.
 *
 * The `held` case names the IN-LOCK pin: the writer decides on the locked
 * snapshot, so the hold line names the version it actually saw.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SESSION_START_HOOK_MARKER,
  applyOrReportSessionStartHook,
  buildContinuityCaptureHookCommand,
  buildSessionStartHookCommand,
  fixContinuityCaptureHooks,
  fixSessionStartHook,
  removeContinuityCaptureHooks,
  upgradeSessionStartHookCommand,
} from "../../src/doctor-client.ts";

const AGENT = "paritybot";
const URL = "http://127.0.0.1:19926";
const AHEAD_PIN = "9.9.9";

let isoHome: string;
beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-2cic-parity-"));
});
afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
});

const settingsPath = () => join(isoHome, ".claude", "settings.json");

/** The reason V8's JSON.parse reports for `text` — the runtime-specific part of
 *  the pre-migration `could not write <path>: <reason>` line. Computed rather
 *  than hard-coded so the assertion is exact on every Node version. */
function jsonParseReason(text: string): string {
  try {
    JSON.parse(text);
    return "(unexpectedly parsed)";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function writeSettings(value: unknown): void {
  mkdirSync(join(isoHome, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(value, null, 2) + "\n");
}

describe("C4 REPORT PARITY — a REGRESSION guard (not a fails-on-main check)", () => {
  it("fixSessionStartHook: absent → 'added ... (agent ...)' (doctor's own line)", () => {
    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(true);
    expect(res.message).toBe(`added SessionStart hook to ${settingsPath()} (agent '${AGENT}')`);
  });

  it("fixSessionStartHook: already present → 'already present in <path>' (byte-identical)", () => {
    writeSettings({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `FLAIR_AGENT_ID=${AGENT} npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}` }] }] } });
    const before = readFileSync(settingsPath(), "utf-8");
    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(true);
    expect(res.message).toBe(`already present in ${settingsPath()}`);
    expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
  });

  it("fixContinuityCaptureHooks: absent → 'wired the continuity capture hooks ... (agent ...)'", () => {
    const res = fixContinuityCaptureHooks(isoHome, AGENT, URL);
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.message).toBe(`wired the continuity capture hooks (PostToolUse + Stop) in ${settingsPath()} (agent '${AGENT}')`);
  });

  it("fixContinuityCaptureHooks: already current → 'continuity capture hooks already current in <path>'", () => {
    fixContinuityCaptureHooks(isoHome, AGENT, URL);
    const res = fixContinuityCaptureHooks(isoHome, AGENT, URL);
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.message).toBe(`continuity capture hooks already current in ${settingsPath()}`);
  });

  it("removeContinuityCaptureHooks: nothing wired → 'no <path> — continuity capture hooks are not enabled'", () => {
    const res = removeContinuityCaptureHooks(isoHome);
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.message).toBe(`no ${settingsPath()} — continuity capture hooks are not enabled`);
  });

  it("upgradeSessionStartHookCommand: already current → 'SessionStart hook in <path> is already current'", () => {
    const command = buildSessionStartHookCommand(AGENT, undefined, { harness: "claude-code" });
    writeSettings({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } });
    const res = upgradeSessionStartHookCommand(isoHome);
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.message).toBe(`SessionStart hook in ${settingsPath()} is already current`);
  });

  it("init's lines: already-wired and --skip-hook are unchanged (the surface init owns)", () => {
    writeSettings({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `FLAIR_AGENT_ID=${AGENT} npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}` }] }] } });
    const present = applyOrReportSessionStartHook(isoHome, AGENT, false);
    expect(present.applied).toBe(false);
    expect(present.ok).toBe(true);
    expect(present.message).toBe(`SessionStart hook already wired in ${settingsPath()}`);

    rmSync(join(isoHome, ".claude"), { recursive: true, force: true });
    const skipped = applyOrReportSessionStartHook(isoHome, AGENT, true);
    expect(skipped.applied).toBe(false);
    expect(skipped.ok).toBe(false);
    expect(skipped.message).toBe("SessionStart hook skipped (--skip-hook)");
    expect(skipped.hint).toContain(SESSION_START_HOOK_MARKER);
    expect(existsSync(settingsPath())).toBe(false);
  });

  // ── REFUSAL MAPPING rows ───────────────────────────────────────────────────

  it("(a) unparseable JSON → the pre-migration 'could not write <path>: <reason>' line, nothing written", () => {
    const malformed = "{ not valid json, definitely broken";
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), malformed);
    const expectedReason = jsonParseReason(malformed);

    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(false);
    // EXACT pre-migration line: 'could not write <path>: <the JSON.parse reason>'.
    expect(res.message).toBe(`could not write ${settingsPath()}: ${expectedReason}`);
    expect(readFileSync(settingsPath(), "utf-8")).toBe(malformed);
  });

  it("(a) unparseable JSON on the REMOVAL writer → the pre-migration 'could not update <path>: <reason>' line", () => {
    const malformed = "{ not valid json, definitely broken";
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), malformed);
    const expectedReason = jsonParseReason(malformed);

    const res = removeContinuityCaptureHooks(isoHome);
    expect(res.ok).toBe(false);
    expect(res.message).toBe(`could not update ${settingsPath()}: ${expectedReason}`);
    expect(readFileSync(settingsPath(), "utf-8")).toBe(malformed);
  });

  it("(b) a held pin → the in-lock hold line names the version it saw, nothing written", () => {
    writeSettings({
      hooks: {
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: buildContinuityCaptureHookCommand(AGENT, URL, AHEAD_PIN) }] }],
        Stop: [{ hooks: [{ type: "command", command: buildContinuityCaptureHookCommand(AGENT, URL, AHEAD_PIN) }] }],
      },
    });
    const before = readFileSync(settingsPath(), "utf-8");
    const res = fixContinuityCaptureHooks(isoHome, AGENT, URL);
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.message).toContain("holding");
    expect(res.message).toContain("9.9.9"); // names the IN-LOCK pin
    expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
  });

  it("(c) a backup failure → the primitive's named refusal, nothing written", () => {
    writeSettings({ model: "opus" });
    // Force the backup to fail: the sibling `<path>.bak` is a directory, so the
    // backup write cannot land. A backup runs on the IN-LOCK bytes before decide.
    mkdirSync(`${settingsPath()}.bak`);
    const before = readFileSync(settingsPath(), "utf-8");

    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("backup failed before deciding");
    expect(res.message).toContain("nothing written");
    expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
  });
});
