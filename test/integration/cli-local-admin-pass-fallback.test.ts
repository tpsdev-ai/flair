// cli-local-admin-pass-fallback.test.ts — Integration test for flair#634
// (companion to #632 gate-4): the real `flair` CLI, spawned as a subprocess
// against a REAL Harper instance, exercising the exact regression #634 fixes.
//
// BEFORE #634: `api()` in src/cli.ts sent NO Authorization header at all for
// local targets, riding Harper's authorizeLocal forged super_user. #632 gated
// FederationInstance/FederationPeers behind allowAdmin (a real permission
// check — see resources/agent-auth.ts's allowAdmin/resolveAgentAuth), so a
// credential-less `flair federation status` against a #632-gated instance
// started getting a real 403 instead of the old forged-admin 200.
//
// AFTER #634: api() auto-loads credentials for local targets — FLAIR_ADMIN_PASS/
// HDB_ADMIN_PASSWORD env, then FLAIR_AGENT_ID+key (Ed25519), then the secure
// ~/.flair/admin-pass file `flair init` writes (#593) — so a properly
// provisioned host works zero-config again.
//
// This file spawns the REAL CLI entrypoint (src/cli.ts under bun) against a
// REAL spawned Harper instance (test/helpers/harper-lifecycle, same as
// gate4-authgate.test.ts), with HOME pointed at an isolated tmpdir so the
// admin-pass fixture file never touches this machine's real ~/.flair/admin-pass.
// The "admin password" used below is the test harness's own ephemeral
// generated Harper credential (harper.admin.password) — not a real secret.
//
// MODEL: test/integration/gate4-authgate.test.ts (the #632 gate this is the
// companion to) + test/unit/agent-add-adminpass-fallback.test.ts's subprocess
// CLI-spawn pattern (#590's precedent for the same admin-pass-file idiom).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
  // Merge onto a copy of the real env, but explicitly DELETE any key passed
  // as undefined — guarantees isolation even if the host shell already has
  // FLAIR_ADMIN_PASS/etc set (must not leak into the "no creds" case).
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

let harper: HarperInstance;

describe("flair#634: CLI api() sends local credentials against a real #632-gated Harper instance", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("credential-less `flair federation status` is denied (real 403 from #632's allowAdmin gate, not the old forged-admin passthrough)", async () => {
    const tmpHome = makeTmpDir("flair-634-int-nocreds");
    try {
      const { exitCode, stderr, stdout } = await runCli(
        ["federation", "status", "--target", harper.httpURL],
        { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined, FLAIR_TOKEN: undefined },
      );
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).not.toBe(0);
      // Clear, actionable message — not a stack trace.
      expect(stderr).toMatch(/flair init|FLAIR_ADMIN_PASS/);
      expect(stderr).not.toMatch(/\bat .*\.(ts|js):\d+/);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("flair#634 FIX: `flair federation status` succeeds against the SAME gated instance using ONLY ~/.flair/admin-pass (no env, no key)", async () => {
    const tmpHome = makeTmpDir("flair-634-int-filecreds");
    try {
      const flairDir = join(tmpHome, ".flair");
      mkdirSync(flairDir, { recursive: true });
      // The test harness's own ephemeral generated Harper admin password —
      // not a developer secret. This is exactly what `flair init` (#593)
      // would have written for a real deployment.
      writeFileSync(join(flairDir, "admin-pass"), harper.admin.password, "utf-8");
      chmodSync(join(flairDir, "admin-pass"), 0o600);

      const { exitCode, stdout, stderr } = await runCli(
        ["federation", "status", "--target", harper.httpURL],
        { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined, FLAIR_TOKEN: undefined },
      );
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      // Real instance identity was returned (FederationInstance.get() self-
      // bootstraps on first call) — proves this actually authenticated as
      // admin against the live #632 gate, not just "didn't crash". Output
      // mode auto-detects JSON for a non-TTY pipe (render.resolveOutputMode),
      // so parse rather than match against the human-readable text renderer.
      const body = JSON.parse(stdout);
      expect(body.instance?.id).toMatch(/^flair_/);
      expect(Array.isArray(body.peers)).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("explicit FLAIR_ADMIN_PASS env still works against the same gated instance (existing remote-target behavior, unaffected by #634)", async () => {
    const tmpHome = makeTmpDir("flair-634-int-envcreds");
    try {
      const { exitCode, stdout, stderr } = await runCli(
        ["federation", "status", "--target", harper.httpURL],
        { HOME: tmpHome, FLAIR_ADMIN_PASS: harper.admin.password, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined, FLAIR_TOKEN: undefined },
      );
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      const body = JSON.parse(stdout);
      expect(body.instance?.id).toMatch(/^flair_/);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);
});
