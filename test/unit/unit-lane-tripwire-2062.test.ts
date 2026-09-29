/**
 * flair#2062 — the unit lane's service-manager tripwire fails closed.
 *
 * `scripts/test-unit.ts` runs every step with a `launchctl`/`systemctl` shim
 * FIRST on PATH. A unit test that reaches a host service manager without its
 * own fake must fail the lane with a named message; a test that supplies its
 * own fake must still pass. These tests drive the real runner (`runUnitSteps`)
 * with fixture steps, so each assertion is about the lane's own behaviour, not
 * a re-implementation of it.
 *
 * A tripwire that can be reached without the check noticing is worse than none:
 * it reads as proof. The cases below pin each way it could go quiet — a step
 * that swallows the failure, a no-argument call, an unreadable log.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installServiceManagerTripwire,
  SERVICE_MANAGER_TRIPWIRE_EVENT,
  serviceManagerTripwireMessage,
} from "../helpers/fake-launchctl.ts";
import { runUnitSteps } from "../../scripts/test-unit.ts";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-unit-tripwire-"));
  fixtures.push(dir);
  return dir;
}

/** Run `body` with console.error captured, returning its result and the stderr text. */
function captureErrors<T>(body: () => T): { result: T; errors: string } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    return { result: body(), errors: errors.join("\n") };
  } finally {
    console.error = original;
  }
}

/**
 * A `node -e` body that invokes `launchctl` with `args` and SWALLOWS the
 * failure, then exits 0. The failure it swallows is the point: the step itself
 * succeeds, so only the tripwire can fail the lane.
 */
function swallowLaunchctl(args: string[]): string {
  return `try { require("node:child_process").execFileSync("launchctl", ${JSON.stringify(args)}, { stdio: "pipe" }); } catch {}`;
}

describe("flair#2062 — the unit lane fails a step that reaches a host service manager", () => {
  test("a step invoking launchctl with no fake fails the lane and names the call", () => {
    const dir = fixture();
    const { result: code, errors } = captureErrors(() => runUnitSteps(
      [{ name: "reaches launchctl", cwd: dir, args: ["-e", swallowLaunchctl(["list", "ai.example"])], files: [] }],
      process.execPath,
      dir,
    ));
    // The step exits 0 (it swallowed the failure); only the tripwire fails it.
    expect(code).toBe(1);
    expect(errors).toContain("reaches launchctl");
    expect(errors).toContain("reached the host service manager without its own fake");
    // The logged call, literally: the event, the binary, argc, and argv.
    expect(errors).toContain(`${SERVICE_MANAGER_TRIPWIRE_EVENT} launchctl argc=2 argv=list ai.example`);
  });

  test("a no-argument invocation is logged and fails", () => {
    const dir = fixture();
    const { result: code, errors } = captureErrors(() => runUnitSteps(
      [{ name: "reaches launchctl with no arguments", cwd: dir, args: ["-e", swallowLaunchctl([])], files: [] }],
      process.execPath,
      dir,
    ));
    expect(code).toBe(1);
    // A call with no arguments still leaves a NONEMPTY line (argv is empty).
    expect(errors).toContain(`${SERVICE_MANAGER_TRIPWIRE_EVENT} launchctl argc=0 argv=`);
  });

  test("a step invoking systemctl with no fake fails the lane and names the call", () => {
    const dir = fixture();
    const script = `try { require("node:child_process").execFileSync("systemctl", ["--user", "restart", "flair"], { stdio: "pipe" }); } catch {}`;
    const { result: code, errors } = captureErrors(() => runUnitSteps(
      [{ name: "reaches systemctl", cwd: dir, args: ["-e", script], files: [] }],
      process.execPath,
      dir,
    ));
    expect(code).toBe(1);
    expect(errors).toContain(`${SERVICE_MANAGER_TRIPWIRE_EVENT} systemctl argc=3 argv=--user restart flair`);
  });

  test("a step whose own fake comes first does not trip", () => {
    const dir = fixture();
    const fakeDir = fixture();
    writeFileSync(join(fakeDir, "launchctl"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fakeDir, "launchctl"), 0o755);
    // The step spawns its child with its fake FIRST on that child's PATH,
    // which puts the fake ahead of the lane's tripwire (explicit env, the way
    // the command-level launchd tests lay their shim on a child's PATH).
    const script = [
      `const cp = require("node:child_process");`,
      `cp.execFileSync("launchctl", ["list"], { stdio: "pipe", env: { ...process.env, PATH: ${JSON.stringify(`${fakeDir}:`)} + process.env.PATH } });`,
    ].join("");
    const tripwire = installServiceManagerTripwire();
    try {
      const code = runUnitSteps(
        [{ name: "uses its own fake", cwd: dir, args: ["-e", script], files: [] }],
        process.execPath,
        dir,
        { tripwire },
      );
      expect(code).toBe(0);
      expect(tripwire.tripped()).toEqual([]);
    } finally {
      tripwire.cleanup();
    }
  });

  test("an unreadable tripwire log fails the lane and is never read as no calls", () => {
    const dir = fixture();
    const tripwire = installServiceManagerTripwire();
    // A log that is a directory cannot be read: a broken harness, not "no calls".
    rmSync(tripwire.logPath);
    mkdirSync(tripwire.logPath);
    try {
      const { result: code, errors } = captureErrors(() => runUnitSteps(
        [{ name: "a passing step", cwd: dir, args: ["-e", "process.exit(0)"], files: [] }],
        process.execPath,
        dir,
        { tripwire },
      ));
      expect(code).toBe(1);
      expect(errors).toContain("the service-manager tripwire log cannot be read or cannot record calls");
    } finally {
      tripwire.cleanup();
    }
  });

  test("the tripwire shim prints its named message and exits non-zero, for each binary", () => {
    const tripwire = installServiceManagerTripwire();
    try {
      for (const name of ["launchctl", "systemctl"] as const) {
        const res = spawnSync(tripwire.binPaths[name], ["--user", "restart"], { encoding: "utf-8", timeout: 10_000 });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain(serviceManagerTripwireMessage(name));
      }
      // Both calls share one log, each line naming its binary.
      expect(tripwire.tripped()).toEqual([
        `${SERVICE_MANAGER_TRIPWIRE_EVENT} launchctl argc=2 argv=--user restart`,
        `${SERVICE_MANAGER_TRIPWIRE_EVENT} systemctl argc=2 argv=--user restart`,
      ]);
    } finally {
      tripwire.cleanup();
    }
  });

  test(
    "a tripwire log that discards writes fails the lane even when the step swallows the exit (flair#2064)",
    () => {
      const dir = fixture();
      const tripwire = installServiceManagerTripwire();
      // Replace the tripwire log with a symlink to /dev/null: readable, but it
      // discards every append, so a swallowed call would otherwise read as clear.
      rmSync(tripwire.logPath);
      symlinkSync("/dev/null", tripwire.logPath);
      try {
        const { result: code, errors } = captureErrors(() => runUnitSteps(
          [{ name: "swallows the tripwire", cwd: dir, args: ["-e", swallowLaunchctl(["list"])], files: [] }],
          process.execPath,
          dir,
          { tripwire },
        ));
        // The step exits 0 (it swallowed the non-zero exit); only the log check fails it.
        expect(code).toBe(1);
        expect(errors).toContain("swallows the tripwire");
        expect(errors).toContain("tripwire log cannot record calls");
      } finally {
        tripwire.cleanup();
      }
    },
  );
});
