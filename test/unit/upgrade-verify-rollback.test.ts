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
  isCredentialOnlyFailure,
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
// The flair#741 incident shape: server up, verifier rejected on credentials
// specifically (bare 403/401 from a responding instance).
const credentialOnlyFailure: ProbeResult = {
  healthy: true, authenticated: false, version: null, versionMatch: null, ok: false,
  authFailureKind: "credentials",
  error: "authenticated request to http://127.0.0.1:19926/HealthDetail failed: HTTP 403: no credentials sent. Set FLAIR_ADMIN_PASS, or run `flair init` to provision ~/.flair/admin-pass.",
};
// A genuine server-side auth-leg failure (5xx / network error reaching the
// authenticated endpoint) — NOT credential-shaped, must NOT be treated like
// credentialOnlyFailure above.
const serverAuthFailure: ProbeResult = {
  healthy: true, authenticated: false, version: null, versionMatch: null, ok: false,
  authFailureKind: "server",
  error: "authenticated request to http://127.0.0.1:19926/HealthDetail failed: HTTP 500",
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

  // flair#741 follow-through: a healthy instance whose ONLY failure is that the
  // verifier couldn't authenticate (credentials-only) must NOT roll back — the
  // server is provably up (public /Health passed AND it responded to the authed
  // probe), and rolling it back is exactly the destructive false-alarm the
  // incident report described (rollback re-verify fails identically → false
  // "state UNKNOWN").
  test("credentials-only failure on a healthy instance → healthy-unverified, NEVER rollback", () => {
    const decision = decideAfterVerify(credentialOnlyFailure, "1.2.2");
    expect(decision.kind).toBe("healthy-unverified");
    if (decision.kind === "healthy-unverified") {
      expect(decision.reason).toContain("no credentials sent");
    }
  });

  test("credentials-only failure → healthy-unverified even when previous version is unknown (a running instance is never rolled back)", () => {
    const decision = decideAfterVerify(credentialOnlyFailure, null);
    expect(decision.kind).toBe("healthy-unverified");
  });

  test("server-side auth-leg failure (5xx/network, not credentials) still rolls back — the fix is scoped to credentials only", () => {
    const decision = decideAfterVerify(serverAuthFailure, "1.2.2");
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

  // flair#741: a credential-only failure still rolls back (decideAfterRollbackVerify's
  // kind/reason are unchanged) — only the MESSAGE the cli.ts action prints around
  // this decision changes (see isCredentialOnlyFailure below), never the decision itself.
  test("credential-only rollback re-verify failure still decides 'rollback-failed' (decision logic unchanged by flair#741)", () => {
    const decision = decideAfterRollbackVerify(credentialOnlyFailure);
    expect(decision.kind).toBe("rollback-failed");
    if (decision.kind === "rollback-failed") {
      expect(decision.reason).toBe(credentialOnlyFailure.error);
    }
  });
});

// ─── isCredentialOnlyFailure: failure classification (flair#741 fix #3) ───────
//
// The predicate behind (a) the pre-upgrade credential pre-flight's abort
// decision and (b) whether the post-restart/post-rollback failure messages
// print the "instance state UNKNOWN — do not assume data integrity" text.
// It must be true ONLY for "server responded, credentials rejected" and
// false for every other failure shape — including ones that superficially
// look similar (unhealthy, or a non-credential auth-leg failure).

describe("isCredentialOnlyFailure", () => {
  test("healthy instance, authFailureKind 'credentials' (the flair#741 incident shape) → true", () => {
    expect(isCredentialOnlyFailure(credentialOnlyFailure)).toBe(true);
  });

  test("healthy instance, authFailureKind 'server' (5xx/network error on the auth leg) → false", () => {
    expect(isCredentialOnlyFailure(serverAuthFailure)).toBe(false);
  });

  test("unhealthy/unreachable instance → false, even though authenticated is also falsy-ish (null)", () => {
    expect(isCredentialOnlyFailure(unhealthy)).toBe(false);
  });

  test("a fully passing probe → false (nothing failed)", () => {
    expect(isCredentialOnlyFailure(ok)).toBe(false);
  });

  test("version mismatch (authenticated fine, wrong version) → false — not a credential problem at all", () => {
    expect(isCredentialOnlyFailure(mismatch)).toBe(false);
  });

  test("a ProbeResult with authFailureKind omitted entirely (older/hand-built fixture) → false, never throws", () => {
    expect(isCredentialOnlyFailure(authFailed)).toBe(false);
  });
});
