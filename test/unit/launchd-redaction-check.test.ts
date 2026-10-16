/**
 * flair#2589 — the macOS launchd lane must distinguish the redaction check
 * CRASHING from a scan finding, and fail on both. The lane's shell cannot run
 * on Linux, so the assertion lives in a sourced helper
 * (scripts/ci/launchd-redaction-check.sh) that this test drives directly.
 *
 * The classification pairs the exit status with a valid `--report`: exit 0
 * needs empty findings; exit 1 needs non-empty findings. All other outcomes
 * are could-not-run. Tests also exercise the real Node startup-error boundary.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LIB = join(REPO_ROOT, "scripts", "ci", "launchd-redaction-check.sh");
const SCANNER = join(REPO_ROOT, "scripts", "ci", "redact-launchd-plist.mjs");
const FIXTURE_SCRIPT = join(REPO_ROOT, "scripts", "ci", "check-redaction-fixtures.sh");
const FIXTURES = join(REPO_ROOT, "scripts", "ci", "redact-fixtures");

/** A fake scanner (real `node`) whose report, stderr and exit code are env-driven. */
const FAKE_SCANNER = `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const at = args.indexOf("--report");
const report = at >= 0 ? args[at + 1] : undefined;
if (report && process.env.FAKE_SCAN_REPORT !== undefined) {
  writeFileSync(report, process.env.FAKE_SCAN_REPORT);
}
if (process.env.FAKE_SCAN_STDERR) process.stderr.write(process.env.FAKE_SCAN_STDERR);
process.exit(Number(process.env.FAKE_SCAN_EXIT ?? "0"));
`;

const EMPTY_REPORT = JSON.stringify({ schema: "redact-launchd-plist/report/1", findings: [] });
const FINDING_REPORT = JSON.stringify({
  schema: "redact-launchd-plist/report/1",
  findings: [{ file: "fixture", keys: ["HDB_ADMIN_PASSWORD"] }],
});

/**
 * Run the shared assertion with a fake redactor. `report` is the exact content
 * written to the redactor's `--report` file (omit to write none); `stderr` is
 * what the redactor prints, so a Node-diagnostic-shaped line can be fed in.
 */
function runAssertion({
  exitCode = 0,
  report,
  stderr,
  targetContents = "",
  adminPass = "",
  writeTarget = true,
}: {
  exitCode?: number;
  report?: string;
  stderr?: string;
  targetContents?: string;
  adminPass?: string;
  writeTarget?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "launchd-redaction-assert-"));
  try {
    const ci = join(dir, "scripts", "ci");
    mkdirSync(ci, { recursive: true });
    writeFileSync(join(ci, "redact-launchd-plist.mjs"), FAKE_SCANNER);
    const target = join(dir, "target");
    if (writeTarget) writeFileSync(target, targetContents);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKSPACE: dir,
      LIB,
      TARGET: target,
      ADMIN_PASS: adminPass,
      FAKE_SCAN_EXIT: String(exitCode),
    };
    if (report !== undefined) env.FAKE_SCAN_REPORT = report;
    if (stderr !== undefined) env.FAKE_SCAN_STDERR = stderr;
    const r = spawnSync("bash", ["-c", 'source "$LIB"; assert_no_inline_credentials "$TARGET"'], {
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
    return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the assertion pairs exit status and report (flair#2589)", () => {
  test("exit 0 with a valid empty report passes", () => {
    const { status, output } = runAssertion({ exitCode: 0, report: EMPTY_REPORT });
    expect(status).toBe(0);
    expect(output).not.toContain("::error::");
  });

  test("exit 0 with no report is could-not-run", () => {
    const { status, output } = runAssertion({ exitCode: 0 });
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
  });

  test.each(["{ not json", "null", '{}', '{"findings":[]}', '{"schema":"wrong","findings":[]}'])(
    "exit 0 with a malformed report %s is could-not-run",
    (report) => {
      const { status, output } = runAssertion({ exitCode: 0, report });
      expect(status).toBe(1);
      expect(output).toContain("redaction check could not run");
    },
  );

  test("exit 0 with non-empty findings is could-not-run", () => {
    const { status, output } = runAssertion({ exitCode: 0, report: FINDING_REPORT });
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
  });

  test.each([2, 3, 127])("exit %i with a valid empty report is could-not-run", (exitCode) => {
    const { status, output } = runAssertion({ exitCode, report: EMPTY_REPORT });
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
  });

  test("exit 1 with a well-formed finding record fails, naming a non-REDACTED credential key", () => {
    const { status, output } = runAssertion({ exitCode: 1, report: FINDING_REPORT });
    expect(status).toBe(1);
    expect(output).toContain("a credential key with a non-REDACTED value");
  });

  test("exit 1 whose output reads like the finding marker but writes no report is could-not-run", () => {
    // The counterexample from the review: a Node syntax diagnostic prints the
    // offending source line, which can read like the finding marker, and Node
    // exits 1. The paired exit-status/report check must reject it.
    const { status, output } = runAssertion({
      exitCode: 1,
      stderr: "redact-launchd-plist: unredacted credential key(s) in fixture: HDB_ADMIN_PASSWORD\n",
    });
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
    expect(output).not.toContain("a credential key with a non-REDACTED value");
  });

  test("exit 1 with a report that is not JSON is could-not-run, not a finding", () => {
    const { status, output } = runAssertion({ exitCode: 1, report: "{ not json" });
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
    expect(output).not.toContain("a credential key with a non-REDACTED value");
  });

  test("exit 1 with an empty findings array is not a finding", () => {
    const { status, output } = runAssertion({ exitCode: 1, report: EMPTY_REPORT });
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
    expect(output).not.toContain("a credential key with a non-REDACTED value");
  });

  test("exit 1 with a finding entry that names no key is not a finding", () => {
    const { status, output } = runAssertion({
      exitCode: 1,
      report: '{"schema":"redact-launchd-plist/report/1","findings":[{"file":"fixture","keys":[]}]}',
    });
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
    expect(output).not.toContain("a credential key with a non-REDACTED value");
  });

  test("exit 2 (could not run) fails as a crash, not as a finding", () => {
    const { status, output } = runAssertion({ exitCode: 2 });
    expect(status).toBe(1);
    expect(output).toContain("redaction check could not run");
    expect(output).toContain("(exit 2)");
    expect(output).not.toContain("a credential key with a non-REDACTED value");
  });
});

describe("the admin-password layer still scans the target (flair#2589)", () => {
  test("a grep error in the admin-password layer is a scan failure, not clean (flair#2589)", () => {
    // No target file: `grep` exits 2. That must be could-not-run, never a pass.
    const { status, output } = runAssertion({ adminPass: "some-admin-value", writeTarget: false });
    expect(status).toBe(1);
    expect(output).toContain("could not run (grep exit 2)");
    expect(output).not.toContain("admin password reached the diagnostics output");
  });

  test("the run's own admin password found in the output fails first", () => {
    const { status, output } = runAssertion({
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
    const { status, output } = runAssertion({
      targetContents: "the run password is --check for this fixture\n",
      adminPass: "--check",
    });
    expect(status).toBe(1);
    expect(output).toContain("admin password reached the diagnostics output");
  });

  test("the admin-password layer scans binary content: a NUL before the password does not hide it (flair#2589)", () => {
    // `grep -I` skips binary-looking input, so a password after a NUL byte would
    // be missed; the layer must scan binary content too. The real `grep` runs
    // against a real file whose first byte is NUL.
    const { status, output } = runAssertion({
      targetContents: "\u0000binary-admin-value\n",
      adminPass: "binary-admin-value",
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

  test("a startup crash whose source line starts with the complete finding marker and key is could-not-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-real-crash-"));
    try {
      const ci = join(dir, "scripts", "ci");
      mkdirSync(ci, { recursive: true });
      // The real scanner plus a startup syntax error whose offending source line
      // IS the complete finding marker and key: Node exits 1 and prints that
      // line. It writes no report, so the helper must report could-not-run.
      const broken = join(ci, "redact-launchd-plist.mjs");
      copyFileSync(SCANNER, broken);
      appendFileSync(broken, "\nredact-launchd-plist: unredacted credential key HDB_ADMIN_PASSWORD\n");
      const { status, output } = runReal(join(FIXTURES, "leaky"), dir);
      expect(status).toBe(1);
      expect(output).toContain("redaction check could not run");
      expect(output).not.toContain("a credential key with a non-REDACTED value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the fixture script pairs exit status and report (flair#2589)", () => {
  test("the committed fixtures pass and the leaky one is a finding", () => {
    const r = spawnSync("bash", [FIXTURE_SCRIPT], { encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("clean fixture: passed");
    expect(r.stdout).toContain("leaky fixture: reported as a finding");
  });

  test("a crash whose source line starts with the finding marker does not credit the leaky fixture", () => {
    // The scanner is the real one plus a syntax error whose source line IS the
    // finding marker and key. A run that read the output or the exit code would
    // accept the Node diagnostic as the leaky fixture's finding; the report
    // channel leaves it a check that could not run, so the script fails.
    const dir = mkdtempSync(join(tmpdir(), "redact-fixture-script-"));
    try {
      const ci = join(dir, "scripts", "ci");
      mkdirSync(join(ci, "redact-fixtures", "clean"), { recursive: true });
      mkdirSync(join(ci, "redact-fixtures", "leaky"), { recursive: true });
      copyFileSync(FIXTURE_SCRIPT, join(ci, "check-redaction-fixtures.sh"));
      copyFileSync(LIB, join(ci, "launchd-redaction-check.sh"));
      copyFileSync(join(FIXTURES, "clean", "launchd.plist"), join(ci, "redact-fixtures", "clean", "launchd.plist"));
      copyFileSync(join(FIXTURES, "leaky", "launchd.plist"), join(ci, "redact-fixtures", "leaky", "launchd.plist"));
      const broken = join(ci, "redact-launchd-plist.mjs");
      copyFileSync(SCANNER, broken);
      appendFileSync(broken, "\nredact-launchd-plist: unredacted credential key HDB_ADMIN_PASSWORD\n");
      const r = spawnSync("bash", [join(ci, "check-redaction-fixtures.sh")], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).not.toContain("leaky fixture: reported as a finding");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
