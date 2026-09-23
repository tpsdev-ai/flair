/**
 * doctor-fix-mcp-pins.test.ts — flair#1779, fails-on-main.
 *
 * THE DEFECT. `flair doctor --fix` re-pinned the SessionStart hook but never the
 * MCP-client block: a BEHIND MCP pin stayed a blocking `fail` whose remedy said
 * `flair upgrade` — which in that state reports up-to-date and acts on nothing.
 *
 * THE FIX. `doctor --fix` re-pins a behind MCP-client block through the SAME
 * guarded writer the upgrade refresh uses (`refreshOwnedPins`, targeted to the
 * behind wired clients): behind => written; ahead/unknown => held.
 *
 * Real CLI, HOME-isolated (scratch HOME, dead --port). Reuses the harness shape
 * of doctor-fix-pin-hold.test.ts (that file is unchanged).
 */

import { describe, test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flairCliVersion, FLAIR_MCP_PACKAGE } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

const REPO = join(import.meta.dirname, "..", "..");
setDefaultTimeout(120_000);

const INSTALLED = flairCliVersion();
const core = parseSemverCore(INSTALLED);
if (!core) throw new Error(`CLI version is not semver: ${INSTALLED}`);
const AHEAD = `${core[0]}.${core[1]}.${core[2] + 1}`;
const BEHIND = core[2] > 0 ? `${core[0]}.${core[1]}.${core[2] - 1}` : `${core[0]}.${core[1] - 1}.0`;
const UNPARSEABLE = "0.55.1.rc";

const homes: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

function claudePath(home: string): string {
  return join(home, ".claude.json");
}
function codexPath(home: string): string {
  return join(home, ".codex", "config.toml");
}

function hookCommand(agentId: string, version: string): string {
  return `sh -c 'out=$(FLAIR_AGENT_ID=${agentId} npx -y -p ${FLAIR_MCP_PACKAGE}@${version} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
}

/** claude-code MCP block in ~/.claude.json. */
function writeClaudeMcp(home: string, version: string): void {
  writeFileSync(
    claudePath(home),
    JSON.stringify({
      mcpServers: {
        flair: {
          command: "npx",
          args: ["-y", `${FLAIR_MCP_PACKAGE}@${version}`],
          type: "stdio",
          env: { FLAIR_AGENT_ID: "local", FLAIR_URL: "http://127.0.0.1:9" },
        },
      },
    }, null, 2) + "\n",
  );
}

/** codex MCP block in ~/.codex/config.toml. */
function writeCodexMcp(home: string, version: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    codexPath(home),
    [
      "[mcp_servers.flair]",
      `command = "npx"`,
      `args = ["-y", "${FLAIR_MCP_PACKAGE}@${version}"]`,
      "",
      "[mcp_servers.flair.env]",
      `FLAIR_AGENT_ID = "local"`,
      `FLAIR_URL = "http://127.0.0.1:9"`,
      "",
    ].join("\n"),
  );
}

/** A home with the given MCP pins, plus CURRENT hooks (so the hook path is quiet). */
function makeHome(opts: { claude?: string; codex?: string }): string {
  const home = mkdtempSync(join(tmpdir(), "flair-1779-home-"));
  homes.push(home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  if (opts.claude) writeClaudeMcp(home, opts.claude);
  if (opts.codex) writeCodexMcp(home, opts.codex);
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand("local", INSTALLED) }] }] } }, null, 2) + "\n",
  );
  writeFileSync(
    join(home, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand("local", INSTALLED) }] }] } }, null, 2) + "\n",
  );
  return home;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

async function runDoctor(home: string, deadPort: number, args: string[] = []): Promise<{ out: string; status: number | null }> {
  const env = { ...process.env, HOME: home, FLAIR_URL: `http://127.0.0.1:${deadPort}` };
  const proc = Bun.spawn(
    ["bun", join(REPO, "src", "cli.ts"), "doctor", "--port", String(deadPort), ...args],
    { cwd: home, env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  return { out: stripAnsi(stdout + "\n" + stderr), status };
}

function issueCount(out: string): number {
  const m = out.match(/(\d+) issues? found/);
  if (m) return Number(m[1]);
  if (/No issues found/.test(out)) return 0;
  return -1;
}

describe("flair#1779 — doctor --fix re-pins a BEHIND MCP-client block", () => {
  test("BEHIND (claude-code + codex): --fix re-pins the JSON client; codex refresh skips (A1, pending A2)", async () => {
    const home = makeHome({ claude: BEHIND, codex: BEHIND });
    const deadPort = await freePort();

    const plain = await runDoctor(home, deadPort);
    expect(plain.out).toContain("✗ MCP server block: fail");
    expect(plain.out).toContain(`stale pins claude-code@${BEHIND}, codex@${BEHIND}`);

    const fix = await runDoctor(home, deadPort, ["--fix"]);
    // The JSON client (claude-code) is re-pinned from the WRITER's in-lock
    // result (round 2: r.message carries the (old -> new) the write saw).
    expect(fix.out).toContain(`re-pinned Claude Code (${FLAIR_MCP_PACKAGE}@${BEHIND} -> ${FLAIR_MCP_PACKAGE}@${INSTALLED})`);
    // flair#1834 A1: Codex is TOML and gets its own pin-only writer in A2; until
    // then the refresh SKIPS it — the pin stays stale, never corrupted.
    expect(fix.out).toContain("codex: refresh awaits the TOML pin-only writer — skip");
    // The JSON block carries the CLI version; the TOML block is untouched.
    expect(readFileSync(claudePath(home), "utf-8")).toContain(`${FLAIR_MCP_PACKAGE}@${INSTALLED}`);
    expect(readFileSync(claudePath(home), "utf-8")).not.toContain(`${FLAIR_MCP_PACKAGE}@${BEHIND}`);
    expect(readFileSync(codexPath(home), "utf-8")).toContain(`${FLAIR_MCP_PACKAGE}@${BEHIND}`);
    // A1 limitation, named: the catalog (recomputed after the fix) still flags
    // the codex block behind until A2 lands.
    expect(fix.out).toContain("✗ MCP server block: fail");

    const second = await runDoctor(home, deadPort);
    expect(second.out).toContain("✗ MCP server block: fail");
  });

  test("BEHIND + AHEAD: only the behind client is rewritten; the ahead one is byte-identical (held)", async () => {
    const home = makeHome({ claude: BEHIND, codex: AHEAD });
    const codexBefore = readFileSync(codexPath(home), "utf-8");
    const deadPort = await freePort();

    const fix = await runDoctor(home, deadPort, ["--fix"]);
    expect(readFileSync(claudePath(home), "utf-8")).toContain(`${FLAIR_MCP_PACKAGE}@${INSTALLED}`);
    expect(readFileSync(codexPath(home), "utf-8")).toBe(codexBefore); // untouched
    expect(fix.out).toContain(`re-pinned Claude Code (${FLAIR_MCP_PACKAGE}@${BEHIND} -> ${FLAIR_MCP_PACKAGE}@${INSTALLED})`);
    expect(fix.out).toContain(`MCP server (codex): pinned to flair-mcp@${AHEAD}, ahead of the installed CLI ${INSTALLED} — held`);
    expect(fix.out).not.toContain(`re-pinned Codex`);
  });

  test("UNKNOWN: untouched, a warn line, and zero blocking issues (parity with a current pin)", async () => {
    const deadPort = await freePort();
    const unknownHome = makeHome({ claude: UNPARSEABLE, codex: INSTALLED });
    const currentHome = makeHome({ claude: INSTALLED, codex: INSTALLED });
    const before = readFileSync(claudePath(unknownHome), "utf-8");

    const unknown = await runDoctor(unknownHome, deadPort);
    expect(unknown.out).toContain("⚠ MCP server block: warn");
    expect(unknown.out).toContain(`pin is not a version I can compare: ${UNPARSEABLE}`);
    expect(unknown.out).not.toContain("✗ MCP server block");

    const fix = await runDoctor(unknownHome, deadPort, ["--fix"]);
    expect(readFileSync(claudePath(unknownHome), "utf-8")).toBe(before); // untouched
    expect(fix.out).not.toContain(`re-pinned the MCP server block in ${claudePath(unknownHome)}`);

    const current = await runDoctor(currentHome, deadPort);
    expect(issueCount(unknown.out)).toBe(issueCount(current.out));
    expect(issueCount(unknown.out)).toBeGreaterThanOrEqual(0);
  });

  test("DRY-RUN: writes nothing and prints the Would lines", async () => {
    const home = makeHome({ claude: BEHIND, codex: BEHIND });
    const claudeBefore = readFileSync(claudePath(home), "utf-8");
    const codexBefore = readFileSync(codexPath(home), "utf-8");
    const deadPort = await freePort();

    const fix = await runDoctor(home, deadPort, ["--fix", "--dry-run"]);
    expect(readFileSync(claudePath(home), "utf-8")).toBe(claudeBefore);
    expect(readFileSync(codexPath(home), "utf-8")).toBe(codexBefore);
    expect(fix.out).toContain(`Would re-pin the MCP server block in ${claudePath(home)}`);
    expect(fix.out).toContain(`Would re-pin the MCP server block in ${codexPath(home)}`);
    expect(fix.out).not.toContain("re-pinned the MCP server block");
  });
});
