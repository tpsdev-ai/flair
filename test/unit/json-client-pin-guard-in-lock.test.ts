/**
 * json-client-pin-guard-in-lock.test.ts — flair#1778 slice 2c-i-d1, fixture E6.
 *
 * The never-lower guard must run on the IN-LOCK bytes. If a competing writer
 * lands an AHEAD pin after the JSON writer's pre-lock observation, the in-lock
 * decision must SEE it and HOLD — never lower it. This fixture uses the
 * primitive's own env-gated barrier (honored only by the migrated writer): the
 * production writer pauses after its pre-lock observation, the competing writer
 * commits an AHEAD pin, then the writer proceeds and must hold.
 *
 * MUTATION (reported): make the writer decide on the PRE-LOCK parse instead of
 * the in-lock bytes — the competing AHEAD pin is then invisible to the
 * decision and the pin is LOWERED (the `@0.0.1` entry is re-pinned to the
 * running CLI, discarding the `@9.9.9` the competitor wrote).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FLAIR_MCP_PACKAGE } from "../../src/lib/mcp-spec.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsModule = join(repoRoot, "src", "install", "clients.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 40_000;

let home: string;
let barrierDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cid-e6-home-"));
  barrierDir = mkdtempSync(join(tmpdir(), "flair-2cid-e6-barrier-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(barrierDir, { recursive: true, force: true });
});

const claudeJsonPath = () => join(home, ".claude.json");
const URL = "http://127.0.0.1:19926";
const AGENT = "guardbot";

/** The AHEAD entry a competing Flair writer commits during the writer's window. */
function aheadConfig(): string {
  return JSON.stringify({
    mcpServers: {
      flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@9.9.9`], env: { FLAIR_URL: URL, FLAIR_AGENT_ID: AGENT } },
    },
  }, null, 2) + "\n";
}

function harnessSource(): string {
  return [
    `import { wireClaudeCode } from ${JSON.stringify(clientsModule)};`,
    "const res = wireClaudeCode({ FLAIR_AGENT_ID: process.env.FLAIR_AGENT_ID, FLAIR_URL: process.env.FLAIR_URL, FLAIR_CLIENT: 'claude-code' });",
    "process.stdout.write(JSON.stringify(res));",
    "process.exit(res.ok ? 0 : 1);",
  ].join("\n");
}

async function runOnce(): Promise<{ message: string; code: number | null }> {
  // Baseline: a BEHIND pin, so a write WOULD happen absent the competing AHEAD.
  writeFileSync(claudeJsonPath(), JSON.stringify({
    mcpServers: { flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@0.0.1`], env: { FLAIR_URL: URL, FLAIR_AGENT_ID: AGENT } } },
  }, null, 2) + "\n");

  const harnessPath = join(home, "harness.mjs");
  writeFileSync(harnessPath, harnessSource(), "utf-8");

  const child = spawn("bun", [harnessPath], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, FLAIR_AGENT_ID: AGENT, FLAIR_URL: URL, FLAIR_TEST_CRITICAL_BARRIER: barrierDir },
    timeout: CHILD_DEADLINE_MS,
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += d.toString()));
  const done = new Promise<{ code: number | null }>((resolve) => child.on("close", (code) => resolve({ code })));

  // Wait for the writer to pause AFTER its pre-lock observation (or give the
  // raw writer time to finish on a baseline that never arms).
  const deadline = Date.now() + 6000;
  let armed = false;
  while (Date.now() < deadline) {
    if (readdirSync(barrierDir).some((f) => f.endsWith(".preObserve"))) { armed = true; break; }
    if (!existsSync(join(home, "harness.mjs"))) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  // The competing writer commits an AHEAD pin in the writer's window, then
  // releases it.
  writeFileSync(claudeJsonPath(), aheadConfig());
  writeFileSync(join(barrierDir, "go"), "1");

  const { code } = await done;
  return { message: out, code };
}

describe("E6 — the pin guard decides on the IN-LOCK bytes", () => {
  it("a competing AHEAD pin committed in the window is HELD, never lowered", async () => {
    const { message } = await runOnce();
    const args = JSON.parse(readFileSync(claudeJsonPath(), "utf-8")).mcpServers.flair.args as string[];
    expect(args).toContain(`${FLAIR_MCP_PACKAGE}@9.9.9`);
    expect(message).toContain("holding");
  }, CASE_BUDGET_MS);
});
