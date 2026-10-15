/**
 * flair#2589 — the macOS launchd lane must distinguish the redaction check
 * CRASHING from a scan finding, and fail on both. The lane's shell cannot run
 * on Linux, so the assertion lives in a sourced helper
 * (scripts/ci/launchd-redaction-check.sh) that this test drives directly: a
 * fake `node` stands in for the redactor so each exit code can be produced
 * deterministically, and the real `grep`-based admin-pass layer is exercised
 * with a real file.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LIB = join(REPO_ROOT, "scripts", "ci", "launchd-redaction-check.sh");

/** Run the shared assertion with a fake redactor that exits `exitCode`. */
function runAssertion(exitCode: number, { targetContents = "", adminPass = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "launchd-redaction-assert-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, "node");
    writeFileSync(shim, "#!/usr/bin/env bash\nexit \"${FAKE_NODE_EXIT:?}\"\n");
    chmodSync(shim, 0o755);
    const target = join(dir, "target");
    writeFileSync(target, targetContents);
    const r = spawnSync("bash", ["-c", 'source "$LIB"; assert_no_inline_credentials "$TARGET"'], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        WORKSPACE: dir,
        LIB,
        TARGET: target,
        ADMIN_PASS: adminPass,
        FAKE_NODE_EXIT: String(exitCode),
      },
    });
    return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("launchd redaction assertion classifies the check's exit code (flair#2589)", () => {
  test("exit 0 (ran, found nothing) passes", () => {
    const { status, output } = runAssertion(0);
    expect(status).toBe(0);
    expect(output).not.toContain("::error::");
  });

  test("exit 1 (a finding) fails, naming a non-REDACTED credential key", () => {
    const { status, output } = runAssertion(1);
    expect(status).toBe(1);
    expect(output).toContain("a credential key with a non-REDACTED value");
  });

  test("exit 2 (could not run) fails as a crash, not as a finding", () => {
    const { status, output } = runAssertion(2);
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
    expect(output).toContain("(exit 2)");
    expect(output).not.toContain("a credential key with a non-REDACTED value");
  });

  test("the run's own admin password found in the output fails first", () => {
    const { status, output } = runAssertion(0, {
      targetContents: "admin-pass-value\n",
      adminPass: "admin-pass-value",
    });
    expect(status).toBe(1);
    expect(output).toContain("admin password reached the diagnostics output");
  });
});
