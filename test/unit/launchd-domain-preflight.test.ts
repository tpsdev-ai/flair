/**
 * launchd-domain-preflight.test.ts — flair#2040.
 *
 * The hermetic half of the fix: the domain preflight, the job-loaded check, the
 * user-facing messages, and the pure gate `doctor --fix` runs BEFORE it stops
 * anything. No real launchctl is touched — the runner is a stub.
 */
import { describe, test, expect } from "bun:test";
import {
  assessLaunchdDomain,
  verifyLaunchdJobLoaded,
  renderDomainUnavailableMessage,
  renderInitJobNotLoadedMessage,
  renderStartFallbackMessage,
  initLaunchdStatusLine,
  launchdGuiDomain,
  type DomainProbeRunner,
} from "../../src/lib/launchd-domain-preflight.ts";
import { domainPreflightRefusal } from "../../src/lib/launchd-repair.ts";

const UID = 501;

const runner = (r: { code: number | null; stdout?: string; stderr?: string }): DomainProbeRunner => () => ({
  code: r.code,
  stdout: r.stdout ?? "",
  stderr: r.stderr ?? "",
});

const throwing = (): DomainProbeRunner => () => {
  throw new Error("spawn launchctl ENOENT");
};

describe("assessLaunchdDomain", () => {
  test("not darwin -> not-applicable", () => {
    const a = assessLaunchdDomain({ platform: "linux", uid: UID, run: runner({ code: 0 }) });
    expect(a.state).toBe("not-applicable");
  });

  test("gui domain answers (code 0) -> available", () => {
    const a = assessLaunchdDomain({ platform: "darwin", uid: UID, run: runner({ code: 0 }) });
    expect(a.state).toBe("available");
  });

  test("code 125 (Domain does not support specified action) -> unavailable", () => {
    const a = assessLaunchdDomain({
      platform: "darwin",
      uid: UID,
      run: runner({ code: 125, stderr: "125: Domain does not support specified action\n" }),
    });
    expect(a.state).toBe("unavailable");
    if (a.state === "unavailable") expect(a.reason).toContain("125");
  });

  test("code 5 (Input/output error) -> unavailable", () => {
    const a = assessLaunchdDomain({
      platform: "darwin",
      uid: UID,
      run: runner({ code: 5, stderr: "5: Input/output error\n" }),
    });
    expect(a.state).toBe("unavailable");
  });

  test("the ssh signature on a non-125 code is still unavailable", () => {
    const a = assessLaunchdDomain({
      platform: "darwin",
      uid: UID,
      run: runner({ code: 1, stderr: "Domain does not support specified action\n" }),
    });
    expect(a.state).toBe("unavailable");
  });

  test("an uninterpretable non-zero exit -> unknown (fail closed, NOT available)", () => {
    const a = assessLaunchdDomain({
      platform: "darwin",
      uid: UID,
      run: runner({ code: 2, stderr: "some other launchctl complaint\n" }),
    });
    expect(a.state).toBe("unknown");
    expect(a.state).not.toBe("available");
  });

  test("a launchctl that cannot be run -> unknown", () => {
    const a = assessLaunchdDomain({ platform: "darwin", uid: UID, run: throwing() });
    expect(a.state).toBe("unknown");
  });
});

describe("verifyLaunchdJobLoaded", () => {
  test("not darwin -> not-applicable", () => {
    const s = verifyLaunchdJobLoaded({ platform: "linux", uid: UID, label: "ai.x", run: runner({ code: 1 }) });
    expect(s).toEqual({ state: "not-applicable", reason: "linux does not use launchd" });
  });

  test("print <domain>/<label> code 0 -> loaded", () => {
    const s = verifyLaunchdJobLoaded({ platform: "darwin", uid: UID, label: "ai.tpsdev.flair.deadbeef", run: runner({ code: 0 }) });
    expect(s).toMatchObject({ loaded: true });
  });

  test("code 125 -> NOT loaded (never a check mark for a job that did not load)", () => {
    const s = verifyLaunchdJobLoaded({
      platform: "darwin",
      uid: UID,
      label: "ai.tpsdev.flair.deadbeef",
      run: runner({ code: 125, stderr: "125: Domain does not support specified action\n" }),
    });
    expect(s).toMatchObject({ loaded: false });
    if ("reason" in s) expect(s.reason).toContain("125");
  });

  test("a launchctl that cannot be run -> NOT loaded", () => {
    const s = verifyLaunchdJobLoaded({ platform: "darwin", uid: UID, label: "ai.x", run: throwing() });
    expect(s).toMatchObject({ loaded: false });
  });
});

describe("the user-facing messages", () => {
  test("domain-unavailable names the actor, the state and the remedy, and that nothing was stopped", () => {
    const msg = renderDomainUnavailableMessage({ state: "unavailable", reason: "launchctl print gui/501 exited 125" });
    expect(msg).toContain("flair doctor --fix");
    expect(msg).toContain("launchd GUI domain is unavailable from this session");
    expect(msg).toContain("RunAtLoad");
    expect(msg).toContain("console session");
    expect(msg).toContain("left untouched");
  });

  test("unknown says it could not be verified, and still refuses to act", () => {
    const msg = renderDomainUnavailableMessage({ state: "unknown", reason: "could not run launchctl" });
    expect(msg).toContain("could not be verified from this session");
    expect(msg).toContain("left untouched");
  });

  test("init's not-loaded message says the plist was written and it loads at next login", () => {
    const msg = renderInitJobNotLoadedMessage("launchctl print gui/501/ai.x exited 125");
    expect(msg).toContain("plist written");
    expect(msg).toContain("loads at the next console login");
    expect(msg).toContain("exited 125");
  });

  test("start's fallback message says why and that it loads at next login", () => {
    const msg = renderStartFallbackMessage("launchctl print gui/501 exited 125");
    expect(msg).toContain("could not load the job from this session");
    expect(msg).toContain("starting directly");
    expect(msg).toContain("next console login");
  });
});

describe("domainPreflightRefusal — the gate before any stop", () => {
  test("available -> null (proceed)", () => {
    expect(domainPreflightRefusal({ state: "available" })).toBeNull();
  });

  test("not-applicable -> null (proceed; non-macOS has no launchd)", () => {
    expect(domainPreflightRefusal({ state: "not-applicable", reason: "linux" })).toBeNull();
  });

  test("unavailable -> a refusal carrying the actor/state/remedy, never a repair", () => {
    const r = domainPreflightRefusal({ state: "unavailable", reason: "launchctl print gui/501 exited 125" });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("refused");
    expect(r!.reason).toBe("launchd-domain-unavailable");
    expect(r!.detail).toContain("left untouched");
  });

  test("unknown -> a refusal (fail closed), never a repair", () => {
    const r = domainPreflightRefusal({ state: "unknown", reason: "could not run launchctl" });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("refused");
  });
});

describe("initLaunchdStatusLine — init prints a check mark only for a LOADED job", () => {
  test("written + loaded -> registered ✓", () => {
    expect(initLaunchdStatusLine({ outcome: "written", loaded: true })).toBe("Launchd service registered ✓");
  });

  test("written + NOT loaded -> 'plist written; it loads at the next console login', no check mark", () => {
    const line = initLaunchdStatusLine({ outcome: "written", loaded: false, reason: "launchctl print gui/501/ai.x exited 125" });
    expect(line).not.toContain("✓");
    expect(line).toContain("plist written");
    expect(line).toContain("loads at the next console login");
    expect(line).toContain("exited 125");
  });

  test("unchanged + loaded -> already managed ✓", () => {
    expect(initLaunchdStatusLine({ outcome: "unchanged", loaded: true })).toBe(
      "Launchd service already managed — plist unchanged ✓",
    );
  });

  test("unchanged + NOT loaded -> no check mark, says it loads at next login", () => {
    const line = initLaunchdStatusLine({ outcome: "unchanged", loaded: false, reason: "no GUI domain" });
    expect(line).not.toContain("✓");
    expect(line).toContain("loads at the next console login");
  });
});

describe("launchdGuiDomain", () => {
  test("the domain the LaunchAgent must load into", () => {
    expect(launchdGuiDomain(501)).toBe("gui/501");
  });
});
