/**
 * rem-nightly-skips-924.test.ts — the `flair rem nightly run-once` exit-code
 * contract (flair#924 defect 1 / #1503).
 *
 * `summarizeNightlyOutcome` is the summary's exit decision, extracted from the
 * action callback so it can be pinned without spawning api() (the repo's
 * convention for the rem subcommands — see cli-rem-rapid.test.ts). A populated
 * `errors[]` is exit 1; a deliberate skip is listed but does not fail the run,
 * so the nightly job stops reporting a valid no-model install as DEGRADED.
 */
import { describe, test, expect } from "bun:test";
import { summarizeNightlyOutcome } from "../../src/commands/rem.ts";

describe("summarizeNightlyOutcome (flair#924 defect 1 / #1503)", () => {
  test("a no-backend skip exits 0 and is listed under Skips", () => {
    const out = summarizeNightlyOutcome({
      errors: [],
      skips: ["distillation skipped: no generative backend configured"],
    });
    expect(out.exitCode).toBe(0);
    expect(out.lines).toEqual([
      "Skips:",
      "  - distillation skipped: no generative backend configured",
    ]);
    expect(out.lines.join("\n")).not.toContain("Errors:");
  });

  test("a real distillation error exits 1 and is listed under Errors", () => {
    const out = summarizeNightlyOutcome({
      errors: ["distillation: fetch failed: connection reset"],
      skips: [],
    });
    expect(out.exitCode).toBe(1);
    expect(out.lines).toEqual([
      "Errors:",
      "  - distillation: fetch failed: connection reset",
    ]);
  });

  test("a clean run exits 0 with no summary block", () => {
    const out = summarizeNightlyOutcome({ errors: [], skips: [] });
    expect(out.exitCode).toBe(0);
    expect(out.lines).toEqual([]);
  });
});
