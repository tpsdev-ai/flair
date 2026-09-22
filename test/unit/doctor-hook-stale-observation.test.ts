/**
 * doctor-hook-stale-observation.test.ts — flair#1778 slice 2c-i-c,
 * fixture C3 (stale-observation mutation).
 *
 * A doctor writer whose VERDICT can change between read and write must decide
 * on the IN-LOCK bytes, never on a pre-lock read. `fixContinuityCaptureHooks`
 * runs `computeContinuityHookInstall`, whose per-event `decidePinWrite` reads
 * the EXISTING hook command — so a competing pin change is a real verdict
 * flip, not a no-op.
 *
 * Schedule: the child arms INSIDE the production primitive (the
 * FLAIR_TEST_CRITICAL_BARRIER `preObserve` seam, between the pre-lock
 * observation and the lock); the parent lands a competing pin change (the
 * continuity pair re-pinned AHEAD of the running CLI) at that seam, then
 * releases the child. On the branch the in-lock verdict sees the AHEAD pin and
 * HOLDS — the file still carries 9.9.9 afterwards. A MUTATION that decides on
 * the pre-lock parse reports the STALE pin instead (shown by re-running with
 * that mutation; see the PR).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTINUITY_POST_TOOL_USE_MATCHER,
  buildContinuityCaptureHookCommand,
  fixContinuityCaptureHooks,
} from "../../src/doctor-client.ts";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const doctorModule = join(repoRoot, "src", "doctor-client.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 40_000;
const AGENT = "contbot";
const URL = "http://127.0.0.1:19926";
const AHEAD_PIN = "9.9.9";

let home: string;
let barrierDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cic-stale-home-"));
  barrierDir = mkdtempSync(join(tmpdir(), "flair-2cic-stale-barrier-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(barrierDir, { recursive: true, force: true });
});

const settingsPath = () => join(home, ".claude", "settings.json");

/** A continuity pair for a bare version `pin` (buildContinuityCaptureHookCommand
 *  prefixes `@tpsdev-ai/flair-mcp@` itself). */
function writeContinuityPair(pin: string, matcher: string): void {
  const command = buildContinuityCaptureHookCommand(AGENT, URL, pin);
  expect(command).toContain(`@tpsdev-ai/flair-mcp@${pin}`);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        hooks: {
          PostToolUse: [{ matcher, hooks: [{ type: "command", command }] }],
          Stop: [{ hooks: [{ type: "command", command }] }],
        },
      },
      null,
      2,
    ) + "\n",
  );
}

function harnessSource(): string {
  return [
    `import { fixContinuityCaptureHooks } from ${JSON.stringify(doctorModule)};`,
    "const res = fixContinuityCaptureHooks(process.env.HOME, 'contbot', 'http://127.0.0.1:19926');",
    "console.log(JSON.stringify({ ok: res.ok, changed: res.changed, message: res.message }));",
    "process.exit(res.ok ? 0 : 1);",
  ].join("\n");
}

function runHarness(harnessPath: string) {
  const child = spawn("bun", [harnessPath], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, FLAIR_TEST_CRITICAL_BARRIER: barrierDir },
    timeout: CHILD_DEADLINE_MS,
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => (out += d.toString()));
  child.stderr?.on("data", (d) => (err += d.toString()));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, out, err }));
  });
  return { child, done };
}

async function waitForArms(n: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (readdirSync(barrierDir).filter((f) => f.endsWith(".preObserve")).length >= n) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("fixture C3 — a verdict-changing competing pin change between observe and write", () => {
  it("the in-lock verdict sees the competing AHEAD pin and HOLDS (a pre-lock decide reports the stale pin)", async () => {
    // Baseline: a repairable continuity pair pinned at the RUNNING CLI, with a
    // stale PostToolUse matcher so the doctor writer has real work to do.
    writeContinuityPair(flairCliVersion(), "Bash");

    const harnessPath = join(home, "harness.mjs");
    writeFileSync(harnessPath, harnessSource(), "utf-8");

    const child = runHarness(harnessPath);
    // The child arms INSIDE the production primitive (the preObserve seam).
    const armed = await waitForArms(1, 8000);
    expect(armed, "child never armed at the primitive's pre-observe boundary").toBe(true);

    // The competing pin change lands AFTER the child's pre-lock observation and
    // BEFORE its write: the pair is now AHEAD of the running CLI.
    writeContinuityPair(AHEAD_PIN, CONTINUITY_POST_TOOL_USE_MATCHER);
    writeFileSync(join(barrierDir, "go"), "1");

    const r = await child.done;
    const diag = `A=${JSON.stringify(r)}`;
    expect(r.code, `doctor child failed: ${diag}`).toBe(0);
    const line = JSON.parse(r.out.trim().split("\n").pop()!) as { ok: boolean; changed: boolean; message: string };
    // The writer decided on the IN-LOCK bytes: it saw the AHEAD pin and held.
    expect(line.ok, `expected a hold, got: ${diag}`).toBe(true);
    expect(line.changed, `expected no write, got: ${diag}`).toBe(false);
    expect(line.message, `expected the IN-LOCK pin named, got: ${diag}`).toContain("holding");
    expect(line.message).toContain(AHEAD_PIN);

    // The AHEAD pin survives: the writer did NOT lower it to the running CLI.
    const after = readFileSync(settingsPath(), "utf-8");
    expect(after).toContain(`@${AHEAD_PIN}`);
    expect(after).not.toContain(`@${flairCliVersion()}`);
  }, CASE_BUDGET_MS);
});
