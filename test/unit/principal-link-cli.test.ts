/**
 * principal-link-cli.test.ts — the `flair principal link|unlink|links` PRE-FLIGHT
 * (flair#2115), driven through the built CLI so the flags, exit codes and
 * refusal text are the ones an operator sees.
 *
 * Every case here is refused BEFORE any operations call, so each one can be run
 * against a target that must never be reached (`.invalid` never resolves, and
 * the other inputs are private, local or unparseable addresses) and the
 * assertion is that the CLI printed its OWN refusal rather than a fetch error:
 * a refusal that only happens after a call is not a refusal.
 *
 * The mapping controls themselves are measured in principal-link.test.ts, where
 * an injected fetch serves an in-memory store and every URL is asserted; the
 * commands target a REMOTE instance (the address `flair mcp enable` derives, the
 * instance host at the hosted ops port), so no test here talks to a real one.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { tempDir } from "../helpers/temp-dir.js";

/** A public-shaped origin that never resolves: if the command reached the
 *  network at all, the failure would be a DNS/connection error, not its own. */
const UNREACHABLE = "https://flair.invalid";

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const cliPath = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
  // HOME-isolated: the run must never read this machine's ~/.flair. tempDir()
  // registers the removal in the same call (flair#1889).
  const home = tempDir("flair-2115-cli-");
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [cliPath, ...args], {
      env: { ...process.env, HOME: home, FLAIR_URL: "", FLAIR_ADMIN_PASS: "" },
      stdio: ["ignore", "pipe", "pipe"],
      // A literal: the CLI-spawn budget gate (flair#1807/#1825) reads a literal
      // token, and a new test may not arrive with its own baseline exception.
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(
          new Error(
            childOverranDeadline("flair CLI", cliLeg(args), 20_000, {
              status: code,
              signal,
              elapsedMs: Date.now() - startedAt,
              stdout,
              stderr,
            }),
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

describe("flair principal link / unlink / links pre-flight (flair#2115)", () => {
  beforeAll(() => {
    ensureCliBuild();
  }, 120_000);

  test("no --instance (or FLAIR_URL) is refused by name", async () => {
    const out = await runCli(["principal", "link", "alice", "--idp-subject", "octocat"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("--instance is required");
    expect(out.stdout).toBe("");
  }, 25_000);

  test("no --idp-subject is refused by name", async () => {
    const out = await runCli(["principal", "link", "alice", "--instance", UNREACHABLE, "--admin-pass", "pw"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("--idp-subject <login> is required");
  }, 25_000);

  test("no admin credential is refused by name, before any operations call", async () => {
    const out = await runCli(["principal", "link", "alice", "--instance", UNREACHABLE, "--idp-subject", "octocat"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("--admin-pass <pass> is required for a REMOTE target");
    // The refusal is the command's own, not a network error: nothing dialled out.
    expect(out.stderr).not.toMatch(/fetch failed|ENOTFOUND|EAI_AGAIN|HTTP \d/);
    expect(out.stdout).toBe("");
  }, 25_000);

  // A target that is not a public HTTPS origin must be refused before any call.
  // No input here derives an ops target on THIS machine (the library refuses
  // loopback before it derives anything, and the per-input no-request proofs
  // run against an injected fetch in test/unit/principal-link.test.ts).
  const REFUSED_INSTANCES: Array<[string, string]> = [
    ["http://flair.invalid", "a remote origin over plain HTTP"],
    ["ftp://flair.invalid", "a non-HTTP scheme"],
    ["not-a-url", "an unparseable value"],
    ["https://10.0.0.1", "an RFC1918 address"],
    ["https://169.254.0.1", "a link-local address"],
    ["https://[fd00::1]", "an IPv6 unique-local address"],
    ["https://[fe80::1]", "an IPv6 link-local address"],
  ];

  for (const [instance, what] of REFUSED_INSTANCES) {
    test(`refuses ${what} before any call`, async () => {
      const out = await runCli(["principal", "links", "alice", "--instance", instance, "--admin-pass", "pw"]);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("public HTTPS origin");
      expect(out.stderr).not.toMatch(/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|HTTP \d/);
      expect(out.stdout).toBe("");
    }, 25_000);
  }
});
