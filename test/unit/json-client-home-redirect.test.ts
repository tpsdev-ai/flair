/**
 * json-client-home-redirect.test.ts — flair#1778 slice 2c-i-d1, fixture E4.
 *
 * `flair init`'s Claude Code wiring must write under the LIVE home: an
 * in-process `HOME` change has to take effect. Under Bun `os.homedir()` is
 * fixed at LAUNCH, so the pre-fix inline writer (`join(homedir(),
 * ".claude.json")` in src/commands/init.ts) ignored an in-process HOME change
 * and would still write the REAL ~/.claude.json. init now DELEGATES to the
 * shared clients.ts writer, which resolves HOME through `resolveHome()`
 * (`process.env.HOME || USERPROFILE || homedir()`).
 *
 * RED at baa37f13: init.ts contained `join(homedir(), ".claude.json")` and no
 * delegated writer existed (the source assertion below fails there).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as clients from "../../src/install/clients.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const initSrc = readFileSync(join(repoRoot, "src", "commands", "init.ts"), "utf-8");

const ENV = { FLAIR_AGENT_ID: "homebot", FLAIR_URL: "http://127.0.0.1:19926", FLAIR_CLIENT: "claude-code" };

let launchHome: string;
let inProcHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  launchHome = mkdtempSync(join(tmpdir(), "flair-2cid-e4-launch-"));
  inProcHome = mkdtempSync(join(tmpdir(), "flair-2cid-e4-inproc-"));
  prevHome = process.env.HOME;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(launchHome, { recursive: true, force: true });
  rmSync(inProcHome, { recursive: true, force: true });
});

describe("E4 — an in-process HOME redirect lands init's Claude Code wiring under the redirected home", () => {
  it("init delegates its ~/.claude.json path to the shared writer (no os.homedir()-based path)", () => {
    // The pre-fix line, and the hand-built entry/write, are gone.
    expect(initSrc).not.toContain('join(homedir(), ".claude.json")');
    expect(initSrc).not.toContain("writeFileSync(claudeJsonPath");
    expect(initSrc).toContain("wireClaudeCodeJson(claudeEnv)");
  });

  it("the delegated writer (what init calls) resolves HOME at call time, not at launch", () => {
    const writeClaudeCodeJson = (clients as unknown as { wireClaudeCodeJson?: (e: typeof ENV) => unknown }).wireClaudeCodeJson;
    // On baa37f13 there is no delegated writer — init wrote the file itself
    // with os.homedir(). Present + live-HOME is the branch's guarantee.
    expect(typeof writeClaudeCodeJson).toBe("function");

    // Simulate the exact pre-fix hazard shape: a home seen at "launch", then an
    // in-process change. `resolveHome()` reads process.env.HOME at call time, so
    // the write must land under the CURRENT home.
    process.env.HOME = launchHome;
    process.env.HOME = inProcHome;
    const r = writeClaudeCodeJson!(ENV) as { kind: string };
    expect(r.kind).toBe("written");

    expect(existsSync(join(inProcHome, ".claude.json"))).toBe(true);
    expect(existsSync(join(launchHome, ".claude.json"))).toBe(false);
    const entry = JSON.parse(readFileSync(join(inProcHome, ".claude.json"), "utf-8")).mcpServers.flair;
    expect(entry.command).toBe("npx");
    expect(entry.env.FLAIR_CLIENT).toBe("claude-code");
  });
});
