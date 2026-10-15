/**
 * flair#2589 — the macOS launchd lane must distinguish the redaction check
 * CRASHING from a scan finding, and fail on both. The lane's shell cannot run
 * on Linux, so the assertion lives in a sourced helper
 * (scripts/ci/launchd-redaction-check.sh) that this test drives directly: a
 * fake `node` stands in for the redactor so each exit code can be produced
 * deterministically, the real `grep`-based admin-password layer is exercised
 * with a real file, and a separate block runs the REAL helper against the REAL
 * scanner (clean, finding, and a scanner that cannot start).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LIB = join(REPO_ROOT, "scripts", "ci", "launchd-redaction-check.sh");
const SCANNER = join(REPO_ROOT, "scripts", "ci", "redact-launchd-plist.mjs");
const FIXTURES = join(REPO_ROOT, "scripts", "ci", "redact-fixtures");

/**
 * Run the shared assertion with a fake redactor that exits `exitCode`. The fake
 * prints the redactor's finding marker when it exits 1, unless `findingMarker`
 * is false — that is how a bare startup crash (Node exit 1, no marker) is
 * separated from a real finding.
 */
function runAssertion(
  exitCode: number,
  { targetContents = "", adminPass = "", writeTarget = true, findingMarker = true } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "launchd-redaction-assert-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, "node");
    writeFileSync(
      shim,
      "#!/usr/bin/env bash\n" +
        'if [ "${FAKE_NODE_EXIT:?}" = "1" ] && [ "${FAKE_NODE_MARKER:-1}" = "1" ]; then\n' +
        '  echo "redact-launchd-plist: unredacted credential key(s) in fixture: FLAIR_ADMIN_PASS" >&2\n' +
        "fi\n" +
        'exit "${FAKE_NODE_EXIT:?}"\n',
    );
    chmodSync(shim, 0o755);
    const target = join(dir, "target");
    if (writeTarget) writeFileSync(target, targetContents);
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
        FAKE_NODE_MARKER: findingMarker ? "1" : "0",
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

  test("exit 1 with the finding marker fails, naming a non-REDACTED credential key", () => {
    const { status, output } = runAssertion(1);
    expect(status).toBe(1);
    expect(output).toContain("a credential key with a non-REDACTED value");
  });

  test("exit 1 WITHOUT the finding marker is a crash, not a finding (flair#2589)", () => {
    // A bare exit 1 (a Node startup syntax error, say) must be reported as
    // could-not-run, never as a credential finding.
    const { status, output } = runAssertion(1, { findingMarker: false });
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
    expect(output).not.toContain("a credential key with a non-REDACTED value");
  });

  test("exit 2 (could not run) fails as a crash, not as a finding", () => {
    const { status, output } = runAssertion(2);
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
    expect(output).toContain("(exit 2)");
    expect(output).not.toContain("a credential key with a non-REDACTED value");
  });

  test("a grep error in the admin-password layer is a scan failure, not clean (flair#2589)", () => {
    // No target file: `grep` exits 2. That must be could-not-run, never a pass.
    const { status, output } = runAssertion(0, { adminPass: "some-admin-value", writeTarget: false });
    expect(status).toBe(1);
    expect(output).toContain("could not run (grep exit 2)");
    expect(output).not.toContain("admin password reached the diagnostics output");
  });

  test("the run's own admin password found in the output fails first", () => {
    const { status, output } = runAssertion(0, {
      targetContents: "admin-pass-value\n",
      adminPass: "admin-pass-value",
    });
    expect(status).toBe(1);
    expect(output).toContain("admin password reached the diagnostics output");
  });

  test("an option-leading admin password is matched as a pattern, not read as an option (flair#2589)", () => {
    // `--check` would be an unrecognized grep option without `-e`/`--`: grep
    // would exit 2 and the layer would miss a real leak. The password IS present
    // in the target, so the layer must find it.
    const { status, output } = runAssertion(0, {
      targetContents: "the run password is --check for this fixture\n",
      adminPass: "--check",
    });
    expect(status).toBe(1);
    expect(output).toContain("admin password reached the diagnostics output");
  });
});

describe("the real helper drives the real scanner at the crash/finding seam (flair#2589)", () => {
  function runReal(target: string, workspace = REPO_ROOT) {
    const r = spawnSync("bash", ["-c", 'source "$LIB"; assert_no_inline_credentials "$TARGET"'], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, WORKSPACE: workspace, LIB, TARGET: target, ADMIN_PASS: "" },
    });
    return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  test("a clean fixture passes through the real scanner", () => {
    const { status, output } = runReal(join(FIXTURES, "clean"));
    expect(status).toBe(0);
    expect(output).not.toContain("::error::");
  });

  test("a leaky fixture fails as a finding, naming the key and not the value", () => {
    const { status, output } = runReal(join(FIXTURES, "leaky"));
    expect(status).toBe(1);
    expect(output).toContain("a credential key with a non-REDACTED value");
    expect(output).toContain("HDB_ADMIN_PASSWORD");
    expect(output).not.toContain("example-placeholder-not-a-secret");
  });

  test("a scanner that cannot start is reported as could-not-run, not as a finding", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-real-crash-"));
    try {
      const ci = join(dir, "scripts", "ci");
      mkdirSync(ci, { recursive: true });
      // The real scanner plus a startup syntax error: Node exits 1 with no
      // finding marker, which the helper must report as could-not-run.
      const broken = join(ci, "redact-launchd-plist.mjs");
      copyFileSync(SCANNER, broken);
      appendFileSync(broken, "\nconst =\n");
      const { status, output } = runReal(join(FIXTURES, "leaky"), dir);
      expect(status).toBe(1);
      expect(output).toContain("redaction check could not run");
      expect(output).not.toContain("a credential key with a non-REDACTED value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
