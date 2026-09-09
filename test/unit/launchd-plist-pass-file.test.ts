/**
 * launchd-plist-pass-file.test.ts — the secret-free / pass-file mode of
 * buildLaunchdPlist (flair#1573 slice a).
 *
 * The inline plist embeds HDB_ADMIN_PASSWORD as a <string>; a pass-file plist
 * must NOT. Instead its ProgramArguments point at the product launcher, which
 * reads the password from a 0600 file at start time. This file pins the four
 * secret assertions the adjudication made hard requirements:
 *
 *   1. no inline secret — `grep HDB_ADMIN_PASSWORD` on a pass-file plist fails;
 *   2. ProgramArguments point at the launcher, which reads a 0600 file;
 *   3. the plist is written ATOMICALLY (temp in the same dir -> rename);
 *   4. the admin-pass file is 0600.
 *
 * SAFETY: buildLaunchdPlist() is a pure function and the write helpers target
 * a temp dir — nothing here touches ~/Library/LaunchAgents, runs launchctl, or
 * reads a real plist. Fixtures use placeholder credentials only.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildLaunchdPlist,
  writeFileAtomic,
  writeAdminPassFile,
  launchdLauncherPath,
  type LaunchdPlistOptions,
} from "../../src/cli.ts";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "flair-pass-file-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** Placeholder values only — never a real credential. */
function opts(over: Partial<LaunchdPlistOptions> = {}): LaunchdPlistOptions {
  return {
    label: "ai.tpsdev.flair.deadbeef",
    execPath: "/usr/local/bin/node",
    harperBinPath: "/opt/flair/harper.js",
    workingDirectory: "/opt/flair",
    dataDir: "/Users/example/.flair/data",
    modelsDir: "/Users/example/.flair/data/models",
    setConfig: JSON.stringify({ rootPath: "/Users/example/.flair/data", http: { port: 9926 } }),
    adminUser: "admin",
    adminPass: "PLACEHOLDER-not-a-real-password",
    httpPort: 9926,
    opsNetworkPort: "9925",
    ...over,
  };
}

function passFileOpts(over: Partial<LaunchdPlistOptions> = {}): LaunchdPlistOptions {
  return opts({
    passFile: {
      launcher: "/opt/flair/templates/launchd/start-flair-with-admin-pass.sh",
      adminPassFile: "/Users/example/.flair/admin-pass",
      home: "/Users/example",
      path: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    },
    ...over,
  });
}

/** Parse a plist with Python's stdlib plistlib (raises on a malformed document). */
function parsePlist(plistText: string): any {
  const path = join(tmp, "probe.plist");
  writeFileSync(path, plistText);
  const dump = "import plistlib,json,sys;json.dump(plistlib.load(open(sys.argv[1],'rb')),sys.stdout)";
  const json = execFileSync("python3", ["-c", dump, path], { encoding: "utf-8", stdio: "pipe" });
  return JSON.parse(json);
}

describe("buildLaunchdPlist — pass-file mode", () => {
  test("does NOT embed HDB_ADMIN_PASSWORD inline (grep must fail)", () => {
    const plist = buildLaunchdPlist(passFileOpts());
    expect(plist).not.toContain("HDB_ADMIN_PASSWORD");
    // The literal grep the adjudication named, against the on-disk bytes.
    const path = join(tmp, "pass-file.plist");
    writeFileSync(path, plist);
    const bytes = readFileSync(path, "utf-8");
    expect(bytes).not.toMatch(/HDB_ADMIN_PASSWORD/);
  });

  test("ProgramArguments point at the launcher, then the 0600 admin-pass file, then node + harper", () => {
    const plist = buildLaunchdPlist(passFileOpts());
    const parsed = parsePlist(plist);
    expect(parsed.ProgramArguments).toEqual([
      "/opt/flair/templates/launchd/start-flair-with-admin-pass.sh",
      "/Users/example/.flair/admin-pass",
      "/usr/local/bin/node",
      "/opt/flair/harper.js",
    ]);
  });

  test("keeps HDB_ADMIN_USERNAME (not a secret) and adds HOME + PATH", () => {
    const parsed = parsePlist(buildLaunchdPlist(passFileOpts()));
    expect(parsed.EnvironmentVariables.HDB_ADMIN_USERNAME).toBe("admin");
    expect(parsed.EnvironmentVariables.HOME).toBe("/Users/example");
    expect(parsed.EnvironmentVariables.PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    expect(parsed.EnvironmentVariables.HDB_ADMIN_PASSWORD).toBeUndefined();
  });

  test("still escapes the launcher and admin-pass-file paths", () => {
    const hostile = `a&b<c>d"e'f`;
    const plist = buildLaunchdPlist(passFileOpts({
      passFile: {
        launcher: `/opt/${hostile}/launcher.sh`,
        adminPassFile: `/Users/${hostile}/admin-pass`,
        home: `/Users/${hostile}`,
        path: `/bin:${hostile}`,
      },
    }));
    const parsed = parsePlist(plist);
    expect(parsed.ProgramArguments[0]).toBe(`/opt/${hostile}/launcher.sh`);
    expect(parsed.ProgramArguments[1]).toBe(`/Users/${hostile}/admin-pass`);
    expect(parsed.EnvironmentVariables.HOME).toBe(`/Users/${hostile}`);
  });

  test("inline mode is unchanged: still embeds HDB_ADMIN_PASSWORD", () => {
    const plist = buildLaunchdPlist(opts());
    expect(plist).toContain("HDB_ADMIN_PASSWORD");
    const parsed = parsePlist(plist);
    expect(parsed.ProgramArguments).toEqual([
      "/usr/local/bin/node",
      "/opt/flair/harper.js",
      "run",
      ".",
    ]);
    expect(parsed.EnvironmentVariables.HDB_ADMIN_PASSWORD).toBe("PLACEHOLDER-not-a-real-password");
  });
});

describe("writeFileAtomic", () => {
  test("writes the content and leaves no temp file behind", () => {
    const path = join(tmp, "sub", "target.plist");
    writeFileAtomic(path, "hello", 0o644);
    expect(readFileSync(path, "utf-8")).toBe("hello");
    // No `.target.plist.*.tmp` sibling survives the rename.
    const leftovers = readdirSync(join(tmp, "sub")).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("applies the requested mode to the final file", () => {
    const path = join(tmp, "secret.txt");
    writeFileAtomic(path, "s3cret", 0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("overwrites an existing file atomically", () => {
    const path = join(tmp, "target.plist");
    writeFileSync(path, "old");
    writeFileAtomic(path, "new", 0o644);
    expect(readFileSync(path, "utf-8")).toBe("new");
  });
});

describe("writeAdminPassFile", () => {
  test("writes the admin-pass file with mode 0600", () => {
    const path = join(tmp, "admin-pass");
    writeAdminPassFile(path, "PLACEHOLDER-password\n");
    expect(readFileSync(path, "utf-8")).toBe("PLACEHOLDER-password\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("launchdLauncherPath", () => {
  test("resolves to templates/launchd/start-flair-with-admin-pass.sh under the package root", () => {
    expect(launchdLauncherPath("/opt/flair")).toBe(
      "/opt/flair/templates/launchd/start-flair-with-admin-pass.sh",
    );
  });
});

describe("launcher script — non-interactive start", () => {
  const LAUNCHER = join(import.meta.dir, "../../templates/launchd/start-flair-with-admin-pass.sh");

  test("reads the 0600 admin-pass file, injects HDB_ADMIN_PASSWORD, and execs node run .", () => {
    // A fake `node` that reports the env it was exec'd with and its argv.
    const fakeNode = join(tmp, "fake-node");
    writeFileSync(fakeNode, "#!/bin/sh\necho \"PASS=$HDB_ADMIN_PASSWORD\"\necho \"ARGS=$*\"\n");
    chmodSync(fakeNode, 0o755);

    const adminPassFile = join(tmp, "admin-pass");
    writeFileSync(adminPassFile, "PLACEHOLDER-password\n");
    chmodSync(adminPassFile, 0o600);

    const out = execFileSync("sh", [LAUNCHER, adminPassFile, fakeNode, "/opt/flair/harper.js"], {
      encoding: "utf-8",
    });
    expect(out).toContain("PASS=PLACEHOLDER-password");
    expect(out).toContain("ARGS=/opt/flair/harper.js run .");
  });

  test("fails loud when the admin-pass file is missing", () => {
    const fakeNode = join(tmp, "fake-node");
    writeFileSync(fakeNode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeNode, 0o755);
    expect(() =>
      execFileSync("sh", [LAUNCHER, join(tmp, "nope"), fakeNode, "/opt/flair/harper.js"], { stdio: "pipe" }),
    ).toThrow();
  });

  test("fails loud when the admin-pass file is empty", () => {
    const fakeNode = join(tmp, "fake-node");
    writeFileSync(fakeNode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeNode, 0o755);
    const empty = join(tmp, "empty");
    writeFileSync(empty, "");
    expect(() =>
      execFileSync("sh", [LAUNCHER, empty, fakeNode, "/opt/flair/harper.js"], { stdio: "pipe" }),
    ).toThrow();
  });
});
