/**
 * agent-add-adminpass-fallback.test.ts — Unit tests for #590
 *
 * `flair agent add` used to hard-require `--admin-pass` even when
 * `~/.flair/admin-pass` (written by `flair init`, mode 0600) already had a
 * usable password. `flair principal add` had a partial fallback (env only).
 *
 * Fix: `resolveLocalAdminPass(explicit, isRemoteTarget, adminPassPath)` —
 * resolution order explicit --admin-pass > FLAIR_ADMIN_PASS env >
 * ~/.flair/admin-pass file (via the existing readAdminPassFileSecure, which
 * enforces 0600). The file/env fallback legs are ONLY used when
 * isRemoteTarget is false — a `--target`/`--ops-target` deploy must keep
 * requiring an explicit --admin-pass so this host's local secret is never
 * silently sent to a remote Harper instance.
 *
 * Tests exercise the real exported `resolveLocalAdminPass` (not a
 * reimplementation) so the suite can't drift from production behavior.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLocalAdminPass, program } from "../../src/cli.js";

// ─── Temp dir + admin-pass file helpers ────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-adminpass-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("resolveLocalAdminPass — #590", () => {
  let tmpDir: string;
  let passFile: string;
  let origAdminPass: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    passFile = join(tmpDir, "admin-pass");
    origAdminPass = process.env.FLAIR_ADMIN_PASS;
    delete process.env.FLAIR_ADMIN_PASS;
  });

  afterEach(() => {
    if (origAdminPass === undefined) delete process.env.FLAIR_ADMIN_PASS;
    else process.env.FLAIR_ADMIN_PASS = origAdminPass;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ── Local target: explicit > env > file ──────────────────────────────────────

  test("explicit --admin-pass wins over everything", () => {
    process.env.FLAIR_ADMIN_PASS = "env-pass";
    writeFileSync(passFile, "file-pass\n", "utf-8");
    chmodSync(passFile, 0o600);
    expect(resolveLocalAdminPass("explicit-pass", false, passFile)).toBe("explicit-pass");
  });

  test("FLAIR_ADMIN_PASS env wins over the file when no explicit value", () => {
    process.env.FLAIR_ADMIN_PASS = "env-pass";
    writeFileSync(passFile, "file-pass\n", "utf-8");
    chmodSync(passFile, 0o600);
    expect(resolveLocalAdminPass(undefined, false, passFile)).toBe("env-pass");
  });

  test("falls back to the secure admin-pass file when no explicit value and no env", () => {
    writeFileSync(passFile, "file-pass\n", "utf-8");
    chmodSync(passFile, 0o600);
    expect(resolveLocalAdminPass(undefined, false, passFile)).toBe("file-pass");
  });

  test("returns undefined when neither explicit, env, nor file is available (file missing)", () => {
    // passFile was never written — readAdminPassFileSecure would throw "does
    // not exist"; resolveLocalAdminPass checks existsSync first and returns
    // undefined instead of throwing, so callers can show a clean, actionable
    // "admin pass required" error.
    expect(resolveLocalAdminPass(undefined, false, passFile)).toBeUndefined();
  });

  test("propagates the file reader's error when the file has unsafe permissions (0644)", () => {
    writeFileSync(passFile, "file-pass\n", "utf-8");
    chmodSync(passFile, 0o644);
    expect(() => resolveLocalAdminPass(undefined, false, passFile)).toThrow(/permissions 644 are too open/);
  });

  test("propagates the file reader's error when the file is whitespace-only", () => {
    writeFileSync(passFile, "   \n", "utf-8");
    chmodSync(passFile, 0o600);
    expect(() => resolveLocalAdminPass(undefined, false, passFile)).toThrow(/empty or contains only whitespace/);
  });

  // ── Remote target: security guard — no env/file fallback, ever ───────────────

  test("SECURITY GUARD: remote target ignores FLAIR_ADMIN_PASS env entirely", () => {
    process.env.FLAIR_ADMIN_PASS = "env-pass";
    expect(resolveLocalAdminPass(undefined, true, passFile)).toBeUndefined();
  });

  test("SECURITY GUARD: remote target ignores the local admin-pass file entirely, even if present + valid", () => {
    writeFileSync(passFile, "file-pass\n", "utf-8");
    chmodSync(passFile, 0o600);
    expect(resolveLocalAdminPass(undefined, true, passFile)).toBeUndefined();
  });

  test("SECURITY GUARD: remote target still honors an explicit --admin-pass", () => {
    expect(resolveLocalAdminPass("explicit-pass", true, passFile)).toBe("explicit-pass");
  });

  test("SECURITY GUARD: remote target with unreadable/invalid file does NOT throw (file leg is skipped, not attempted)", () => {
    writeFileSync(passFile, "file-pass\n", "utf-8");
    chmodSync(passFile, 0o644); // would throw if the file leg were attempted
    expect(() => resolveLocalAdminPass(undefined, true, passFile)).not.toThrow();
    expect(resolveLocalAdminPass(undefined, true, passFile)).toBeUndefined();
  });
});

// ─── Commander program wiring: agent add / principal add ──────────────────────

describe("agent add / principal add — command wiring (#590)", () => {
  function findCommand(name: string) {
    return program.commands.find((c) => c.name() === name);
  }
  function findSubcommand(parent: string, child: string) {
    return findCommand(parent)?.commands.find((c) => c.name() === child);
  }
  function hasOption(cmd: any, flag: string): boolean {
    return cmd.options.some((o: any) => o.flags.includes(flag));
  }

  test("agent add still requires --admin-pass as an explicit option (flag not removed)", () => {
    const add = findSubcommand("agent", "add");
    expect(add).not.toBeUndefined();
    expect(hasOption(add, "--admin-pass")).toBe(true);
  });

  test("agent add keeps --target and --ops-target (remote-target guard depends on these)", () => {
    const add = findSubcommand("agent", "add");
    expect(hasOption(add, "--target")).toBe(true);
    expect(hasOption(add, "--ops-target")).toBe(true);
  });

  test("principal add still requires --admin-pass as an explicit option (flag not removed)", () => {
    const add = findSubcommand("principal", "add");
    expect(add).not.toBeUndefined();
    expect(hasOption(add, "--admin-pass")).toBe(true);
  });

  test("principal add has no --target/--ops-target (always localhost, fallback always applies)", () => {
    const add = findSubcommand("principal", "add");
    expect(hasOption(add, "--target")).toBe(false);
    expect(hasOption(add, "--ops-target")).toBe(false);
  });
});

// ─── End-to-end CLI behavior via subprocess ────────────────────────────────────
//
// Spawns the real CLI (bun src/cli.ts) so the error paths are exercised
// exactly as a user would hit them, including the local-vs-remote guard.
// No live Harper instance is required because both cases below fail before
// any network call is made (admin-pass resolution happens first).

describe("flair agent add / principal add — subprocess error paths (#590)", () => {
  const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    origHome = process.env.HOME;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  async function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Merge onto a copy of the real env, but explicitly DELETE any key passed
    // as undefined — this guarantees test isolation even if the host shell
    // already has FLAIR_ADMIN_PASS set (must not leak into the "no env" cases).
    const merged: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    const proc = Bun.spawn(["bun", cliPath, ...args], {
      env: merged,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  test("agent add with no --admin-pass, no env, no ~/.flair/admin-pass: errors clearly (local)", async () => {
    const { stderr, exitCode } = await runCli(
      ["agent", "add", "test-agent-590"],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--admin-pass is required for agent add");
  });

  test("agent add with FLAIR_ADMIN_PASS env set but bad Harper connection still gets past admin-pass resolution (does not error on missing --admin-pass)", async () => {
    // We can't stand up a full Harper instance in this unit test, but we can
    // confirm the process does NOT die on the "--admin-pass is required"
    // guard when FLAIR_ADMIN_PASS is set — it must fail later (network/fetch),
    // not on admin-pass resolution.
    const { stderr } = await runCli(
      ["agent", "add", "test-agent-590-env", "--port", "39999"],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: "env-secret-pass" },
    );
    expect(stderr).not.toContain("--admin-pass is required for agent add");
  });

  test("agent add with --target set (remote) and no --admin-pass: STILL errors even if FLAIR_ADMIN_PASS is set (security guard)", async () => {
    const { stderr, exitCode } = await runCli(
      ["agent", "add", "test-agent-590-remote", "--target", "https://remote.example.com:9926"],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: "env-secret-pass" },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--admin-pass is required for agent add");
    expect(stderr).toContain("remote instance");
  });

  test("agent add with --ops-target set (remote) and no --admin-pass: STILL errors even with a valid local admin-pass file (security guard)", async () => {
    mkdirSync(join(tmpHome, ".flair"), { recursive: true });
    const passFile = join(tmpHome, ".flair", "admin-pass");
    writeFileSync(passFile, "local-file-secret\n", "utf-8");
    chmodSync(passFile, 0o600);

    const { stderr, exitCode } = await runCli(
      ["agent", "add", "test-agent-590-remote2", "--ops-target", "https://remote.example.com:9925"],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--admin-pass is required for agent add");
    expect(stderr).toContain("remote instance");
  });

  test("agent add (local) with a valid ~/.flair/admin-pass file and no --admin-pass/env: does not hit the missing-admin-pass guard", async () => {
    mkdirSync(join(tmpHome, ".flair"), { recursive: true });
    const passFile = join(tmpHome, ".flair", "admin-pass");
    writeFileSync(passFile, "local-file-secret\n", "utf-8");
    chmodSync(passFile, 0o600);

    const { stderr } = await runCli(
      ["agent", "add", "test-agent-590-file", "--port", "39999"],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined },
    );
    // Should fail on the network call (port 1 / no Harper running), NOT on
    // "--admin-pass is required" — proves the file fallback resolved a pass.
    expect(stderr).not.toContain("--admin-pass is required for agent add");
  });

  test("principal add with no --admin-pass, no env, no file: errors clearly", async () => {
    const { stderr, exitCode } = await runCli(
      ["principal", "add", "test-principal-590"],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--admin-pass or FLAIR_ADMIN_PASS required");
  });

  test("principal add with a valid ~/.flair/admin-pass file and no --admin-pass/env: does not hit the missing-admin-pass guard", async () => {
    mkdirSync(join(tmpHome, ".flair"), { recursive: true });
    const passFile = join(tmpHome, ".flair", "admin-pass");
    writeFileSync(passFile, "local-file-secret\n", "utf-8");
    chmodSync(passFile, 0o600);

    const { stderr } = await runCli(
      ["principal", "add", "test-principal-590-file", "--port", "39999"],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined },
    );
    expect(stderr).not.toContain("--admin-pass or FLAIR_ADMIN_PASS required");
  });

  test("principal add: FLAIR_ADMIN_PASS env still takes precedence over the file", async () => {
    mkdirSync(join(tmpHome, ".flair"), { recursive: true });
    const passFile = join(tmpHome, ".flair", "admin-pass");
    writeFileSync(passFile, "local-file-secret\n", "utf-8");
    chmodSync(passFile, 0o600);

    const { stderr } = await runCli(
      ["principal", "add", "test-principal-590-envwins", "--port", "39999"],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: "env-secret-pass" },
    );
    expect(stderr).not.toContain("--admin-pass or FLAIR_ADMIN_PASS required");
  });
});
