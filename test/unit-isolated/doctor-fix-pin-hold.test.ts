/**
 * doctor-fix-pin-hold.test.ts — flair#1778 slice-1 follow-up (Q1), fails-on-main.
 *
 * THE DEFECT. `staleSessionStartHookPins` flags ANY pin != the installed CLI,
 * so a pin AHEAD of the CLI rendered as a `✗ SessionStart hook: ... the hook
 * still launches the OLD adapter ...` error, was counted as an issue, and —
 * with the #1786/#1787 never-lower guard now holding the pin — `flair doctor
 * --fix` printed the hold line, left the issue "remaining", and exited 1 on a
 * state it deliberately preserves.
 *
 * THE FIX. Classify pin DIRECTION before rendering (both claude-code and
 * codex): a pin AHEAD of the running CLI is a held pass (no ✗, no issue count,
 * no --fix); a pin BEHIND is today's stale error + re-pin, unchanged.
 *
 * These run the real CLI as a HOME-isolated child. The running CLI's own
 * version is used; AHEAD is one patch above it, BEHIND one patch below (the
 * brief's "0.55.0 vs CLI 0.54.2" is the same direction). A dead --port keeps
 * the instance probe deterministic across runs.
 */

import { describe, test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

const REPO = join(import.meta.dirname, "..", "..");
const FLAIR_MCP_PACKAGE = "@tpsdev-ai/flair-mcp";
setDefaultTimeout(120_000);

const INSTALLED = flairCliVersion();
const core = parseSemverCore(INSTALLED);
if (!core) throw new Error(`CLI version is not semver: ${INSTALLED}`);
const AHEAD = `${core[0]}.${core[1]}.${core[2] + 1}`;
const BEHIND = core[2] > 0 ? `${core[0]}.${core[1]}.${core[2] - 1}` : `${core[0]}.${core[1] - 1}.0`;

const homes: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** One free localhost port (bound then released) for a deterministic dead probe. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

function hookCommand(agentId: string, version: string): string {
  return `sh -c 'out=$(FLAIR_AGENT_ID=${agentId} npx -y -p ${FLAIR_MCP_PACKAGE}@${version} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
}

function makeHome(hookVersion: string): string {
  const home = mkdtempSync(join(tmpdir(), "flair-1778-q1-home-"));
  homes.push(home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        flair: {
          command: "npx",
          args: ["-y", `${FLAIR_MCP_PACKAGE}@${INSTALLED}`],
          type: "stdio",
          env: { FLAIR_AGENT_ID: "local", FLAIR_URL: "http://127.0.0.1:9" },
        },
      },
    }, null, 2) + "\n",
  );
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand("local", hookVersion) }] }] } }, null, 2) + "\n",
  );
  return home;
}

function hookPath(home: string): string {
  return join(home, ".claude", "settings.json");
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

/** The doctor issue count from its summary line ("N issues found" / "No issues found"). */
function issueCount(out: string): number {
  const m = out.match(/(\d+) issues? found/);
  if (m) return Number(m[1]);
  if (/No issues found/.test(out)) return 0;
  return -1; // summary line not found — the probe saw nothing
}

describe("flair#1778 Q1 — doctor classifies SessionStart-hook pin DIRECTION", () => {
  test("AHEAD: held pass (no ✗, no --fix) and the hook file is byte-identical", async () => {
    expect(AHEAD).not.toBe(INSTALLED);
    const home = makeHome(AHEAD);
    const before = readFileSync(hookPath(home), "utf-8");
    const deadPort = await freePort();

    const plain = await runDoctor(home, deadPort);
    expect(plain.out).toContain(`SessionStart hook: pinned to flair-mcp@${AHEAD}, ahead of the installed CLI ${INSTALLED} — held`);
    expect(plain.out).not.toContain("✗ SessionStart hook");
    expect(plain.out).not.toContain("the hook still launches the OLD adapter");

    const fix = await runDoctor(home, deadPort, ["--fix"]);
    expect(readFileSync(hookPath(home), "utf-8")).toBe(before);
    expect(fix.out).toContain(`SessionStart hook: pinned to flair-mcp@${AHEAD}, ahead of the installed CLI ${INSTALLED} — held`);
    expect(fix.out).not.toContain(`re-pinned the SessionStart hook in ${hookPath(home)} to ${FLAIR_MCP_PACKAGE}@${INSTALLED}`);
  });

  test("the AHEAD pin adds ZERO issues (exit/count parity with a current pin)", async () => {
    const deadPort = await freePort();
    const aheadHome = makeHome(AHEAD);
    const currentHome = makeHome(INSTALLED);

    const ahead = await runDoctor(aheadHome, deadPort);
    const current = await runDoctor(currentHome, deadPort);

    // Same otherwise-identical home: the ONLY difference is the pin direction.
    // A current pin is not an issue; an ahead pin must not be either.
    expect(current.out).not.toContain("✗ SessionStart hook");
    expect(ahead.out).not.toContain("✗ SessionStart hook");
    expect(issueCount(ahead.out)).toBe(issueCount(current.out));
    expect(issueCount(ahead.out)).toBeGreaterThanOrEqual(0); // the summary line was read
    expect(ahead.status).toBe(current.status);
  });

  test("BEHIND: unchanged behaviour — ✗ stale error, and --fix re-pins to the running CLI", async () => {
    expect(BEHIND).not.toBe(INSTALLED);
    const home = makeHome(BEHIND);
    const deadPort = await freePort();

    const plain = await runDoctor(home, deadPort);
    expect(plain.out).toContain(`✗ SessionStart hook: pinned to flair-mcp@${BEHIND} (installed CLI is ${INSTALLED}) — the hook still launches the OLD adapter on every session`);

    const fix = await runDoctor(home, deadPort, ["--fix"]);
    const after = readFileSync(hookPath(home), "utf-8");
    expect(after).toContain(`${FLAIR_MCP_PACKAGE}@${INSTALLED}`);
    expect(after).not.toContain(`${FLAIR_MCP_PACKAGE}@${BEHIND}`);
  });
});

const UNPARSEABLE = "0.55.1.rc";

describe("flair#1778 — doctor reports an UNPARSEABLE pin separately (not as stale)", () => {
  test("UNKNOWN: a warn line (no ✗) and --fix leaves the hook byte-identical", async () => {
    const home = makeHome(UNPARSEABLE);
    const before = readFileSync(hookPath(home), "utf-8");
    const deadPort = await freePort();

    const plain = await runDoctor(home, deadPort);
    expect(plain.out).toContain(`SessionStart hook: pin is not a version I can compare: ${UNPARSEABLE} — not re-pinned`);
    expect(plain.out).not.toContain("✗ SessionStart hook");
    expect(plain.out).not.toContain("the hook still launches the OLD adapter");

    const fix = await runDoctor(home, deadPort, ["--fix"]);
    expect(readFileSync(hookPath(home), "utf-8")).toBe(before);
    expect(fix.out).toContain(`pin is not a version I can compare: ${UNPARSEABLE}`);
    expect(fix.out).not.toContain(`re-pinned the SessionStart hook in ${hookPath(home)}`);
  });

  test("UNKNOWN: the unreadable pin adds ZERO blocking issues (parity with a current pin)", async () => {
    const deadPort = await freePort();
    const unknownHome = makeHome(UNPARSEABLE);
    const currentHome = makeHome(INSTALLED);

    const unknown = await runDoctor(unknownHome, deadPort);
    const current = await runDoctor(currentHome, deadPort);

    expect(current.out).not.toContain("✗ SessionStart hook");
    expect(unknown.out).not.toContain("✗ SessionStart hook");
    expect(issueCount(unknown.out)).toBe(issueCount(current.out));
    expect(issueCount(unknown.out)).toBeGreaterThanOrEqual(0);
    expect(unknown.status).toBe(current.status);
  });
});
