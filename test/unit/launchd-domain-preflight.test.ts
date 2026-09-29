/**
 * launchd-domain-preflight.test.ts — flair#2040.
 *
 * The PURE half of the fix: the read-only preflight (domain reachable? job
 * enabled?), its classification, the gate `doctor --fix` runs before it stops
 * anything, the targeted load sequence, and the user-facing messages. No real
 * launchctl is touched — every runner is a stub. The COMMAND-level half (the
 * executors driven through a stubbed `launchctl`) is
 * test/unit/launchd-2040-command-level.test.ts.
 */
import { describe, test, expect } from "bun:test";
import {
  assessLaunchdDomain,
  assessLaunchdLoadability,
  parsePrintDisabled,
  loadLaunchdJob,
  renderDomainUnavailableMessage,
  renderStartLaunchdUnavailable,
  renderStartLaunchdFailed,
  renderDirectRunNotice,
  launchdGuiDomain,
  type DomainProbeRunner,
} from "../../src/lib/launchd-domain-preflight.ts";
import { domainPreflightRefusal } from "../../src/lib/launchd-repair.ts";

const UID = 501;
const LABEL = "ai.tpsdev.flair.deadbeef";

const runner = (r: { code: number | null; stdout?: string; stderr?: string }): DomainProbeRunner => () => ({
  code: r.code,
  stdout: r.stdout ?? "",
  stderr: r.stderr ?? "",
});

const throwing = (): DomainProbeRunner => () => {
  throw new Error("spawn launchctl ENOENT");
};

/** A runner that fails the test if it is ever called. */
const mustNotRun = (): DomainProbeRunner => () => {
  throw new Error("this probe must not run");
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

describe("parsePrintDisabled", () => {
  test("macOS 13+ form: => disabled / => enabled", () => {
    const out = `disabled services = {\n\t\t"${LABEL}" => disabled\n\t\t"com.other" => enabled\n\t}\n`;
    expect(parsePrintDisabled(out, LABEL)).toBe(true);
    expect(parsePrintDisabled(out, "com.other")).toBe(false);
  });

  test("older form: => true (disabled) / => false", () => {
    expect(parsePrintDisabled(`"${LABEL}" => true`, LABEL)).toBe(true);
    expect(parsePrintDisabled(`"${LABEL}" => false`, LABEL)).toBe(false);
  });

  test("an unlisted label is enabled (launchd lists only overrides)", () => {
    expect(parsePrintDisabled(`disabled services = {\n\t\t"com.other" => disabled\n\t}`, LABEL)).toBe(false);
  });

  test("the label is matched literally (dots are not wildcards)", () => {
    expect(parsePrintDisabled(`"aXtpsdevXflairXdeadbeef" => disabled`, LABEL)).toBe(false);
  });
});

describe("assessLaunchdLoadability — domain first, then the job's enabled state", () => {
  test("domain unavailable -> unavailable, and print-disabled is never asked", () => {
    const l = assessLaunchdLoadability({
      platform: "darwin", uid: UID, label: LABEL,
      printDomain: runner({ code: 125, stderr: "125: Domain does not support specified action" }),
      printDisabled: mustNotRun(),
    });
    expect(l.state).toBe("unavailable");
  });

  test("domain available + label disabled -> disabled (launchd would refuse the load)", () => {
    const l = assessLaunchdLoadability({
      platform: "darwin", uid: UID, label: LABEL,
      printDomain: runner({ code: 0 }),
      printDisabled: runner({ code: 0, stdout: `"${LABEL}" => disabled` }),
    });
    expect(l.state).toBe("disabled");
    if (l.state === "disabled") expect(l.reason).toContain(`${LABEL} is disabled in gui/501`);
  });

  test("domain available + print-disabled fails -> unknown (fail closed)", () => {
    const l = assessLaunchdLoadability({
      platform: "darwin", uid: UID, label: LABEL,
      printDomain: runner({ code: 0 }),
      printDisabled: runner({ code: 64, stderr: "Usage: launchctl print-disabled <domain-target>" }),
    });
    expect(l.state).toBe("unknown");
  });

  test("domain available + label enabled -> available", () => {
    const l = assessLaunchdLoadability({
      platform: "darwin", uid: UID, label: LABEL,
      printDomain: runner({ code: 0 }),
      printDisabled: runner({ code: 0, stdout: "disabled services = {\n}\n" }),
    });
    expect(l.state).toBe("available");
  });

  test("not darwin -> not-applicable, nothing probed", () => {
    const l = assessLaunchdLoadability({ platform: "linux", uid: UID, label: LABEL, printDomain: mustNotRun(), printDisabled: mustNotRun() });
    expect(l.state).toBe("not-applicable");
  });
});

describe("domainPreflightRefusal — the gate before any stop", () => {
  test("available -> null (proceed)", () => {
    expect(domainPreflightRefusal({ state: "available" }, UID)).toBeNull();
  });

  test("not-applicable -> null (proceed; non-macOS has no launchd)", () => {
    expect(domainPreflightRefusal({ state: "not-applicable", reason: "linux" }, UID)).toBeNull();
  });

  test("unavailable -> a refusal carrying the actor/state/remedy, never a repair", () => {
    const r = domainPreflightRefusal({ state: "unavailable", reason: "launchctl print gui/501 exited 125" }, UID);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("refused");
    expect(r!.reason).toBe("launchd-domain-unavailable");
    expect(r!.detail).toContain("Nothing was stopped, unloaded or rewritten");
  });

  test("unknown -> a refusal (fail closed), never a repair", () => {
    const r = domainPreflightRefusal({ state: "unknown", reason: "could not run launchctl" }, UID);
    expect(r!.kind).toBe("refused");
    expect(r!.reason).toBe("launchd-domain-unavailable");
  });

  test("disabled -> a refusal naming the enable command", () => {
    const r = domainPreflightRefusal({ state: "disabled", label: LABEL, reason: `the launchd job ${LABEL} is disabled in gui/501` }, UID);
    expect(r!.kind).toBe("refused");
    expect(r!.reason).toBe("launchd-job-disabled");
    expect(r!.detail).toContain(`launchctl enable gui/501/${LABEL}`);
  });
});

describe("the user-facing messages", () => {
  test("doctor refusal: actor, state, remedy, nothing touched — and RunAtLoad only as a CONDITIONAL possibility", () => {
    const msg = renderDomainUnavailableMessage({ state: "unavailable", reason: "launchctl print gui/501 exited 125: Domain does not support specified action" }, UID);
    expect(msg).toStartWith("flair doctor --fix: refusing to repair launchd management");
    expect(msg).toContain("the launchd GUI domain is unavailable from this session");
    expect(msg).toContain("exited 125");
    expect(msg).toContain("Nothing was stopped, unloaded or rewritten");
    expect(msg).toContain("run 'flair doctor --fix' from a console (GUI) login session");
    expect(msg).toContain("launchd may also start the job at the next console login");
    expect(msg).toContain("provided the plist is valid and the job is enabled");
    // Never the unconditional promise round 1 made.
    expect(msg).not.toContain("loads at the next console login");
  });

  test("doctor refusal for an unknown probe says it could not be verified", () => {
    const msg = renderDomainUnavailableMessage({ state: "unknown", reason: "could not run launchctl" }, UID);
    expect(msg).toContain("could not be verified from this session");
  });

  test("start: the unavailable domain is named before the direct start", () => {
    const msg = renderStartLaunchdUnavailable("flair start", { state: "unavailable", reason: "launchctl print gui/501 exited 125" });
    expect(msg).toBe(
      "flair start: launchd cannot start this instance's job from this session — the launchd GUI domain is unavailable " +
        "from this session (launchctl print gui/501 exited 125). Starting Flair directly instead.",
    );
    expect(msg).not.toContain("launchd start failed");
  });

  test("start: a failed launchd attempt names the job and the error, and says the job was unloaded again", () => {
    const msg = renderStartLaunchdFailed("flair start", LABEL, "launchctl bootstrap gui/501 x failed: 5: Input/output error");
    expect(msg).toContain(`launchd could not start the job ${LABEL}`);
    expect(msg).toContain("5: Input/output error");
    expect(msg).toContain("unloaded again");
    expect(msg).toContain("starting Flair directly instead");
  });

  test("the direct-run notice says running directly, NOT launchd-managed, with the remedy and the conditional RunAtLoad", () => {
    const lines = renderDirectRunNotice(19926, 4242);
    expect(lines[0]).toBe("✅ Flair started on port 19926 — running directly (pid 4242), NOT launchd-managed.");
    const rest = lines.slice(1).join("\n");
    expect(rest).toContain("run 'flair doctor --fix' from a console (GUI) login session");
    expect(rest).toContain("Launchd may also start the job at the next console login");
    expect(rest).toContain("provided the plist is valid and the job is enabled");
    expect(rest).toContain("exits without starting a second instance");
  });
});

describe("loadLaunchdJob — every command names the domain", () => {
  test("bootout -> bootstrap -> kickstart, all against gui/<uid>", () => {
    const calls: string[] = [];
    loadLaunchdJob({ run: (c) => { calls.push(c); }, domain: launchdGuiDomain(UID), label: LABEL, plistPath: "/x/y.plist" });
    expect(calls).toEqual([
      `launchctl bootout gui/501/${LABEL}`,
      `launchctl bootstrap gui/501 "/x/y.plist"`,
      `launchctl kickstart gui/501/${LABEL}`,
    ]);
  });

  test("a bootstrap that fails twice throws with the launchctl error; no kickstart", () => {
    const calls: string[] = [];
    expect(() => loadLaunchdJob({
      run: (c) => {
        calls.push(c);
        if (c.includes("bootstrap")) throw Object.assign(new Error("Command failed"), { stderr: "Bootstrap failed: 5: Input/output error\n" });
        if (c.includes("print")) throw new Error("Could not find service");
      },
      domain: "gui/501", label: LABEL, plistPath: "/x/y.plist", settleMs: 0, sleep: () => {},
    })).toThrow("launchctl bootstrap gui/501 /x/y.plist failed: Bootstrap failed: 5: Input/output error");
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
  });
});

describe("launchdGuiDomain", () => {
  test("the domain the LaunchAgent must load into", () => {
    expect(launchdGuiDomain(501)).toBe("gui/501");
  });
});
