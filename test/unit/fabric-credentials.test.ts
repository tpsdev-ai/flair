/**
 * fabric-credentials.test.ts — Unit tests for `resolveFabricCredentials`, the
 * shared Fabric admin credential resolver used by both `flair deploy` and
 * `flair upgrade --target`.
 *
 * Covers:
 *   - Password resolution precedence: --fabric-password (inline) >
 *     --fabric-password-file > FABRIC_PASSWORD env.
 *   - --fabric-password-file permission refusal (world/group-readable) and
 *     missing-file handling (reuses the --admin-pass-file mode check).
 *   - --fabric-user inline triggers a warning; FABRIC_USER env does not.
 *   - No credential VALUE (user or password) ever appears in a warning or
 *     thrown error string — only flag names.
 *
 * Only touches FABRIC_USER/FABRIC_PASSWORD env vars (not HOME) and temp
 * fixture files with fake generated values — never reads real ~/.flair or
 * ~/.tps material.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFabricCredentials, program } from "../../src/cli.js";

// ─── Env isolation ──────────────────────────────────────────────────────────

const ORIGINAL_FABRIC_USER = process.env.FABRIC_USER;
const ORIGINAL_FABRIC_PASSWORD = process.env.FABRIC_PASSWORD;

function clearFabricEnv(): void {
  delete process.env.FABRIC_USER;
  delete process.env.FABRIC_PASSWORD;
}

function restoreFabricEnv(): void {
  if (ORIGINAL_FABRIC_USER === undefined) delete process.env.FABRIC_USER;
  else process.env.FABRIC_USER = ORIGINAL_FABRIC_USER;
  if (ORIGINAL_FABRIC_PASSWORD === undefined) delete process.env.FABRIC_PASSWORD;
  else process.env.FABRIC_PASSWORD = ORIGINAL_FABRIC_PASSWORD;
}

// ─── Fixture helpers ────────────────────────────────────────────────────────

let tmpDir: string;

function makeSecretFile(mode: number, content: string): string {
  const path = join(tmpDir, `fabric-pass-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, content, "utf-8");
  chmodSync(path, mode);
  return path;
}

// Fake, generated-looking values — never real secrets.
const FAKE_ENV_PASSWORD = "envFakePass1234567890";
const FAKE_FILE_PASSWORD = "fileFakePass0987654321";
const FAKE_INLINE_PASSWORD = "inlineFakePassABCDEF12";

beforeEach(() => {
  clearFabricEnv();
  tmpDir = mkdtempSync(join(tmpdir(), "flair-fabric-creds-test-"));
});

afterEach(() => {
  restoreFabricEnv();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ─── Password precedence ────────────────────────────────────────────────────

describe("resolveFabricCredentials: password precedence", () => {
  test("env only: used when neither inline nor file given", () => {
    process.env.FABRIC_PASSWORD = FAKE_ENV_PASSWORD;
    const result = resolveFabricCredentials({});
    expect(result.fabricPassword).toBe(FAKE_ENV_PASSWORD);
    expect(result.warnings).toEqual([]);
  });

  test("file beats env when both are available", () => {
    process.env.FABRIC_PASSWORD = FAKE_ENV_PASSWORD;
    const file = makeSecretFile(0o600, FAKE_FILE_PASSWORD);
    const result = resolveFabricCredentials({ fabricPasswordFile: file });
    expect(result.fabricPassword).toBe(FAKE_FILE_PASSWORD);
    expect(result.fabricPassword).not.toBe(FAKE_ENV_PASSWORD);
  });

  test("inline beats file when both are given, with a precedence warning", () => {
    const file = makeSecretFile(0o600, FAKE_FILE_PASSWORD);
    const result = resolveFabricCredentials({
      fabricPassword: FAKE_INLINE_PASSWORD,
      fabricPasswordFile: file,
    });
    expect(result.fabricPassword).toBe(FAKE_INLINE_PASSWORD);
    expect(result.warnings.some((w) => w.includes("--fabric-password-file") && w.includes("precedence"))).toBe(true);
  });

  test("inline beats env when both are given", () => {
    process.env.FABRIC_PASSWORD = FAKE_ENV_PASSWORD;
    const result = resolveFabricCredentials({ fabricPassword: FAKE_INLINE_PASSWORD });
    expect(result.fabricPassword).toBe(FAKE_INLINE_PASSWORD);
  });

  test("nothing given: password is undefined, source implied by absence", () => {
    const result = resolveFabricCredentials({});
    expect(result.fabricPassword).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});

// ─── --fabric-password-file permission / existence checks ──────────────────

describe("resolveFabricCredentials: --fabric-password-file safety", () => {
  test("refuses a world-readable file (0644)", () => {
    const file = makeSecretFile(0o644, FAKE_FILE_PASSWORD);
    expect(() => resolveFabricCredentials({ fabricPasswordFile: file })).toThrow(/permissions 644 are too open/);
  });

  test("refuses a group-readable file (0640)", () => {
    const file = makeSecretFile(0o640, FAKE_FILE_PASSWORD);
    expect(() => resolveFabricCredentials({ fabricPasswordFile: file })).toThrow(/permissions 640 are too open/);
  });

  test("accepts an owner-only file (0600)", () => {
    const file = makeSecretFile(0o600, FAKE_FILE_PASSWORD);
    expect(resolveFabricCredentials({ fabricPasswordFile: file }).fabricPassword).toBe(FAKE_FILE_PASSWORD);
  });

  test("missing file throws an actionable error", () => {
    const missing = join(tmpDir, "does-not-exist");
    expect(() => resolveFabricCredentials({ fabricPasswordFile: missing })).toThrow(/path does not exist/);
  });

  test("empty file throws", () => {
    const file = makeSecretFile(0o600, "   \n");
    expect(() => resolveFabricCredentials({ fabricPasswordFile: file })).toThrow(/empty or contains only whitespace/);
  });

  test("permission error names the flag, not a generic --admin-pass-file message", () => {
    const file = makeSecretFile(0o644, FAKE_FILE_PASSWORD);
    expect(() => resolveFabricCredentials({ fabricPasswordFile: file })).toThrow(/--fabric-password-file/);
  });
});

// ─── --fabric-user inline warning ───────────────────────────────────────────

describe("resolveFabricCredentials: --fabric-user inline-only warning", () => {
  test("inline --fabric-user (no env) triggers a warning", () => {
    const result = resolveFabricCredentials({ fabricUser: "admin" });
    expect(result.fabricUser).toBe("admin");
    expect(result.warnings.some((w) => w.includes("--fabric-user"))).toBe(true);
  });

  test("FABRIC_USER env alone does NOT trigger a warning", () => {
    process.env.FABRIC_USER = "admin";
    const result = resolveFabricCredentials({});
    expect(result.fabricUser).toBe("admin");
    expect(result.warnings.some((w) => w.includes("--fabric-user"))).toBe(false);
  });

  test("inline --fabric-user warning is suppressed when FABRIC_USER env is ALSO set (mirrors the pre-existing --fabric-password quirk)", () => {
    process.env.FABRIC_USER = "admin";
    const result = resolveFabricCredentials({ fabricUser: "admin" });
    // Preserves the same "opts.X && !process.env.X" gate the codebase already
    // used for --fabric-password before this change — not a new behavior.
    expect(result.warnings.some((w) => w.includes("--fabric-user"))).toBe(false);
  });
});

// ─── Never leak credential values ───────────────────────────────────────────

describe("resolveFabricCredentials: never logs credential values", () => {
  test("no warning string contains the inline password value", () => {
    const file = makeSecretFile(0o600, FAKE_FILE_PASSWORD);
    const result = resolveFabricCredentials({
      fabricUser: "admin",
      fabricPassword: FAKE_INLINE_PASSWORD,
      fabricPasswordFile: file,
    });
    for (const w of result.warnings) {
      expect(w).not.toContain(FAKE_INLINE_PASSWORD);
      expect(w).not.toContain(FAKE_FILE_PASSWORD);
      expect(w).not.toContain("admin");
    }
  });

  test("thrown permission error does not contain the file's secret content", () => {
    const file = makeSecretFile(0o644, FAKE_FILE_PASSWORD);
    try {
      resolveFabricCredentials({ fabricPasswordFile: file });
      throw new Error("expected resolveFabricCredentials to throw");
    } catch (err: any) {
      expect(err.message).not.toContain(FAKE_FILE_PASSWORD);
    }
  });
});

// ─── CLI option registration ────────────────────────────────────────────────

describe("--fabric-password-file is registered on both commands", () => {
  function getOptionNames(cmd: any): string[] {
    return cmd.options.map((o: any) => o.long);
  }

  test("flair deploy has --fabric-password-file", () => {
    const deployCmd = program.commands.find((c: any) => c.name() === "deploy");
    expect(deployCmd).toBeDefined();
    expect(getOptionNames(deployCmd)).toContain("--fabric-password-file");
  });

  test("flair upgrade has --fabric-password-file", () => {
    const upgradeCmd = program.commands.find((c: any) => c.name() === "upgrade");
    expect(upgradeCmd).toBeDefined();
    expect(getOptionNames(upgradeCmd)).toContain("--fabric-password-file");
  });
});
