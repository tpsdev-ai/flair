/**
 * soul-credential-flags-1719.test.ts — sibling `flair soul` subcommands accept
 * the same credential options (flair#1719 item 4).
 *
 * `flair soul set` declared `--admin-pass-file`, but `flair soul list` rejected
 * it with `unknown option '--admin-pass-file'` — the same auth surface was
 * spelled differently across siblings, so an operator following one subcommand's
 * `--help` could not run its neighbour. `get` and `list` now declare the shared
 * credential flags, and all three declare the `--url` escape hatch that was
 * previously undiscoverable.
 *
 * On current main the first test FAILS: commander stops with
 * `unknown option '--admin-pass-file'`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const proc = Bun.spawn(["bun", cliPath, ...args], { env: merged, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

const CLEAR_ENV = {
  FLAIR_ADMIN_PASS: undefined,
  HDB_ADMIN_PASSWORD: undefined,
  FLAIR_AGENT_ID: undefined,
  FLAIR_URL: undefined,
  FLAIR_TARGET: undefined,
};

describe("flair#1719 — soul subcommands share the credential surface", () => {
  let tmpHome: string;

  beforeEach(() => { tmpHome = makeTmpDir("flair1719-soul"); });
  afterEach(() => { try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ } });

  test("soul list accepts --admin-pass-file instead of rejecting it as unknown", async () => {
    // A deliberately missing file: the point is that the OPTION is recognised,
    // and the failure is about the file (a real, nameable problem), never
    // commander's "unknown option".
    const missing = join(tmpHome, "no-such-admin-pass");
    const { stderr } = await runCli(
      ["soul", "list", "--agent", "x", "--admin-pass-file", missing],
      { HOME: tmpHome, ...CLEAR_ENV },
    );

    expect(stderr).not.toContain("unknown option");
    expect(stderr).toContain("--admin-pass-file");
  }, 30_000);

  test("soul get accepts --admin-pass-file too", async () => {
    const missing = join(tmpHome, "no-such-admin-pass");
    const { stderr } = await runCli(
      ["soul", "get", "x:key", "--admin-pass-file", missing],
      { HOME: tmpHome, ...CLEAR_ENV },
    );

    expect(stderr).not.toContain("unknown option");
    expect(stderr).toContain("--admin-pass-file");
  }, 30_000);

  test("soul list --help documents the --url escape hatch", async () => {
    const { stdout } = await runCli(["soul", "list", "--help"], { HOME: tmpHome, ...CLEAR_ENV });
    expect(stdout).toContain("--url");
  }, 30_000);
});
