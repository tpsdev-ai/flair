// upgrade-rollback-1740.test.ts — flair#1740.
//
// Pure decisions. Command-boundary coverage (install / health / restart) lives
// in test/unit-isolated/upgrade-rollback-1740-command.test.ts — hard-coding
// priorLiveness at the command call site leaves THESE tests green and fails
// THAT file.
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
      priorLiveness: "running",
      flairWasSwapped: true,
      previousVersion: "0.54.1",
      installedVersion: "0.54.2",
      startError: START_ERROR,
    });
    expect(decision.kind).toBe("rollback");
    if (decision.kind === "rollback") {
      expect(decision.toVersion).toBe("0.54.1");
      expect(decision.reason).toContain(START_ERROR);
      expect(decision.reason).not.toContain("indeterminate");
    }
  });

  test("confirmed stopped, restart fails → no rollback; names the install, the prior state, the start error, and flair start", () => {
    const decision = decideAfterRestartFailure({
      priorLiveness: "stopped",
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

  test("confirmed stopped with an unreadable previous version still keeps the new version", () => {
    const decision = decideAfterRestartFailure({
      priorLiveness: "stopped",
      flairWasSwapped: true,
      previousVersion: null,
      installedVersion: "0.54.2",
      startError: START_ERROR,
    });
    expect(decision.kind).toBe("keep");
    if (decision.kind === "keep") {
      expect(decision.lines.join("\n")).toContain("@tpsdev-ai/flair@0.54.2 is installed");
      expect(decision.lines.join("\n")).toContain("Next: flair start");
    }
  });

  test("indeterminate /Health is not stopped — known previous version still rolls back", () => {
    const decision = decideAfterRestartFailure({
      priorLiveness: "indeterminate",
      flairWasSwapped: true,
      previousVersion: "0.54.1",
      installedVersion: "0.54.2",
      startError: START_ERROR,
    });
    expect(decision.kind).toBe("rollback");
    if (decision.kind === "rollback") {
      expect(decision.toVersion).toBe("0.54.1");
      expect(decision.reason).toContain("indeterminate");
      expect(decision.reason).toContain("not confirmed stopped");
    }
  });

  test("indeterminate /Health with an unreadable previous version does not pretend the install was a keep", () => {
    const decision = decideAfterRestartFailure({
      priorLiveness: "indeterminate",
      flairWasSwapped: true,
      previousVersion: null,
      installedVersion: "0.54.2",
      startError: START_ERROR,
    });
    expect(decision.kind).toBe("no-target");
  });

  test("flair itself was not swapped → no rollback target, even if confirmed stopped", () => {
    const decision = decideAfterRestartFailure({
      priorLiveness: "stopped",
      flairWasSwapped: false,
      previousVersion: "0.54.1",
      installedVersion: "0.54.1",
      startError: START_ERROR,
    });
    expect(decision.kind).toBe("no-target");
  });

  test("running, previous version unknown → no rollback target", () => {
    const decision = decideAfterRestartFailure({
      priorLiveness: "running",
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

  test("control characters in the deprecation message are not printed", () => {
    const decision = decideDeprecatedRollback({
      toVersion: "0.54.1",
      lookup: { kind: "deprecated", message: "broken\u0001publish\u001b[31m" },
      installedVersion: "0.54.2",
      reason: "restart failed",
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    const text = decision.lines.join("\n");
    expect(text).toContain("brokenpublish");
    expect(text).not.toContain("\u0001");
    expect(text).not.toContain("\u001b");
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
  test("npm-global recovery reinstalls the reached version and does not claim a snapshot restore", () => {
    const text = formatKnownBrokenRollbackRestart({
      toVersion: "0.54.1",
      error: START_ERROR,
      recoveryVersion: "0.54.2",
      lane: { kind: "npm-global" },
      snapshotRestored: false,
    }).join("\n");
    expect(text).toContain("KNOWN-BROKEN");
    expect(text).toContain("@tpsdev-ai/flair@0.54.1 is installed and known-broken");
    expect(text).toContain("it failed restart or verification in this run");
    expect(text).toContain("check `flair doctor` after installing");
    expect(text).toContain("npm install -g @tpsdev-ai/flair@0.54.2");
    expect(text).toContain("Or install another non-deprecated release: npm view @tpsdev-ai/flair version");
    expect(text).toContain("No pre-upgrade data snapshot was restored");
    expect(text).not.toContain("Start it with: flair start");
    expect(text).not.toContain("plain-tree");
  });

  test("plain-tree recovery names the set-aside tree and does not tell the operator to npm install -g", () => {
    const text = formatKnownBrokenRollbackRestart({
      toVersion: "0.54.1",
      error: START_ERROR,
      recoveryVersion: "0.54.2",
      lane: {
        kind: "plain-tree",
        treeDir: "/opt/flair",
        failedDir: "/opt/flair.upgrade-failed",
      },
      snapshotRestored: true,
      snapshotPath: "/tmp/snap.tar.gz",
    }).join("\n");
    expect(text).toContain("plain-tree");
    expect(text).toContain("/opt/flair.upgrade-failed");
    expect(text).toContain("do not npm install -g");
    expect(text).not.toContain("npm install -g @tpsdev-ai/flair@0.54.2");
    expect(text).toContain("A pre-upgrade data snapshot was restored");
    expect(text).toContain("/tmp/snap.tar.gz");
    expect(text).not.toContain("No pre-upgrade data snapshot was restored");
    expect(text).not.toContain("Start it with: flair start");
  });

  test("npm-global with no distinct recovery version points at npm view", () => {
    const text = formatKnownBrokenRollbackRestart({
      toVersion: "0.54.1",
      error: START_ERROR,
      recoveryVersion: null,
      lane: { kind: "npm-global" },
      snapshotRestored: false,
    }).join("\n");
    expect(text).toContain("npm view @tpsdev-ai/flair version");
    expect(text).toContain("npm install -g @tpsdev-ai/flair@<that-version>");
  });
});
