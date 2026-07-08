// upgrade-verify-rollback.test.ts — Unit tests for flair#635: `flair upgrade`'s
// restart-is-now-default flag plumbing, and the pure post-restart
// verify/rollback decision logic. Mocks ProbeResult — never spawns Harper
// (see test/integration/probe-instance.test.ts for the real round-trip).
import { describe, test, expect } from "bun:test";
import {
  program,
  resolveUpgradeRestartVerify,
  decideAfterVerify,
  decideAfterRollbackVerify,
} from "../../src/cli";
import type { ProbeResult } from "../../src/probe";

function findCommand(root: any, path: string[]): any {
  let node = root;
  for (const name of path) {
    node = node.commands.find((c: any) => c.name() === name);
    if (!node) return null;
  }
  return node;
}

const ok: ProbeResult = { healthy: true, authenticated: true, version: "1.2.3", versionMatch: true, ok: true };
const mismatch: ProbeResult = {
  healthy: true, authenticated: true, version: "1.2.2", versionMatch: false, ok: false,
  error: "version mismatch: expected 1.2.3, instance reports 1.2.2",
};
const unhealthy: ProbeResult = {
  healthy: false, authenticated: null, version: null, versionMatch: null, ok: false,
  error: "instance did not answer http://127.0.0.1:19926/Health within 60000ms",
};
const authFailed: ProbeResult = {
  healthy: true, authenticated: false, version: null, versionMatch: null, ok: false,
  error: "authenticated request to http://127.0.0.1:19926/HealthDetail failed: 403 forbidden",
};

// ─── Commander wiring: --restart / --no-restart / --no-verify ────────────────

describe("flair upgrade — Commander flag wiring (flair#635)", () => {
  test("upgrade command accepts --restart (deprecated), --no-restart, and --no-verify", () => {
    const upgrade = findCommand(program, ["upgrade"]);
    expect(upgrade).not.toBeNull();
    const optionNames = upgrade.options.map((o: any) => o.long);
    expect(optionNames).toContain("--restart");
    expect(optionNames).toContain("--no-restart");
    expect(optionNames).toContain("--no-verify");
  });

  test("--check is still a distinct flag, unaffected by the restart/verify additions", () => {
    const upgrade = findCommand(program, ["upgrade"]);
    const optionNames = upgrade.options.map((o: any) => o.long);
    expect(optionNames).toContain("--check");
  });
});

// ─── resolveUpgradeRestartVerify: pure flag-resolution ────────────────────────

describe("resolveUpgradeRestartVerify", () => {
  test("no flags at all → restart defaults true, verify defaults true, no deprecation notice", () => {
    const r = resolveUpgradeRestartVerify({});
    expect(r.restart).toBe(true);
    expect(r.verify).toBe(true);
    expect(r.deprecatedRestartFlagUsed).toBe(false);
  });

  test("--no-restart (opts.restart === false) → restart false, deprecation notice not fired", () => {
    const r = resolveUpgradeRestartVerify({ restart: false });
    expect(r.restart).toBe(false);
    expect(r.deprecatedRestartFlagUsed).toBe(false);
  });

  test("--restart (opts.restart === true, the deprecated flag) → restart stays true, deprecation notice DOES fire", () => {
    const r = resolveUpgradeRestartVerify({ restart: true });
    expect(r.restart).toBe(true);
    expect(r.deprecatedRestartFlagUsed).toBe(true);
  });

  test("--no-verify (opts.verify === false) → verify false, restart unaffected", () => {
    const r = resolveUpgradeRestartVerify({ verify: false });
    expect(r.verify).toBe(false);
    expect(r.restart).toBe(true);
  });

  test("--no-restart and --no-verify together", () => {
    const r = resolveUpgradeRestartVerify({ restart: false, verify: false });
    expect(r.restart).toBe(false);
    expect(r.verify).toBe(false);
  });
});

// ─── decideAfterVerify: post-restart verification → action ───────────────────

describe("decideAfterVerify", () => {
  test("a passing ProbeResult → ok, no rollback", () => {
    const decision = decideAfterVerify(ok, "1.2.2");
    expect(decision.kind).toBe("ok");
  });

  test("version mismatch + known previous version → rollback to that version", () => {
    const decision = decideAfterVerify(mismatch, "1.2.2");
    expect(decision.kind).toBe("rollback");
    if (decision.kind === "rollback") {
      expect(decision.toVersion).toBe("1.2.2");
      expect(decision.reason).toContain("version mismatch");
    }
  });

  test("unhealthy instance + known previous version → rollback (health failures roll back too)", () => {
    const decision = decideAfterVerify(unhealthy, "1.2.2");
    expect(decision.kind).toBe("rollback");
    if (decision.kind === "rollback") expect(decision.toVersion).toBe("1.2.2");
  });

  test("auth failure + known previous version → rollback", () => {
    const decision = decideAfterVerify(authFailed, "1.2.2");
    expect(decision.kind).toBe("rollback");
  });

  test("failing ProbeResult but previous version is unknown (null) → cannot-rollback, never guesses a target", () => {
    const decision = decideAfterVerify(mismatch, null);
    expect(decision.kind).toBe("cannot-rollback");
    if (decision.kind === "cannot-rollback") {
      expect(decision.reason).toContain("version mismatch");
    }
  });

  test("cannot-rollback preserves the original failure reason for operator visibility", () => {
    const decision = decideAfterVerify(unhealthy, null);
    expect(decision.kind).toBe("cannot-rollback");
    if (decision.kind === "cannot-rollback") {
      expect(decision.reason).toBe(unhealthy.error);
    }
  });
});

// ─── decideAfterRollbackVerify: rollback re-verification → final outcome ──────

describe("decideAfterRollbackVerify", () => {
  test("rollback re-verifies healthy → rolled-back", () => {
    const decision = decideAfterRollbackVerify(ok);
    expect(decision.kind).toBe("rolled-back");
  });

  test("rollback re-verification ALSO fails → rollback-failed, loud, with reason (never loops)", () => {
    const decision = decideAfterRollbackVerify(unhealthy);
    expect(decision.kind).toBe("rollback-failed");
    if (decision.kind === "rollback-failed") {
      expect(decision.reason).toBe(unhealthy.error);
    }
  });

  test("rollback-failed still carries a reason even when the probe result has no error string", () => {
    const bareFailure: ProbeResult = { healthy: false, authenticated: null, version: null, versionMatch: null, ok: false };
    const decision = decideAfterRollbackVerify(bareFailure);
    expect(decision.kind).toBe("rollback-failed");
    if (decision.kind === "rollback-failed") {
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});
