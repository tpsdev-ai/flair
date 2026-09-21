/**
 * doctor-fix-pin-hold.test.ts — flair#1778 slice-1 follow-up (N4), fails-on-main.
 *
 * THE HAZARD. `flair doctor --fix` re-pinned the SessionStart hook through
 * `repinSessionStartHook`, which was NOT behind the `isPinDowngrade` hold that
 * #1786 added to `flair upgrade`'s pin refresh. So a `doctor --fix` on an AHEAD
 * pin (a staged / never-promoted adapter pin) lowered it — the same downgrade
 * #1786 stopped for the upgrade path, left reachable via doctor.
 *
 * THE PROOF. Write a wired Claude Code MCP block and a SessionStart hook whose
 * flair-mcp pin is AHEAD of this CLI's running version, run the real CLI as a
 * HOME-isolated child (`doctor --fix`), and assert the hook file is
 * byte-identical and the shared hold line is printed naming both pins.
 *
 * Isolated: the CLI is spawned as a CHILD with HOME set at spawn, so its data
 * dir is a scratch tree — never a real instance. No real instance, no service
 * manager, no install. The hook pin is computed from the RUNNING CLI version
 * (the brief's "0.55.0 vs CLI 0.54.2" is the same direction: pin ahead of CLI).
 */

import { describe, test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

const REPO = join(import.meta.dirname, "..", "..");
const FLAIR_MCP_PACKAGE = "@tpsdev-ai/flair-mcp";

// doctor does a lot of HOME-local probing; give the child room.
setDefaultTimeout(120_000);

const INSTALLED = flairCliVersion();
const core = parseSemverCore(INSTALLED);
if (!core) throw new Error(`CLI version is not semver: ${INSTALLED}`);
// One patch ahead of the running CLI: a re-pin would write INSTALLED over it — a
// downgrade. It must be HELD.
const AHEAD = `${core[0]}.${core[1]}.${core[2] + 1}`;

const HOME = mkdtempSync(join(tmpdir(), "flair-1778-n4-home-"));
const HOOK_PATH = join(HOME, ".claude", "settings.json");
const CLAUDE_JSON = join(HOME, ".claude.json");

function hookCommand(agentId: string, version: string): string {
  return `sh -c 'out=$(FLAIR_AGENT_ID=${agentId} npx -y -p ${FLAIR_MCP_PACKAGE}@${version} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
}

// A wired Claude Code MCP block (current pin) so doctor reaches the hook branch.
mkdirSync(join(HOME, ".claude"), { recursive: true });
writeFileSync(
  CLAUDE_JSON,
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
// A wired SessionStart hook pinned AHEAD of the running CLI.
writeFileSync(
  HOOK_PATH,
  JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand("local", AHEAD) }] }] } }, null, 2) + "\n",
);

const HOOK_BEFORE = readFileSync(HOOK_PATH, "utf-8");

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

async function runDoctorFix(): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const env = {
    ...process.env,
    HOME,
    FLAIR_URL: "http://127.0.0.1:9", // dead port: no instance can be detected
  };
  const proc = Bun.spawn(["bun", join(REPO, "src", "cli.ts"), "doctor", "--fix"], {
    // cwd = the scratch HOME, not the repo: doctor --fix will ADD a bootstrap
    // line to ./CLAUDE.md when one is missing, and autoFix is on. Pointing cwd
    // at the scratch tree keeps every write inside it (the repo stays clean).
    cwd: HOME,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  return { stdout, stderr, status };
}

describe("flair#1778 N4 — doctor --fix never LOWERS an ahead SessionStart-hook pin", () => {
  test("an AHEAD hook pin is held: the hook file is byte-identical and the hold line prints", async () => {
    expect(AHEAD).not.toBe(INSTALLED);
    expect(existsSync(HOOK_PATH)).toBe(true);

    const { stdout, stderr } = await runDoctorFix();
    const out = stdout + "\n" + stderr;

    // The hook file was NOT rewritten (the downgrade would have replaced AHEAD
    // with INSTALLED).
    expect(readFileSync(HOOK_PATH, "utf-8")).toBe(HOOK_BEFORE);
    expect(readFileSync(HOOK_PATH, "utf-8")).toContain(`${FLAIR_MCP_PACKAGE}@${AHEAD}`);

    // The shared hold line is printed, naming BOTH pins.
    expect(out).toContain(`keeping pinned ${AHEAD}`);
    expect(out).toContain(`running CLI ${INSTALLED} is older`);
    expect(out).toContain("the refresh never lowers a pin");

    // ...and it was NOT re-pinned DOWN to the running CLI.
    expect(out).not.toContain(`re-pinned the SessionStart hook in ${HOOK_PATH} to ${FLAIR_MCP_PACKAGE}@${INSTALLED}`);
  });
});
