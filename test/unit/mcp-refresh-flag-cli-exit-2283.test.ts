/**
 * mcp-refresh-flag-cli-exit-2283.test.ts — flair#2283.
 *
 * The unit file (test/unit/mcp-refresh-flag-2283.test.ts) drives the FUNCTION
 * `refreshMcpOAuthFlag`; the integration file drives it against the real Harper
 * harness. Neither runs the COMMAND. `flair mcp enable --refresh-flag` is what an
 * operator (or their script) types, and its contract on failure is an EXIT CODE —
 * a wrapper branches on it. This file spawns the real CLI entry (`src/cli.ts`, the
 * argument parser and the `.action()` handler, not `refreshMcpOAuthFlag`) and pins
 * that a failed refresh exits NON-ZERO in both output modes:
 *
 *   - human (default): the step list is printed, then the process exits non-zero;
 *   - `--json`: the result object is printed, then the process exits non-zero.
 *
 * The failure is HERMETIC. A preloaded `fetch` throws, so the target's ops API is
 * unreachable and refresh falls back to the staged-file branch without touching the
 * network. Removing EITHER `process.exit(1)` in `src/commands/mcp.ts` lets the
 * handler fall off the end and exit 0, which the matching case here fails on.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "cli.ts");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2283-cli-exit-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Run the real CLI with NO network: a preloaded fetch throws, so the target's ops
 *  API is unreachable and refresh takes the staged-file branch hermetically. */
function runRefresh(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync("/bin/sh", join(bin, "sh"));
  const offline = join(home, "offline.cjs");
  writeFileSync(offline, "globalThis.fetch = async () => { throw new Error('offline fixture'); };\n");
  const result = spawnSync(
    process.execPath,
    [
      "--preload", offline, CLI_ENTRY,
      "mcp", "enable",
      "--instance", "https://agent-a.harperfabric.com",
      "--refresh-flag",
      "--admin-pass", "not-a-real-password",
      ...args,
    ],
    {
      cwd: home,
      encoding: "utf8",
      timeout: 20_000,
      env: { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: bin, NO_COLOR: "1" },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("flair mcp enable --refresh-flag: a failed refresh exits non-zero (flair#2283)", () => {
  test("human mode: the fallback step is printed, then the process exits non-zero", () => {
    const { status, stdout } = runRefresh([]);
    // The probe could not confirm capability; the fallback file is named.
    expect(stdout).toContain("secrets-provisioning");
    expect(stdout).toContain("could not reach the ops API");
    expect(status).not.toBe(0);
    expect(status).toBe(1);
  }, 30_000);

  test("--json mode: the result object is printed, then the process exits non-zero", () => {
    const { status, stdout } = runRefresh(["--json"]);
    const payload = JSON.parse(stdout.trim()) as { ok?: unknown; failedStep?: unknown; secretsPath?: unknown };
    expect(payload.ok).toBe(false);
    expect(payload.failedStep).toBe("secrets-provisioning");
    expect(typeof payload.secretsPath).toBe("string");
    expect(status).not.toBe(0);
    expect(status).toBe(1);
  }, 30_000);
});
