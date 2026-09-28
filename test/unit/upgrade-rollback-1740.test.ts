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
    expect(text).toContain("no listener accepted it");
    expect(text).toContain("does not show that no process was running");
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
    expect(text).toContain("check a candidate (`npm view @tpsdev-ai/flair version` — not guaranteed non-deprecated)");
    expect(text).not.toContain("install a non-deprecated version");
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
    expect(text).toBe([
      `❌❌ KNOWN-BROKEN: rollback restart failed: ${START_ERROR}`,
      "   @tpsdev-ai/flair@0.54.1 is installed and known-broken — it did not start on this attempt.",
      "   Do not run `flair start` on @tpsdev-ai/flair@0.54.1; it did not start on this attempt.",
      "   Recovery (npm-global): reinstall the version this upgrade had reached (it failed restart or verification in this run — check `flair doctor` after installing):",
      "   npm install -g @tpsdev-ai/flair@0.54.2",
      "   Or check a candidate (not guaranteed non-deprecated): npm view @tpsdev-ai/flair version",
      "   No pre-upgrade data snapshot was restored by this rollback.",
    ].join("\n"));
    expect(text).not.toContain("non-deprecated release");
    expect(text).not.toContain("cannot start");
    expect(text).not.toContain("Start it with: flair start");
    expect(text).not.toContain("plain-tree");
  });

  test("plain-tree recovery names a restored previous tree and a live tree set aside", () => {
    const text = formatKnownBrokenRollbackRestart({
      toVersion: "0.54.1",
      error: START_ERROR,
      recoveryVersion: "0.54.2",
      lane: {
        kind: "plain-tree",
        treeDir: "/opt/flair",
        failedDir: "/opt/flair.upgrade-failed",
        previousDir: "/opt/flair.upgrade-prev",
        restored: true,
        liveTreeSetAside: true,
      },
      snapshotRestored: true,
      snapshotPath: "/tmp/snap.tar.gz",
    }).join("\n");
    expect(text).toBe([
      `❌❌ KNOWN-BROKEN: rollback restart failed: ${START_ERROR}`,
      "   @tpsdev-ai/flair@0.54.1 is installed and known-broken — it did not start on this attempt.",
      "   Do not run `flair start` on @tpsdev-ai/flair@0.54.1; it did not start on this attempt.",
      "   Recovery (plain-tree): the previous tree was restored to /opt/flair. Do not npm install -g.",
      "   The live tree was set aside at /opt/flair.upgrade-failed.",
      "   Move /opt/flair.upgrade-failed back onto /opt/flair to return to @tpsdev-ai/flair@0.54.2.",
      "   A pre-upgrade data snapshot was restored before this restart failed.",
      "   Snapshot: /tmp/snap.tar.gz",
    ].join("\n"));
    expect(text).not.toContain("npm install -g @tpsdev-ai/flair@0.54.2");
    expect(text).not.toContain("Start it with: flair start");
  });

  test("plain-tree restore with nothing set aside does not claim a live tree moved", () => {
    const text = formatKnownBrokenRollbackRestart({
      toVersion: "0.54.1",
      error: START_ERROR,
      recoveryVersion: "0.54.2",
      lane: {
        kind: "plain-tree",
        treeDir: "/opt/flair",
        failedDir: "/opt/flair.upgrade-failed",
        previousDir: "/opt/flair.upgrade-prev",
        restored: true,
        liveTreeSetAside: false,
      },
      snapshotRestored: false,
    }).join("\n");
    expect(text).toBe([
      `❌❌ KNOWN-BROKEN: rollback restart failed: ${START_ERROR}`,
      "   @tpsdev-ai/flair@0.54.1 is installed and known-broken — it did not start on this attempt.",
      "   Do not run `flair start` on @tpsdev-ai/flair@0.54.1; it did not start on this attempt.",
      "   Recovery (plain-tree): the previous tree was restored to /opt/flair. Do not npm install -g.",
      "   No live tree was moved to /opt/flair.upgrade-failed. Nothing was at /opt/flair to move.",
      "   No pre-upgrade data snapshot was restored by this rollback.",
    ].join("\n"));
    expect(text).not.toContain("was set aside");
    expect(text).not.toContain("Move /opt/flair.upgrade-failed");
  });

  test("plain-tree recovery with no previous tree does not say the rollback restart failed", () => {
    const text = formatKnownBrokenRollbackRestart({
      toVersion: "0.54.1",
      error: START_ERROR,
      recoveryVersion: "0.54.2",
      lane: {
        kind: "plain-tree",
        treeDir: "/opt/flair",
        failedDir: "/opt/flair.upgrade-failed",
        previousDir: "/opt/flair.upgrade-prev",
        restored: false,
        liveTreeSetAside: false,
      },
      snapshotRestored: false,
    }).join("\n");
    expect(text).toBe([
      `❌❌ KNOWN-BROKEN: restart failed, and the previous tree was not restored: ${START_ERROR}`,
      "   The previous tree was not restored (nothing at /opt/flair.upgrade-prev), so @tpsdev-ai/flair@0.54.1 is not what this rollback installed.",
      "   The live tree is still at /opt/flair. It was not moved to /opt/flair.upgrade-failed.",
      "   Do not run `flair start` expecting @tpsdev-ai/flair@0.54.1; that version was not restored.",
      "   Recovery (plain-tree): do not npm install -g. There is no previous tree to move back onto /opt/flair.",
      "   Inspect the tree at /opt/flair, then run `flair doctor`.",
      "   No pre-upgrade data snapshot was restored by this rollback.",
    ].join("\n"));
    expect(text).not.toContain("rollback restart failed");
    expect(text).not.toContain("is installed and known-broken");
    expect(text).not.toContain("was set aside");
    expect(text).not.toContain("npm install -g @tpsdev-ai/flair@0.54.2");
  });

  test("npm-global with no distinct recovery version points at a candidate to check", () => {
    const text = formatKnownBrokenRollbackRestart({
      toVersion: "0.54.1",
      error: START_ERROR,
      recoveryVersion: null,
      lane: { kind: "npm-global" },
      snapshotRestored: false,
    }).join("\n");
    expect(text).toBe([
      `❌❌ KNOWN-BROKEN: rollback restart failed: ${START_ERROR}`,
      "   @tpsdev-ai/flair@0.54.1 is installed and known-broken — it did not start on this attempt.",
      "   Do not run `flair start` on @tpsdev-ai/flair@0.54.1; it did not start on this attempt.",
      "   Recovery (npm-global): install another release (this installed version did not start on this attempt):",
      "   npm view @tpsdev-ai/flair version",
      "   Check that candidate (not guaranteed non-deprecated), then: npm install -g @tpsdev-ai/flair@<that-version>",
      "   No pre-upgrade data snapshot was restored by this rollback.",
    ].join("\n"));
    expect(text).not.toContain("cannot start");
    expect(text).not.toContain("non-deprecated release");
  });
});
