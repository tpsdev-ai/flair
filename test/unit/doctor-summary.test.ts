/**
 * doctor-summary.test.ts — Unit tests for summarizeDoctorRun (flair#721).
 *
 * `flair doctor --fix` used to track a single `issues` counter: every
 * detected problem incremented it, with no record of which of those issues
 * `--fix` actually resolved during the same run. A run that interactively
 * fixed everything it found still printed "N issues found — see fixes
 * above" and exited 1 — indistinguishable from a run that fixed nothing.
 *
 * Same pattern as cli-rem-rapid.test.ts (#707): the `doctor` action
 * callback drives Harper probes, filesystem checks, interactive prompts,
 * and process.exit, which makes it high-effort/low-value to drive
 * directly (no CLI harness that mocks fetch/TTY/commander exists for this
 * repo's convention — pure decision logic gets extracted instead). This is
 * that extracted logic: given the found/fixed counts and whether --fix was
 * requested, decide the summary line + exit code.
 */

import { describe, test, expect } from "bun:test";
import { summarizeDoctorRun } from "../../src/cli.ts";

describe("summarizeDoctorRun", () => {
  test("no issues found → exit 0, regardless of --fix", () => {
    for (const autoFix of [false, true]) {
      const r = summarizeDoctorRun(0, 0, autoFix);
      expect(r.exitCode).toBe(0);
      expect(r.line).toContain("No issues found");
    }
  });

  describe("without --fix (unchanged pre-#721 behavior)", () => {
    test("issues found → exit 1, plain 'found' message, no fixed/remaining language", () => {
      const r = summarizeDoctorRun(2, 0, false);
      expect(r.exitCode).toBe(1);
      expect(r.line).toContain("2 issues found");
      expect(r.line).toContain("see fixes above");
      expect(r.line).not.toContain("fixed");
      expect(r.line).not.toContain("remaining");
    });

    test("singular pluralization for a single issue", () => {
      const r = summarizeDoctorRun(1, 0, false);
      expect(r.line).toContain("1 issue found");
      expect(r.line).not.toContain("1 issues");
    });

    test("a nonzero `fixed` count is ignored when --fix wasn't passed", () => {
      // Shouldn't happen in practice (fixed only increments inside --fix
      // branches) but the summary must still key off `autoFix`, not `fixed`.
      const r = summarizeDoctorRun(2, 2, false);
      expect(r.exitCode).toBe(1);
      expect(r.line).toContain("see fixes above");
      expect(r.line).not.toContain("fixed");
    });
  });

  describe("with --fix, everything resolved", () => {
    test("all issues fixed → exit 0, 'N issues found, N fixed' message", () => {
      const r = summarizeDoctorRun(2, 2, true);
      expect(r.exitCode).toBe(0);
      expect(r.line).toContain("2 issues found, 2 fixed");
      expect(r.line).toContain("✓");
    });

    test("singular pluralization when the one issue found was fixed", () => {
      const r = summarizeDoctorRun(1, 1, true);
      expect(r.exitCode).toBe(0);
      expect(r.line).toContain("1 issue found, 1 fixed");
      expect(r.line).not.toContain("1 issues");
    });
  });

  describe("with --fix, some remaining", () => {
    test("partial fix → exit 1, 'found, fixed, remaining' breakdown", () => {
      const r = summarizeDoctorRun(3, 1, true);
      expect(r.exitCode).toBe(1);
      expect(r.line).toContain("3 issues found, 1 fixed, 2 remaining");
    });

    test("nothing fixed (all declined/unfixable) → exit 1, 0 fixed reported explicitly", () => {
      const r = summarizeDoctorRun(2, 0, true);
      expect(r.exitCode).toBe(1);
      expect(r.line).toContain("2 issues found, 0 fixed, 2 remaining");
    });

    test("singular 'remaining' count still reads correctly (no special-cased grammar needed)", () => {
      const r = summarizeDoctorRun(2, 1, true);
      expect(r.exitCode).toBe(1);
      expect(r.line).toContain("2 issues found, 1 fixed, 1 remaining");
    });
  });
});
