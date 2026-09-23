/**
 * codex-toml-pin-guard-in-lock.test.ts — flair#1778 slice 2c-i-d2, fixture T4.
 *
 * The never-lower guard must run on the IN-LOCK text. A competing writer lands
 * an AHEAD pin in the block after the Codex writer's pre-lock observation; the
 * in-lock decision must SEE it and HOLD — never lower it. Uses the primitive's
 * env-gated barrier (honored only by the migrated writer): the production
 * writer pauses after its pre-lock observation, the competing writer commits an
 * AHEAD block, then the writer proceeds and must hold.
 *
 * MUTATION (reported): make the writer decide on the PRE-LOCK text instead of
 * the in-lock bytes — the competing AHEAD block is invisible to the decision
 * and the pin is LOWERED (the `@0.0.1` block re-pinned to the running CLI,
 * discarding the `@9.9.9` the competitor wrote).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  home = mkdtempSync(join(tmpdir(), "flair-2cid2-t4-home-"));
  barrierDir = mkdtempSync(join(tmpdir(), "flair-2cid2-t4-barrier-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(barrierDir, { recursive: true, force: true });
});

const cfgPath = () => join(home, ".codex", "config.toml");
const URL = "http://127.0.0.1:19926";
const AGENT = "guardbot";

function block(spec: string): string {
  return [
    `[mcp_servers.flair]`,
    `command = "npx"`,
    `args = ["-y", "${spec}"]`,
    ``,
    `[mcp_servers.flair.env]`,
    `FLAIR_AGENT_ID = "${AGENT}"`,
    `FLAIR_URL = "${URL}"`,
    ``,
  ].join("\n");
}

function harnessSource(): string {
  return [
    `import { wireCodex } from ${JSON.stringify(clientsModule)};`,
    "const res = wireCodex({ FLAIR_AGENT_ID: process.env.FLAIR_AGENT_ID, FLAIR_URL: process.env.FLAIR_URL, FLAIR_CLIENT: 'codex' });",
    "process.stdout.write(JSON.stringify(res));",
    "process.exit(res.ok ? 0 : 1);",
  ].join("\n");
}

describe("T4 — the pin guard decides on the IN-LOCK text", () => {
  it("a competing AHEAD block committed in the window is HELD, never lowered", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(cfgPath(), block(`${FLAIR_MCP_PACKAGE}@0.0.1`), "utf-8");

    const harnessPath = join(home, "h.mjs");
    writeFileSync(harnessPath, harnessSource(), "utf-8");

    const child = spawn("bun", [harnessPath], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, FLAIR_AGENT_ID: AGENT, FLAIR_URL: URL, FLAIR_TEST_CRITICAL_BARRIER: barrierDir },
      timeout: CHILD_DEADLINE_MS,
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    const done = new Promise<{ code: number | null }>((resolve) => child.on("close", (code) => resolve({ code })));

    // Wait for the writer to pause after its pre-lock observation.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (readdirSync(barrierDir).some((f) => f.endsWith(".preObserve"))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // The competing writer commits an AHEAD block, then releases the writer.
    writeFileSync(cfgPath(), block(`${FLAIR_MCP_PACKAGE}@9.9.9`), "utf-8");
    writeFileSync(join(barrierDir, "go"), "1");

    await done;
    const text = readFileSync(cfgPath(), "utf-8");
    expect(text).toContain(`${FLAIR_MCP_PACKAGE}@9.9.9`);
    expect(out).toContain("holding");
  }, CASE_BUDGET_MS);
});
