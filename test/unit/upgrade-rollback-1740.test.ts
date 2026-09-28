// upgrade-rollback-1740.test.ts — flair#1740.
//
// `flair upgrade` used to treat "restart failed" and "there was nothing
// running to restart" as the same condition, and rolled a successful install
// back to a previous version that had never been healthy (published 0.54.1).
// These decisions are pure so the never-running case fails without a Harper.
//
// The never-running assertion is the regression: on the pre-fix behavior a
// swapped package with a known previous version always rolled back, so
// `kind === "keep"` fails against that behavior.
import { describe, test, expect } from "bun:test";
import {
  decideAfterRestartFailure,
  decideDeprecatedRollback,
  formatKnownBrokenRollbackRestart,
} from "../../src/lib/upgrade-rollback.ts";

const START_ERROR = "Harper at port 19926 did not respond within 60000ms (120 attempts)";

describe("decideAfterRestartFailure (flair#1740)", () => {
  test("was running, restart fails → rollback to the previous version", () => {
    const decision = decideAfterRestartFailure({
      wasRunning: true,
      flairWasSwapped: true,
      previousVersion: "0.54.1",
      installedVersion: "0.54.2",
      startError: START_ERROR,
    });
    expect(decision.kind).toBe("rollback");
    if (decision.kind === "rollback") {
      expect(decision.toVersion).toBe("0.54.1");
      expect(decision.reason).toContain(START_ERROR);
    }
  });

  test("was not running, restart fails → no rollback; names the install, the prior state, the start error, and flair start", () => {
    const decision = decideAfterRestartFailure({
      wasRunning: false,
      flairWasSwapped: true,
      previousVersion: "0.54.1",
      installedVersion: "0.54.2",
      startError: START_ERROR,
    });
    expect(decision.kind).toBe("keep");
    if (decision.kind !== "keep") return;
    const text = decision.lines.join("\n");
    expect(text).toContain("@tpsdev-ai/flair@0.54.2 is installed");
    expect(text).toContain("was not running before this upgrade");
    expect(text).toContain("nothing was rolled back");
    expect(text).toContain(START_ERROR);
    expect(text).toContain("flair start");
    expect(text).not.toContain("Rolling back");
  });

  test("a stopped install with an unknown installed version still keeps the upgrade and names flair start", () => {
    const decision = decideAfterRestartFailure({
      wasRunning: false,
      flairWasSwapped: true,
      previousVersion: "0.54.1",
      installedVersion: null,
      startError: START_ERROR,
    });
    expect(decision.kind).toBe("keep");
    if (decision.kind === "keep") {
      expect(decision.lines.join("\n")).toContain("Next: flair start");
    }
  });

  test("flair itself was not swapped → no rollback target (unchanged)", () => {
    const decision = decideAfterRestartFailure({
      wasRunning: false,
      flairWasSwapped: false,
      previousVersion: "0.54.1",
      installedVersion: "0.54.1",
      startError: START_ERROR,
    });
    expect(decision.kind).toBe("no-target");
  });

  test("previous version unknown → no rollback target, even if nothing was running", () => {
    const decision = decideAfterRestartFailure({
      wasRunning: false,
      flairWasSwapped: true,
      previousVersion: null,
      installedVersion: "0.54.2",
      startError: START_ERROR,
    });
    expect(decision.kind).toBe("no-target");
  });
});

describe("decideDeprecatedRollback (flair#1740)", () => {
  test("rollback target npm marks deprecated → no rollback, message names the deprecation", () => {
    const decision = decideDeprecatedRollback({
      toVersion: "0.54.1",
      lookup: { kind: "deprecated", message: "broken publish — missing Harper transitive deps" },
      installedVersion: "0.54.2",
      reason: "restart failed: Harper did not respond",
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    const text = decision.lines.join("\n");
    expect(text).toContain("Not rolling back");
    expect(text).toContain("@tpsdev-ai/flair@0.54.1");
    expect(text).toContain("deprecated");
    expect(text).toContain("broken publish — missing Harper transitive deps");
    expect(text).toContain("@tpsdev-ai/flair@0.54.2 stays installed");
    expect(text).not.toContain("Rolling back @tpsdev-ai/flair to 0.54.1");
  });

  test("version npm does not mark deprecated → rollback proceeds", () => {
    expect(decideDeprecatedRollback({
      toVersion: "0.54.0",
      lookup: { kind: "active" },
      installedVersion: "0.54.2",
      reason: "restart failed",
    }).kind).toBe("proceed");
  });

  test("registry lookup failed → not evidence of deprecation, rollback proceeds", () => {
    expect(decideDeprecatedRollback({
      toVersion: "0.54.0",
      lookup: { kind: "unknown" },
      installedVersion: "0.54.2",
      reason: "restart failed",
    }).kind).toBe("proceed");
  });
});

describe("formatKnownBrokenRollbackRestart (flair#1740)", () => {
  test("rollback restart failure names the installed version as known-broken and a recovery that is not flair start", () => {
    const lines = formatKnownBrokenRollbackRestart({
      toVersion: "0.54.1",
      error: START_ERROR,
      recoveryVersion: "0.54.2",
    });
    const text = lines.join("\n");
    expect(text).toContain("KNOWN-BROKEN");
    expect(text).toContain("@tpsdev-ai/flair@0.54.1 is installed and known-broken");
    expect(text).toContain(START_ERROR);
    expect(text).toContain("npm install -g @tpsdev-ai/flair@0.54.2");
    expect(text).not.toContain("Start it with: flair start");
    expect(text).toContain("cannot start");
  });

  test("with no distinct recovery version, points at a non-deprecated release instead of flair start", () => {
    const text = formatKnownBrokenRollbackRestart({
      toVersion: "0.54.1",
      error: START_ERROR,
      recoveryVersion: null,
    }).join("\n");
    expect(text).toContain("known-broken");
    expect(text).toContain("npm view @tpsdev-ai/flair version");
    expect(text).toContain("npm install -g @tpsdev-ai/flair@<that-version>");
    expect(text).not.toContain("Start it with: flair start");
  });
});
