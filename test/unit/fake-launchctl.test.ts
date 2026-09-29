/**
 * flair#2057 — the shared fake `launchctl` and its tripwire fail closed.
 *
 * A tripwire that can be reached without the check noticing is worse than none:
 * it reads as proof. These tests pin each way the check could go quiet — a
 * call with no arguments, a blank log line, an unreadable log, a probe that
 * something other than the fake answered, a fake that could not record.
 *
 * Every `launchctl` call in this file resolves from a PATH made ONLY of this
 * file's own shim directories, so none can reach the host binary.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  installFakeLaunchctl,
  installLaunchctlTripwire,
  LAUNCHCTL_TRIPWIRE_EVENT,
  LAUNCHCTL_TRIPWIRE_MESSAGE,
} from "../helpers/fake-launchctl.ts";
import { tempDir } from "../helpers/temp-dir.ts";

/** Run `launchctl` resolved from `path` alone, with no other environment. */
function launchctl(path: string, args: string[]) {
  return spawnSync("launchctl", args, { encoding: "utf-8", env: { PATH: path }, timeout: 10_000 });
}

describe("fake launchctl + tripwire (flair#2057)", () => {
  test("the fake records every call, a no-argument call included, with only PATH in its environment", () => {
    const fake = installFakeLaunchctl();
    expect(fake.invocations()).toEqual([]);
    expect(launchctl(fake.pathEntry, ["list", "ai.example"]).status).toBe(0);
    expect(launchctl(fake.pathEntry, []).status).toBe(0);
    expect(fake.invocations()).toEqual(["list ai.example", ""]);
    fake.assertClear();
  });

  test("a caught, no-argument call that reaches the tripwire fails the afterEach check", () => {
    const fake = installFakeLaunchctl();
    fake.assertClear();
    // The fake is missing from PATH and the caller swallows the failure, the
    // way init's legacy-plist cleanup catches a failed `launchctl unload`.
    let caught: unknown = null;
    try {
      execFileSync("launchctl", [], { env: { PATH: fake.tripwireDir }, stdio: "pipe", timeout: 10_000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // A nonempty event line, even though argv was empty.
    expect(fake.tripped()).toEqual([`${LAUNCHCTL_TRIPWIRE_EVENT} argc=0 argv=`]);
    // The exact check init-stale-harper-401.test.ts runs in its afterEach.
    expect(() => fake.assertClear()).toThrow(LAUNCHCTL_TRIPWIRE_MESSAGE);
  });

  test("a blank line in the tripwire log still counts as a call", () => {
    const tripwire = installLaunchctlTripwire();
    tripwire.assertClear();
    appendFileSync(tripwire.logPath, "\n");
    expect(tripwire.tripped()).toEqual([""]);
    expect(() => tripwire.assertClear()).toThrow(LAUNCHCTL_TRIPWIRE_MESSAGE);
  });

  test("a missing or unreadable log throws instead of reading as no calls", () => {
    const tripwire = installLaunchctlTripwire();
    rmSync(tripwire.logPath);
    expect(() => tripwire.tripped()).toThrow("cannot read");
    expect(() => tripwire.assertClear()).toThrow("cannot read");
    mkdirSync(tripwire.logPath);
    expect(() => tripwire.assertClear()).toThrow("cannot read");

    const fake = installFakeLaunchctl();
    rmSync(fake.logPath);
    expect(() => fake.invocations()).toThrow("cannot read");
  });

  test("assertShadowed fails when something other than the fake answers, even with exit 0", () => {
    const fake = installFakeLaunchctl();
    const impostor = tempDir("flair-launchctl-impostor-");
    writeFileSync(join(impostor, "launchctl"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(impostor, "launchctl"), 0o755);
    const path = `${impostor}:${fake.pathEntry}`;
    expect(launchctl(path, ["list"]).status).toBe(0);
    expect(() => fake.assertShadowed(path)).toThrow("did not reach the fake");
    // Neither the exit status nor the tripwire can see this case. The PATH
    // preflight refuses it before the probe is spawned: the first launchctl on
    // this PATH is not the fake.
    fake.assertClear();
    fake.assertShadowed(fake.pathEntry);
  });

  test("assertShadowed refuses a PATH whose first launchctl is not the fake WITHOUT running it", () => {
    const fake = installFakeLaunchctl();
    const hostLike = tempDir("flair-launchctl-hostlike-");
    const marker = join(hostLike, "ran");
    writeFileSync(join(hostLike, "launchctl"), `#!/bin/sh\n: > '${marker}'\nexit 0\n`);
    chmodSync(join(hostLike, "launchctl"), 0o755);
    expect(() => fake.assertShadowed(`${hostLike}:${fake.pathEntry}`)).toThrow("refusing to spawn it");
    // Independent oracle: the stand-in for a host binary leaves a file when it runs. It never ran.
    expect(existsSync(marker)).toBe(false);
    // A PATH with no launchctl at all is refused the same way.
    expect(() => fake.assertShadowed(hostLike + "-absent")).toThrow("the first launchctl on this PATH is none");
    fake.assertClear();
  });

  test("the fake exits non-zero when it cannot record a call, and assertShadowed fails", () => {
    const fake = installFakeLaunchctl();
    fake.assertShadowed(fake.pathEntry);
    rmSync(fake.logPath);
    mkdirSync(fake.logPath); // appending to a directory fails, even as root
    const res = launchctl(fake.pathEntry, ["list"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("could not record this call");
    expect(() => fake.assertShadowed(fake.pathEntry)).toThrow();
    fake.assertClear();
  });

  test("assertShadowed throws the named tripwire message when the fake is missing from PATH", () => {
    const fake = installFakeLaunchctl();
    expect(() => fake.assertShadowed(fake.tripwireDir)).toThrow(LAUNCHCTL_TRIPWIRE_MESSAGE);
    const tripped = fake.tripped();
    expect(tripped).toHaveLength(1);
    expect(tripped[0]).toStartWith(`${LAUNCHCTL_TRIPWIRE_EVENT} argc=1 argv=__flair_fake_launchctl_probe_`);
    expect(() => fake.assertClear()).toThrow(LAUNCHCTL_TRIPWIRE_MESSAGE);
  });
});

// ─── flair#2062/#2064 — a tripwire log that cannot record calls ───────────────
//
// A readable EMPTY log must not be read as clear: a symlink to /dev/null (a
// readable log that discards every append) or an unwritable log must FAIL the
// check with a named message, so a test that swallows the tripwire's non-zero
// exit cannot leave the lane green.

describe("flair#2062/#2064 — the tripwire log must prove it can record calls", () => {
  test("a log replaced by a symlink to /dev/null is refused, not read as empty", () => {
    const tripwire = installLaunchctlTripwire();
    rmSync(tripwire.logPath);
    symlinkSync("/dev/null", tripwire.logPath);
    expect(() => tripwire.assertClear()).toThrow(/replaced or symlinked/);
    expect(() => tripwire.assertClear()).toThrow("tripwire log cannot record calls");
    expect(() => tripwire.tripped()).toThrow("tripwire log cannot record calls");
    tripwire.cleanup();
  });

  test.skipIf(process.getuid?.() === 0)(
    "an unwritable log (still the original file) is refused by the canary round-trip, not read as empty",
    () => {
      const tripwire = installLaunchctlTripwire();
      // Same inode (not replaced); the append fails, so the canary cannot round-trip.
      chmodSync(tripwire.logPath, 0o444);
      expect(() => tripwire.assertClear()).toThrow(/discards writes/);
      expect(() => tripwire.assertClear()).toThrow("tripwire log cannot record calls");
      tripwire.cleanup();
    },
  );

  test("a clear log still passes the canary round-trip and stays empty", () => {
    const tripwire = installLaunchctlTripwire();
    expect(() => tripwire.assertClear()).not.toThrow();
    // The canary was truncated back to empty; a following read is still clear.
    expect(tripwire.tripped()).toEqual([]);
    tripwire.cleanup();
  });
});
