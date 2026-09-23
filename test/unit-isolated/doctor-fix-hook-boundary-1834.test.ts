/**
 * doctor-fix-hook-boundary-1834.test.ts — flair#1834 PR-H, T11f on the doctor
 * callers (#1120 claude-code, #1280 codex).
 *
 * A HOLD must be PRINTED on all three paths (upgrade refresh — covered by the
 * unit suite — and both doctor --fix arms), never a quiet skip. Real CLI,
 * HOME-isolated, dead --port.
 */

import { describe, test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FLAIR_MCP_PACKAGE, flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

const REPO = join(import.meta.dirname, "..", "..");
setDefaultTimeout(120_000);

const INSTALLED = flairCliVersion();
const core = parseSemverCore(INSTALLED)!;
const OLD = core[2] > 0 ? `${core[0]}.${core[1]}.${core[2] - 1}` : `${core[0]}.${core[1] - 1}.0`;

const homes: string[] = [];
afterAll(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); });
  });
}

function stripAnsi(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }

function makeHome(harness: "claude-code" | "codex", command: string): string {
  const home = mkdtempSync(join(tmpdir(), "flair-1834-hookdoc-"));
  homes.push(home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  // Wire the MCP block so the harness counts as configured.
  const claudeEntry = { mcpServers: { flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@${INSTALLED}`], env: { FLAIR_AGENT_ID: "local", FLAIR_URL: "http://127.0.0.1:9" } } } };
  writeFileSync(join(home, ".claude.json"), JSON.stringify(claudeEntry, null, 2) + "\n");
  const hookFile = harness === "codex" ? join(home, ".codex", "hooks.json") : join(home, ".claude", "settings.json");
  writeFileSync(hookFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }, null, 2) + "\n");
  return home;
}

async function runDoctor(home: string, deadPort: number, args: string[]): Promise<{ out: string; status: number | null }> {
  const env = { ...process.env, HOME: home, FLAIR_URL: `http://127.0.0.1:${deadPort}` };
  const proc = Bun.spawn(["bun", join(REPO, "src", "cli.ts"), "doctor", "--port", String(deadPort), ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const status = await proc.exited;
  return { out: stripAnsi(stdout + "\n" + stderr), status };
}

describe("flair#1834 PR-H — doctor --fix prints a hook HOLD (not a quiet skip)", () => {
  test("claude-code caller: a duplicate-assignment hook is HELD and printed", async () => {
    const dup = `FLAIR_AGENT_ID=a FLAIR_AGENT_ID=b npx -y -p ${FLAIR_MCP_PACKAGE}@${OLD} flair-session-start`;
    const home = makeHome("claude-code", dup);
    const before = readFileSync(join(home, ".claude", "settings.json"), "utf-8");
    const deadPort = await freePort();
    const fix = await runDoctor(home, deadPort, ["--fix"]);
    expect(fix.out).toContain("not one of the installer forms");
    expect(fix.out).not.toContain("re-pinned the SessionStart hook");
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).toBe(before);
  });

  test("codex caller: the same HOLD is printed", async () => {
    const dup = `FLAIR_AGENT_ID=a FLAIR_AGENT_ID=b npx -y -p ${FLAIR_MCP_PACKAGE}@${OLD} flair-session-start`;
    const home = makeHome("codex", dup);
    const before = readFileSync(join(home, ".codex", "hooks.json"), "utf-8");
    const deadPort = await freePort();
    const fix = await runDoctor(home, deadPort, ["--fix"]);
    expect(fix.out).toContain("not one of the installer forms");
    expect(fix.out).not.toContain("re-pinned the SessionStart hook");
    expect(readFileSync(join(home, ".codex", "hooks.json"), "utf-8")).toBe(before);
  });
});
