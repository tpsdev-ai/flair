/**
 * init-admin-pass-idempotent.test.ts — Unit tests for flair#827
 *
 * `flair init` used to ALWAYS generate a brand-new random admin password and
 * overwrite ~/.flair/admin-pass, even on a re-run against an install that was
 * already bootstrapped and working (e.g. following `flair doctor`'s ops-bind
 * finding, whose only prescribed remedy was re-running `flair init`).
 * Harper's HDB_ADMIN_PASSWORD env var only seeds a brand-new install's user
 * record — it does NOT rotate an existing user's stored password hash on
 * every boot (the admin-pass file is bootstrap-only). Overwriting the file
 * desynced it from what Harper actually had persisted, and the very next
 * ops-API call in that same init run (seeding the agent) failed with a 401
 * "Login failed" — breaking working auth on an install that had nothing
 * wrong with its credentials in the first place.
 *
 * Fix: `resolveInitAdminPasswordSource(adminPassFileExists)` — when no
 * explicit --admin-pass / --admin-pass-file / env var is given, an existing
 * ~/.flair/admin-pass file means a prior `flair init` already bootstrapped a
 * working password; reuse it (via the existing readAdminPassFileSecure,
 * which enforces 0600) instead of generating a new one. Re-init becomes
 * idempotent — safe to run again at any time.
 *
 * Same house pattern as agent-add-adminpass-fallback.test.ts /
 * ops-api-bind.test.ts: the CLI action callback spawns a real Harper
 * process, so the pure decision logic is extracted and exported for direct
 * testing, and the actual file read is exercised against a real temp file
 * (no Harper instance involved).
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveInitAdminPasswordSource, readAdminPassFileSecure } from "../../src/cli.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-init-adminpass-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── resolveInitAdminPasswordSource ─────────────────────────────────────────

describe("resolveInitAdminPasswordSource — flair#827", () => {
  test("reuses the existing file when one is already present — re-init must not desync the password", () => {
    expect(resolveInitAdminPasswordSource(true)).toBe("reuse-existing");
  });

  test("generates a new password for a genuinely fresh install (no existing file)", () => {
    expect(resolveInitAdminPasswordSource(false)).toBe("generate-new");
  });
});

// ─── End-to-end-ish: reused password matches exactly what a prior init wrote ──

describe("re-init password reuse — flair#827 regression", () => {
  test("a second init reads back the EXACT same password a first init wrote, byte for byte", () => {
    const tmpDir = makeTmpDir();
    try {
      const adminPassPath = join(tmpDir, "admin-pass");
      const firstInitPassword = "originally-bootstrapped-password-abc123";

      // Simulate what the first `flair init` run did: write + chmod 0600.
      writeFileSync(adminPassPath, firstInitPassword + "\n", { mode: 0o600 });

      // Simulate a re-run of `flair init` (e.g. `flair doctor`'s ops-bind
      // remedy): it must decide to REUSE, and reading the file back must
      // yield the identical password Harper's stored user record still
      // expects — never a freshly generated, mismatched one.
      const decision = resolveInitAdminPasswordSource(true);
      expect(decision).toBe("reuse-existing");
      const reusedPassword = readAdminPassFileSecure(adminPassPath);
      expect(reusedPassword).toBe(firstInitPassword);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("reused-password read refuses an insecure (group/world readable) admin-pass file, same as any other read of it", () => {
    const tmpDir = makeTmpDir();
    try {
      const adminPassPath = join(tmpDir, "admin-pass");
      writeFileSync(adminPassPath, "some-password\n");
      chmodSync(adminPassPath, 0o644); // too open
      expect(resolveInitAdminPasswordSource(true)).toBe("reuse-existing");
      expect(() => readAdminPassFileSecure(adminPassPath)).toThrow(/too open/);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});
