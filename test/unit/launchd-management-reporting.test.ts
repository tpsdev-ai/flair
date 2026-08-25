// launchd-management-reporting.test.ts — flair#1022.
//
// The defect, from a real upgrade: `flair upgrade` hit two 60-second launchd
// timeouts, fell back to a port-based stop and then a direct (non-launchd)
// start, and finished with
//
//     ✅ verified: healthy, authenticated, running 0.33.0
//
// Every word of which was true. The instance was healthy, authenticated and on
// the new version — and no longer under the process manager that is supposed to
// own it, so it would not have come back after a reboot. **Healthy and managed
// are different claims, and only the first was being made.**
//
// What these tests pin:
//
//   1. `assessLaunchdManagement` calls the degraded state degraded. Every
//      branch, including the ones that must NOT warn — a check that fires on a
//      healthy install is worse than no check, because it trains an operator to
//      skip the line where the real warning will appear.
//   2. `diagnoseLaunchdPlistPaths` names the stale path. `launchctl load` and
//      `launchctl start` both exit 0 for a job whose program does not exist
//      (measured on macOS 15 — that is precisely why the CLI could only learn
//      about the failure by waiting out its startup budget), so the plist's own
//      absolute paths are the only up-front evidence available.
//   3. End to end, through the real CLI: a `flair restart` that ends detached
//      does NOT print an unqualified success marker, and one that ends managed
//      still does — plus both of the incident's 60-second waits, asserted as
//      elapsed time rather than as a code path.
//
// SAFETY — this file manipulates launchd-shaped state on a host that may be
// running a real Flair:
//
//   - HOME is a throwaway directory, via a genuinely spawned subprocess
//     (Bun's os.homedir() ignores an in-process process.env.HOME mutation).
//     Every plist, data dir and label therefore resolves inside the fixture.
//   - `launchctl` is a shim on PATH that records its arguments and answers from
//     files this test writes. **No launchctl command in this file reaches real
//     launchd**, and none names a real ~/Library/LaunchAgents path.
//   - The only process any test can signal is a health stub it spawned itself,
//     and each test asserts whether that stub should still be serving — so a
//     stray SIGTERM shows up as a failed assertion rather than as damage. One
//     test DOES expect its stub to be stopped, because it asks the CLI to stop
//     the instance the stub stands in for; it says so at the assertion.
//   - No test lets the CLI reach a REAL direct-start fallback, because that
//     fallback spawns a real Harper. Cases that must reach the start leg run
//     the CLI out of a copied package tree containing no Harper, so the
//     fallback exits on `resolveHarperBin` instead of launching a database
//     (see probePackage). Every other case is arranged so the launchd path
//     succeeds against the shim + stub, or the run aborts before the start leg.
//
// COVERAGE — the end-to-end half of this file is darwin-only, because the code
// it exercises is gated on `process.platform === "darwin"`. Linux CI reports
// those cases as skipped (`test.skipIf(!isDarwin)`, flair#1012); the
// darwin-gated unit-test lane is what executes them. The pure tests are
// deliberately platform-independent so the decision logic is gated everywhere.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessLaunchdManagement,
  diagnoseLaunchdPlistPaths,
  isDetached,
  parseLaunchctlList,
  pickInstancePid,
  readLaunchctlJobState,
  readPlistProgramRefs,
  renderDetachedWarning,
  renderVerifiedSummary,
  type LaunchctlLister,
} from "../../src/lib/launchd-management.ts";
import { launchdLabel, launchdPlistPath } from "../../src/cli";

const isDarwin = process.platform === "darwin";
const repoRoot = join(import.meta.dirname, "..", "..");
const cliPath = join(repoRoot, "src", "cli.ts");

/** `launchctl list <label>` output for a job launchd is currently running. */
function listRunning(label: string, pid: number): string {
  return `{\n\t"Label" = "${label}";\n\t"OnDemand" = false;\n\t"LastExitStatus" = 0;\n\t"PID" = ${pid};\n};\n`;
}

/**
 * `launchctl list <label>` output for a job that is loaded but NOT running —
 * no PID key at all, and a nonzero LastExitStatus. This is the real shape of a
 * job whose program cannot be exec'd: 19968 is what launchd recorded in the
 * measurement behind this fix.
 */
function listLoadedNotRunning(label: string, lastExitStatus = 19968): string {
  return `{\n\t"Label" = "${label}";\n\t"OnDemand" = false;\n\t"LastExitStatus" = ${lastExitStatus};\n};\n`;
}

/** A lister that always answers with `stdout`, exit 0. */
function listerFor(stdout: string): LaunchctlLister {
  return () => ({ code: 0, stdout });
}

/** A lister that answers as launchctl does for an unregistered label. */
const unregisteredLister: LaunchctlLister = (label) => ({
  code: 113,
  stdout: `Could not find service "${label}" in domain for port\n`,
});

function plistWith(opts: {
  label: string;
  rootPath: string;
  programArguments?: string[];
  workingDirectory?: string;
}): string {
  const args = (opts.programArguments ?? ["/usr/bin/true", "run", "."])
    .map((a) => `    <string>${a}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${opts.label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${opts.workingDirectory ?? "/"}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROOTPATH</key><string>${opts.rootPath}</string>
  </dict>
</dict>
</plist>`;
}

// ─── 1. the verdict: is this instance under launchd? ───────────────────────

describe("flair#1022 — assessLaunchdManagement distinguishes healthy from managed", () => {
  const base = {
    label: "ai.tpsdev.flair.deadbeef",
    plistPath: "/fixture/LaunchAgents/ai.tpsdev.flair.deadbeef.plist",
    plistExists: () => true,
    // Fixed answer so these tests never depend on the real filesystem: the
    // plist paths are "fine", so a detached verdict carries the generic remedy.
    diagnose: () => null,
  };

  test("a plist whose job launchd is running, as this instance's process, is managed", () => {
    const m = assessLaunchdManagement({
      ...base,
      platform: "darwin",
      instancePid: 4242,
      list: listerFor(listRunning(base.label, 4242)),
    });
    expect(m.state).toBe("managed");
    expect(isDetached(m)).toBe(false);
  });

  test("THE DEFECT: a loaded job with no running process is detached, not managed", () => {
    const m = assessLaunchdManagement({
      ...base,
      platform: "darwin",
      // A directly-spawned process is serving the instance — the fallback's
      // outcome. launchd holds the job and is running nothing.
      instancePid: 4242,
      list: listerFor(listLoadedNotRunning(base.label)),
    });
    expect(m.state).toBe("detached");
    expect(isDetached(m)).toBe(true);
    // The operator has to be able to act on this: it says which job, that
    // launchd is not running it, and how the last attempt ended.
    expect(m.detail).toContain(base.label);
    expect(m.detail).toContain("19968");
    expect(m.remedy?.length ?? 0).toBeGreaterThan(0);
  });

  test("launchd running a DIFFERENT process than the one serving the instance is detached", () => {
    const m = assessLaunchdManagement({
      ...base,
      platform: "darwin",
      instancePid: 4242,
      list: listerFor(listRunning(base.label, 9999)),
    });
    expect(m.state).toBe("detached");
    expect(m.detail).toContain("4242");
    expect(m.detail).toContain("9999");
  });

  test("a plist on disk whose label launchd does not know is detached", () => {
    const m = assessLaunchdManagement({
      ...base,
      platform: "darwin",
      instancePid: 4242,
      list: unregisteredLister,
    });
    expect(m.state).toBe("detached");
    expect(m.detail).toContain("not loaded");
  });

  // ─── the false-positive guards. An over-eager check is its own defect. ───

  test("POSITIVE CONTROL: a running job with an unreadable instance PID is managed, not detached", () => {
    // hdb.pid missing and lsof unavailable is a real condition on a working
    // install. A live job under THIS instance's label is positive evidence;
    // demanding a second, less reliable source before believing it would warn
    // on healthy installs every time.
    const m = assessLaunchdManagement({
      ...base,
      platform: "darwin",
      instancePid: null,
      list: listerFor(listRunning(base.label, 4242)),
    });
    expect(m.state).toBe("managed");
  });

  test("POSITIVE CONTROL: off darwin nothing is claimed, and launchctl is never consulted", () => {
    let consulted = 0;
    const m = assessLaunchdManagement({
      ...base,
      platform: "linux",
      instancePid: 4242,
      list: () => { consulted++; return { code: 0, stdout: "" }; },
    });
    expect(m.state).toBe("not-applicable");
    expect(isDetached(m)).toBe(false);
    expect(consulted).toBe(0);
  });

  test("POSITIVE CONTROL: an instance with no registered service is not a degradation", () => {
    // Nothing ever claimed to manage it, so nothing was lost. Reporting this
    // as detached would mean every non-launchd macOS install warns forever.
    const m = assessLaunchdManagement({
      ...base,
      platform: "darwin",
      instancePid: 4242,
      plistExists: () => false,
      list: listerFor(listRunning(base.label, 4242)),
    });
    expect(m.state).toBe("no-service");
    expect(isDetached(m)).toBe(false);
  });

  test("a detached verdict carries the plist diagnosis as its cause when there is one", () => {
    const m = assessLaunchdManagement({
      ...base,
      platform: "darwin",
      instancePid: 4242,
      list: listerFor(listLoadedNotRunning(base.label)),
      diagnose: () => ({
        kind: "ProgramArguments",
        stalePath: "/old/runtime/bin/node",
        message: "the launchd plist runs /old/runtime/bin/node, which no longer exists.",
        remedy: ["flair init", "flair restart"],
      }),
    });
    expect(m.state).toBe("detached");
    expect(m.detail).toContain("/old/runtime/bin/node");
    expect(m.remedy).toEqual(["flair init", "flair restart"]);
  });
});

describe("flair#1022 — pickInstancePid keeps a stale PID file from faking a detachment", () => {
  const alive = (pid: number) => pid === 4242;

  test("prefers a live hdb.pid over the port listener", () => {
    expect(pickInstancePid({ pidFilePid: 4242, isAlive: alive, listeningPids: [7777] })).toBe(4242);
  });

  test("POSITIVE CONTROL: a DEAD hdb.pid is discarded, not reported as the instance", () => {
    // A leftover PID file names a number that matches nothing, and a mismatch
    // is exactly what this module calls "detached" — so without this, a stale
    // file produces a loud, wrong warning on a healthy launchd install.
    expect(pickInstancePid({ pidFilePid: 9999, isAlive: alive, listeningPids: [7777] })).toBe(7777);
  });

  test("falls back to the listener when there is no PID file, and to null when there is nothing", () => {
    expect(pickInstancePid({ pidFilePid: null, isAlive: alive, listeningPids: [7777] })).toBe(7777);
    expect(pickInstancePid({ pidFilePid: null, isAlive: alive, listeningPids: [] })).toBeNull();
    expect(pickInstancePid({ pidFilePid: 9999, isAlive: alive, listeningPids: [] })).toBeNull();
  });
});

describe("flair#1022 — parseLaunchctlList / readLaunchctlJobState", () => {
  test("reads PID and LastExitStatus out of launchctl's dict", () => {
    expect(parseLaunchctlList(listRunning("x", 1234))).toEqual({ pid: 1234, lastExitStatus: 0 });
  });

  test("a job with no PID key reports pid null — that absence IS the signal", () => {
    expect(parseLaunchctlList(listLoadedNotRunning("x", 19968))).toEqual({ pid: null, lastExitStatus: 19968 });
  });

  test("a nonzero exit from launchctl means the label is not registered", () => {
    expect(readLaunchctlJobState("x", unregisteredLister)).toEqual({
      registered: false, pid: null, lastExitStatus: null,
    });
  });

  test("a lister that throws is not registered rather than an exception", () => {
    expect(readLaunchctlJobState("x", () => { throw new Error("launchctl missing"); })).toEqual({
      registered: false, pid: null, lastExitStatus: null,
    });
  });
});

// ─── 2. why launchd failed: the stale-path pre-flight ──────────────────────

describe("flair#1022 — diagnoseLaunchdPlistPaths names the stale path up front", () => {
  let dir: string;
  let plistPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flair1022-plist-"));
    plistPath = join(dir, "svc.plist");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reads ProgramArguments and WorkingDirectory back out of a plist", () => {
    writeFileSync(plistPath, plistWith({
      label: "svc",
      rootPath: "/data",
      programArguments: ["/bin/node", "/pkg/harper.js", "run", "."],
      workingDirectory: "/pkg",
    }));
    expect(readPlistProgramRefs(plistPath)).toEqual({
      programArguments: ["/bin/node", "/pkg/harper.js", "run", "."],
      workingDirectory: "/pkg",
    });
  });

  test("decodes XML-escaped paths, so a path containing & is reported literally", () => {
    writeFileSync(plistPath, plistWith({
      label: "svc",
      rootPath: "/data",
      programArguments: ["/opt/a&amp;b/node", "run"],
      workingDirectory: "/opt/a&amp;b",
    }));
    const refs = readPlistProgramRefs(plistPath)!;
    expect(refs.programArguments[0]).toBe("/opt/a&b/node");
    expect(refs.workingDirectory).toBe("/opt/a&b");
  });

  test("THE 60-SECOND WAIT: a missing program is detected without asking launchd anything", () => {
    // This is the whole point. launchctl load and launchctl start BOTH exit 0
    // here; the only other way to find out is to wait out the startup budget
    // against a port that will never open.
    const gone = join(dir, "runtimes", "v22", "bin", "node");
    writeFileSync(plistPath, plistWith({
      label: "svc",
      rootPath: dir,
      programArguments: [gone, join(dir, "harper.js"), "run", "."],
      workingDirectory: dir,
    }));
    const stale = diagnoseLaunchdPlistPaths(plistPath);
    expect(stale).not.toBeNull();
    expect(stale!.kind).toBe("ProgramArguments");
    expect(stale!.stalePath).toBe(gone);
    expect(stale!.message).toContain(gone);
    // Naming the path without naming the fix leaves the operator where they
    // started, so the remedy is part of the contract.
    expect(stale!.remedy.join(" ")).toContain("flair init");
  });

  test("a missing WorkingDirectory is caught too", () => {
    const node = join(dir, "node");
    writeFileSync(node, "#!/bin/sh\n", { mode: 0o755 });
    const goneDir = join(dir, "gone-package-dir");
    writeFileSync(plistPath, plistWith({
      label: "svc",
      rootPath: dir,
      programArguments: [node, "run", "."],
      workingDirectory: goneDir,
    }));
    const stale = diagnoseLaunchdPlistPaths(plistPath);
    expect(stale).not.toBeNull();
    expect(stale!.kind).toBe("WorkingDirectory");
    expect(stale!.stalePath).toBe(goneDir);
  });

  test("POSITIVE CONTROL: a plist whose paths all exist is clean", () => {
    const node = join(dir, "node");
    const harper = join(dir, "harper.js");
    writeFileSync(node, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(harper, "// harper\n");
    writeFileSync(plistPath, plistWith({
      label: "svc",
      rootPath: dir,
      programArguments: [node, harper, "run", "."],
      workingDirectory: dir,
    }));
    expect(diagnoseLaunchdPlistPaths(plistPath)).toBeNull();
  });

  test("POSITIVE CONTROL: non-absolute ProgramArguments are arguments, not paths, and are never flagged", () => {
    const node = join(dir, "node");
    writeFileSync(node, "#!/bin/sh\n", { mode: 0o755 });
    // "run" and "." are Harper's own arguments — flagging them as missing files
    // would make every healthy install look broken.
    writeFileSync(plistPath, plistWith({
      label: "svc",
      rootPath: dir,
      programArguments: [node, "run", "."],
      workingDirectory: dir,
    }));
    expect(diagnoseLaunchdPlistPaths(plistPath)).toBeNull();
  });

  test("POSITIVE CONTROL: an unreadable or foreign plist is no evidence, not a failure", () => {
    expect(diagnoseLaunchdPlistPaths(join(dir, "does-not-exist.plist"))).toBeNull();
    // A hand-written plist using <key>Program</key> rather than
    // ProgramArguments is not ours to judge.
    writeFileSync(plistPath, "<plist><dict><key>Program</key><string>/nope</string></dict></plist>");
    expect(diagnoseLaunchdPlistPaths(plistPath)).toBeNull();
  });

  test("never returns plist CONTENT — only the extracted paths", () => {
    // The plist embeds HDB_ADMIN_PASSWORD; a diagnosis that echoed the document
    // would put it in an operator's terminal and in every captured log.
    const gone = join(dir, "gone", "node");
    writeFileSync(plistPath, plistWith({ label: "svc", rootPath: dir, programArguments: [gone] })
      .replace("<key>ROOTPATH</key>", "<key>HDB_ADMIN_PASSWORD</key><string>hunter2-not-a-real-secret</string><key>ROOTPATH</key>"));
    const stale = diagnoseLaunchdPlistPaths(plistPath)!;
    expect(stale.message).not.toContain("hunter2-not-a-real-secret");
    expect(JSON.stringify(readPlistProgramRefs(plistPath))).not.toContain("hunter2-not-a-real-secret");
  });
});

describe("flair#1022 — renderVerifiedSummary is the reported defect, reduced to a function", () => {
  const detached = {
    state: "detached" as const,
    label: "ai.tpsdev.flair.deadbeef",
    detail: "the launchd job is loaded but not running.",
    remedy: ["flair init", "flair restart"],
  };

  test("THE INCIDENT LINE: a detached run does not emit `✅ verified: ...`", () => {
    const s = renderVerifiedSummary("0.33.0", detached);
    expect(s.degraded).toBe(true);
    const text = s.lines.join("\n");
    // The literal string from the incident report must not be produced.
    expect(text).not.toContain("✅ verified: healthy, authenticated, running 0.33.0");
    expect(text).not.toContain("✅");
    // The facts are still reported — the upgrade DID land, and saying it did
    // not would swap one misleading summary for another.
    expect(text).toContain("healthy, authenticated, running 0.33.0");
    // ...alongside the thing that is actually wrong.
    expect(text).toContain("NOT running under launchd");
    expect(text).toContain("Fix: flair init && flair restart");
  });

  test("POSITIVE CONTROL: a managed run still reports exactly the success line it always did", () => {
    const s = renderVerifiedSummary("0.33.0", {
      state: "managed",
      label: "ai.tpsdev.flair.deadbeef",
      detail: "launchd job is running as process 4242",
    });
    expect(s.degraded).toBe(false);
    expect(s.lines).toEqual(["✅ verified: healthy, authenticated, running 0.33.0"]);
  });

  test("POSITIVE CONTROL: Linux and unregistered-service runs are unchanged too", () => {
    for (const m of [
      { state: "not-applicable" as const, detail: "linux does not use launchd" },
      { state: "no-service" as const, detail: "no launchd service is registered for this instance" },
    ]) {
      const s = renderVerifiedSummary("0.33.0", m);
      expect(s.degraded).toBe(false);
      expect(s.lines).toEqual(["✅ verified: healthy, authenticated, running 0.33.0"]);
    }
  });

  test("an unknown version is omitted rather than printed as null, on both paths", () => {
    expect(renderVerifiedSummary(null, { state: "managed", detail: "ok" }).lines)
      .toEqual(["✅ verified: healthy, authenticated"]);
    expect(renderVerifiedSummary(null, detached).lines.join("\n")).toContain("(healthy, authenticated)");
  });

  test("a degraded summary is never routed to stdout as a success", () => {
    // `degraded` is what selects stderr at the call site, so the two must not
    // disagree: a degraded:false result carrying a warning, or vice versa,
    // would put the warning on the success channel.
    const s = renderVerifiedSummary("0.33.0", detached);
    expect(s.degraded).toBe(true);
    expect(s.lines[0].startsWith("⚠️")).toBe(true);
  });
});

describe("flair#1022 — renderDetachedWarning", () => {
  test("leads with a non-success marker, names the cost, and ends with commands", () => {
    const lines = renderDetachedWarning(
      {
        state: "detached",
        label: "ai.tpsdev.flair.deadbeef",
        detail: "the launchd job is loaded but not running.",
        remedy: ["flair init", "flair restart"],
      },
      "upgrade landed but the instance is NOT running under launchd.",
    );
    const text = lines.join("\n");
    expect(text).not.toContain("✅");
    expect(lines[0]).toContain("⚠️");
    expect(text).toContain("will NOT come back after a reboot");
    expect(text).toContain("flair init");
    expect(text).toContain("flair restart");
  });
});

// ─── 3. end to end, through the real CLI ───────────────────────────────────

describe("flair#1022 — `flair restart` reports the launchd outcome, not just liveness", () => {
  let tmpHome: string;
  let shimBin: string;
  let dataDir: string;
  let launchAgentsDir: string;
  let launchctlLog: string;
  let listDir: string;
  let listCount: string;
  let label: string;
  let plistPath: string;
  const spawned: Array<{ pid: number; kill: (s?: number) => void }> = [];
  const probeDirs: string[] = [];

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flair1022-home-"));
    shimBin = mkdtempSync(join(tmpdir(), "flair1022-bin-"));
    launchAgentsDir = join(tmpHome, "Library", "LaunchAgents");
    mkdirSync(launchAgentsDir, { recursive: true });
    dataDir = join(tmpHome, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });

    launchctlLog = join(tmpHome, "launchctl-invocations.log");
    listDir = join(tmpHome, "launchctl-list-responses");
    mkdirSync(listDir, { recursive: true });
    listCount = join(tmpHome, "launchctl-list-count");

    label = launchdLabel(dataDir);
    plistPath = launchdPlistPath(label, launchAgentsDir);

    // The shim: records every invocation, answers `list` from numbered files
    // (so one run can be told "running" and then "not running", which is
    // exactly the sequence a restart that falls back produces), and exits 0
    // for load/unload/start the way real launchctl does.
    writeFileSync(
      join(shimBin, "launchctl"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"`,
        `if [ "$1" = "list" ]; then`,
        `  n=0`,
        `  if [ -f "$LAUNCHCTL_LIST_COUNT" ]; then n=$(cat "$LAUNCHCTL_LIST_COUNT"); fi`,
        `  n=$((n+1))`,
        `  printf '%s' "$n" > "$LAUNCHCTL_LIST_COUNT"`,
        `  f="$LAUNCHCTL_LIST_DIR/$n"`,
        `  if [ ! -f "$f" ]; then f="$LAUNCHCTL_LIST_DIR/default"; fi`,
        `  if [ -f "$f" ]; then cat "$f"; exit 0; fi`,
        `  printf 'Could not find service "%s"\\n' "$2" >&2`,
        `  exit 113`,
        `fi`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    // Only ever the stubs this file started, by recorded PID.
    for (const proc of spawned.splice(0)) {
      try { proc.kill(); } catch { /* already gone */ }
    }
    for (const dir of [tmpHome, shimBin, ...probeDirs.splice(0)]) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A copy of `src/` in a package directory that contains NO Harper, used to
   * make the direct-start fallback exit safely instead of launching a real
   * database.
   *
   * `harperSearchRoots()` is `[flairPackageDir(), process.cwd()]`, and
   * `flairPackageDir()` is derived from the running file's own directory — so
   * running the CLI from a copy re-points BOTH roots at a tree whose
   * `node_modules/harper/dist/bin/harper.js` does not exist, and
   * `resolveHarperBin` returns null. The copy lives INSIDE the repo so Bun
   * still resolves the CLI's own bare imports (commander, tweetnacl, …) by
   * walking up to the real node_modules; a copy under /tmp would not resolve
   * them, and a symlinked node_modules would put Harper back.
   *
   * Removed in afterEach. The `.` prefix and the fixed name keep a crashed run
   * from leaving something that looks like source.
   */
  function probePackage(): string {
    const dir = mkdtempSync(join(repoRoot, ".flair1022-probe-"));
    probeDirs.push(dir);
    cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });
    return dir;
  }

  async function runCli(args: string[], packageDir?: string) {
    const entry = packageDir ? join(packageDir, "src", "cli.ts") : cliPath;
    const proc = Bun.spawn(["bun", entry, ...args], {
      cwd: packageDir ?? repoRoot,
      env: {
        ...(process.env as Record<string, string>),
        HOME: tmpHome,
        PATH: `${shimBin}:${process.env.PATH ?? ""}`,
        LAUNCHCTL_LOG: launchctlLog,
        LAUNCHCTL_LIST_DIR: listDir,
        LAUNCHCTL_LIST_COUNT: listCount,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  /** A stand-in for "an instance is listening here", in its own process. */
  async function spawnHealthStub(): Promise<{ port: number; pid: number; alive: () => Promise<boolean> }> {
    const portFile = join(tmpHome, "stub-port");
    const script = join(tmpHome, "health-stub.mjs");
    writeFileSync(
      script,
      [
        `import { createServer } from "node:http";`,
        `import { writeFileSync } from "node:fs";`,
        `const srv = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok"}'); });`,
        `srv.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(srv.address().port)));`,
      ].join("\n"),
    );
    const proc = Bun.spawn(["bun", script, portFile], { stdout: "ignore", stderr: "ignore" });
    spawned.push(proc as any);
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
    if (!existsSync(portFile)) throw new Error("health stub did not report a port");
    const port = Number(readFileSync(portFile, "utf-8").trim());
    return {
      port,
      pid: proc.pid,
      alive: async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/Health`, { signal: AbortSignal.timeout(2000) })).ok;
        } catch { return false; }
      },
    };
  }

  /** A plist for this fixture's instance whose paths all exist. */
  function writeHealthyPlist(): void {
    const node = join(tmpHome, "node");
    const harper = join(tmpHome, "harper.js");
    writeFileSync(node, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(harper, "// harper\n");
    writeFileSync(plistPath, plistWith({
      label,
      rootPath: dataDir,
      programArguments: [node, harper, "run", "."],
      workingDirectory: tmpHome,
    }));
  }

  test.skipIf(!isDarwin)(
    "THE DEFECT: a restart that ends with the instance outside launchd does NOT report unqualified success",
    async () => {
      writeHealthyPlist();
      const stub = await spawnHealthStub();

      // The incident's sequence, one launchctl `list` call at a time:
      //   #1 (the stop leg)  — launchd's job is running, so the stop takes the
      //                        launchd path and the restart proceeds normally.
      //   #2 (the post-restart observation) — launchd's job is NOT running.
      //      Something else is answering on the port. That is precisely what a
      //      fallback to a direct start leaves behind.
      writeFileSync(join(listDir, "1"), listRunning(label, 4242));
      writeFileSync(join(listDir, "default"), listLoadedNotRunning(label));

      const { stdout, stderr, exitCode } = await runCli(["restart", "--port", String(stub.port)]);

      // The restart itself worked — the instance is up. This is not a failure
      // to restart, and must not be reported as one.
      expect(exitCode).toBe(0);

      // The headline assertion. On unmodified main this line IS printed, and
      // it is the entire bug.
      expect(stdout).not.toContain("✅ Flair restarted");

      // And the operator is told what is wrong, what it costs, and what to do.
      const warning = stderr;
      expect(warning).toContain("NOT running under launchd");
      expect(warning).toContain("will NOT come back after a reboot");
      expect(warning).toContain(label);
      expect(warning).toContain("flair restart");

      // Nothing was signalled: the stub this test started is still serving.
      expect(await stub.alive()).toBe(true);
    },
    30_000,
  );

  test.skipIf(!isDarwin)(
    "POSITIVE CONTROL: a clean restart, still managed by launchd, still reports success",
    async () => {
      writeHealthyPlist();
      const stub = await spawnHealthStub();

      // launchd reports the job running as the very process that is serving
      // the port — which is what "managed" means. The CLI resolves the serving
      // PID from the port (no hdb.pid in this fixture), so this is a real
      // comparison, not a rubber stamp.
      writeFileSync(join(listDir, "default"), listRunning(label, stub.pid));

      const { stdout, stderr, exitCode } = await runCli(["restart", "--port", String(stub.port)]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("✅ Flair restarted");
      // An over-corrected fix that warns on every run is its own defect.
      expect(stderr).not.toContain("NOT running under launchd");
      expect(stderr).not.toContain("will NOT come back after a reboot");
      expect(await stub.alive()).toBe(true);
    },
    30_000,
  );

  test.skipIf(!isDarwin)(
    "THE FIRST 60-SECOND WAIT: the stop leg does not wait on a process launchd is not running",
    async () => {
      // The incident's first hang: "launchd stop failed, falling back to
      // port-based stop: Process <pid> did not exit within 60000ms". The
      // unload had nothing to signal, because the process serving the instance
      // was not launchd's job — so the CLI waited a minute for an exit that was
      // never going to be caused by anything it did, and then reported the
      // wait, not the reason.
      //
      // Runs out of a Harper-free package tree so the eventual direct-start
      // fallback exits on resolveHarperBin rather than launching a database.
      const pkg = probePackage();
      const gone = join(tmpHome, "runtimes", "v22", "bin", "node");
      writeFileSync(plistPath, plistWith({
        label,
        rootPath: dataDir,
        programArguments: [gone, join(tmpHome, "harper.js"), "run", "."],
        workingDirectory: tmpHome,
      }));
      // A LIVE process is recorded as serving this instance...
      const stub = await spawnHealthStub();
      writeFileSync(join(dataDir, "hdb.pid"), String(stub.pid));
      // ...and launchd is running nothing. That combination is the whole
      // condition: the unload cannot stop what launchd does not own.
      writeFileSync(join(listDir, "default"), listLoadedNotRunning(label));

      const started = Date.now();
      const { stderr, exitCode } = await runCli(["restart", "--port", String(stub.port)], pkg);
      const elapsedMs = Date.now() - started;

      // The stop fell back — as it should — but for a REASON, immediately.
      expect(stderr).toContain("launchd stop failed, falling back to port-based stop");
      expect(stderr).not.toContain("did not exit within");
      expect(stderr).toContain("not running this instance");
      // And the cause of the whole mess is named, with the fix.
      expect(stderr).toContain(gone);
      expect(stderr).toContain("Fix it with: flair init && flair restart");

      // Both of the incident's 60-second waits are gone from this one run:
      // the stop no longer waits on a foreign process, and the start no longer
      // polls a port for a job that cannot be exec'd.
      expect(elapsedMs).toBeLessThan(20_000);

      // The fallback stop did its job — the listener was signalled. This is
      // the ONE test here that expects the stub to be stopped, because the CLI
      // was correctly asked to stop the instance the stub stands in for.
      expect(await stub.alive()).toBe(false);

      // The run ends in failure because the probe tree has no Harper to start,
      // which is what keeps a real database from being launched here.
      expect(exitCode).toBe(1);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "THE 60-SECOND WAIT: a stale plist aborts the launchd start immediately, naming the path and the fix",
    async () => {
      // The start leg is the half that produced
      // "Harper at port 19926 did not respond within 60000ms (120 attempts)" —
      // 120 polls against a port launchd was never going to open, because
      // launchctl load/start report success for a job they cannot exec.
      //
      // Reaching this leg means the CLI will fall back to a DIRECT start, and
      // a direct start spawns a real Harper — unacceptable from a unit test.
      // So the CLI is run out of a package tree with no Harper in it
      // (`probePackage` below), which makes the fallback exit on
      // resolveHarperBin instead of launching a database. The launchd path
      // under test is completely unaffected by that; it is only what happens
      // AFTER it gives up that changes.
      const pkg = probePackage();
      const gone = join(tmpHome, "runtimes", "v22", "bin", "node");
      writeFileSync(plistPath, plistWith({
        label,
        rootPath: dataDir,
        programArguments: [gone, join(tmpHome, "harper.js"), "run", "."],
        workingDirectory: tmpHome,
      }));
      // launchd's job is running, so the STOP leg completes cleanly and the
      // run reaches the start leg — which is the leg under test.
      writeFileSync(join(listDir, "default"), listRunning(label, 4242));

      const started = Date.now();
      const { stderr, exitCode } = await runCli(["restart", "--port", "59997"], pkg);
      const elapsedMs = Date.now() - started;

      expect(exitCode).toBe(1);
      // Named cause, named fix — the whole difference from a bare timeout.
      expect(stderr).toContain("launchd start failed");
      expect(stderr).toContain(gone);
      expect(stderr).toContain("Fix it with: flair init && flair restart");

      // The pre-flight ran BEFORE launchd was asked to do anything, so no load
      // and no start was issued for a job that cannot run.
      // Matched per line on the VERB, not as a substring: `unload <plist>`
      // contains `load <plist>`, so a substring check here passes for the
      // wrong reason and would keep passing if the pre-flight were removed.
      const verbs = readFileSync(launchctlLog, "utf-8")
        .split("\n").map((l) => l.trim()).filter(Boolean)
        .map((l) => l.split(/\s+/)[0]);
      expect(verbs).not.toContain("load");
      expect(verbs).not.toContain("start");
      // Positive control on that parse: the stop leg's unload DID happen, so
      // an empty or mis-parsed log cannot make the two assertions above pass
      // vacuously.
      expect(verbs).toContain("unload");

      // And the point of all of it: the operator is not left staring at a
      // frozen terminal. STARTUP_TIMEOUT_MS is 60s and the old path burned all
      // of it here; 20s is a generous ceiling that still fails loudly if the
      // wait ever comes back.
      expect(elapsedMs).toBeLessThan(20_000);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "every launchctl invocation names this fixture's instance — never a real install",
    async () => {
      writeHealthyPlist();
      const stub = await spawnHealthStub();
      writeFileSync(join(listDir, "default"), listRunning(label, stub.pid));
      await runCli(["restart", "--port", String(stub.port)]);

      const lines = readFileSync(launchctlLog, "utf-8")
        .split("\n").map((l) => l.trim()).filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      // Same property test/unit/snapshot-datadir-instance-targeting.test.ts
      // pins, re-asserted here because this file adds new launchctl traffic
      // (`list`) to the same code paths.
      expect(lines.filter((l) => !l.includes(label))).toEqual([]);
      const plistArgs = lines.flatMap((l) => l.split(/\s+/).filter((a) => a.endsWith(".plist")));
      expect(plistArgs.filter((a) => a !== plistPath)).toEqual([]);
    },
    30_000,
  );
});
