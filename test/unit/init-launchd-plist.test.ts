/**
 * init-launchd-plist.test.ts — the `flair init` launchd-plist writer
 * (flair#1693, closing the other half of flair#1685).
 *
 * The incident: an accidental `flair init` against an already-adopted instance
 * (`doctor --fix` had registered the flair#1573 pass-file launcher) REWROTE the
 * plist to the pre-#1573 inline shape — `ProgramArguments = [node, harper.js,
 * run, .]` plus `HDB_ADMIN_PASSWORD` in `EnvironmentVariables` — downgrading the
 * adoption and writing the admin password into a config file. The running job
 * was unaffected (launchd keeps the loaded definition), so nothing surfaced
 * until the next reload/reboot.
 *
 * `writeInitLaunchdPlist` is the fix: init no longer has an inline branch to
 * write (there is no inline branch left — `buildLaunchdPlist` requires a
 * `passFile`), and it resolves the credential BEFORE touching the plist:
 *
 *   1. an already-adopted (`ours`, pass-file shape) plist is left byte-identical;
 *   2. a foreign/unattributable plist is refused;
 *   3. otherwise reuse an existing valid 0600 file, or prove the in-hand
 *      credential against the live instance and write it, or refuse with no plist.
 *
 * SAFETY: everything here targets a temp dir. No real `~/.flair`, no
 * `~/Library/LaunchAgents`, no launchctl, no network (the proof is injected).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLaunchdPlist,
  launchdLauncherPath,
  writeInitLaunchdPlist,
  type LaunchdPlistOptions,
  type WriteInitLaunchdPlistOptions,
} from "../../src/cli.ts";

let tmp: string;
let savedFlairPass: string | undefined;
let savedHdbPass: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "flair-init-plist-"));
  // The writer falls back to env credentials; a developer's shell must not
  // decide the outcome of the "no credential" case.
  savedFlairPass = process.env.FLAIR_ADMIN_PASS;
  savedHdbPass = process.env.HDB_ADMIN_PASSWORD;
  delete process.env.FLAIR_ADMIN_PASS;
  delete process.env.HDB_ADMIN_PASSWORD;
});

afterEach(() => {
  if (savedFlairPass === undefined) delete process.env.FLAIR_ADMIN_PASS;
  else process.env.FLAIR_ADMIN_PASS = savedFlairPass;
  if (savedHdbPass === undefined) delete process.env.HDB_ADMIN_PASSWORD;
  else process.env.HDB_ADMIN_PASSWORD = savedHdbPass;
  rmSync(tmp, { recursive: true, force: true });
});

const DATA_DIR = "/Users/example/.flair/data";

function plistFor(dataDir: string, over: Partial<LaunchdPlistOptions> = {}): string {
  return buildLaunchdPlist({
    label: "ai.tpsdev.flair.deadbeef",
    execPath: "/usr/local/bin/node",
    harperBinPath: "/opt/flair/harper.js",
    workingDirectory: "/opt/flair",
    dataDir,
    modelsDir: `${dataDir}/models`,
    setConfig: JSON.stringify({ rootPath: dataDir, http: { port: 9926 } }),
    adminUser: "admin",
    httpPort: 9926,
    opsNetworkPort: "9925",
    passFile: {
      launcher: launchdLauncherPath(),
      adminPassFile: "/Users/example/.flair/admin-pass",
      home: "/Users/example",
      path: "/usr/bin:/bin",
    },
    ...over,
  });
}

function baseOptions(over: Partial<WriteInitLaunchdPlistOptions> = {}): WriteInitLaunchdPlistOptions {
  return {
    dataDir: DATA_DIR,
    plistPath: join(tmp, "ai.tpsdev.flair.deadbeef.plist"),
    label: "ai.tpsdev.flair.deadbeef",
    adminPass: "",
    adminUser: "admin",
    modelsDir: `${DATA_DIR}/models`,
    execPath: "/usr/local/bin/node",
    harperBinPath: "/opt/flair/harper.js",
    workingDirectory: "/opt/flair",
    httpPort: 9926,
    opsNetworkPort: "9925",
    setConfig: JSON.stringify({ rootPath: DATA_DIR, http: { port: 9926 } }),
    port: 9926,
    adminPassPath: join(tmp, "admin-pass"),
    liveInstance: false,
    ...over,
  };
}

function writePassFile(path: string, value: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

describe("writeInitLaunchdPlist — already adopted (#1693)", () => {
  test("leaves a pass-file plist byte-identical and writes no password key", async () => {
    const opts = baseOptions();
    const before = plistFor(DATA_DIR);
    writeFileSync(opts.plistPath, before);
    writePassFile(opts.adminPassPath!, "PLACEHOLDER-existing-pass");

    const result = await writeInitLaunchdPlist(opts);

    expect(result.kind).toBe("unchanged");
    const after = readFileSync(opts.plistPath, "utf-8");
    expect(after, "an adopted plist must not be rewritten").toBe(before);
    expect(after).not.toContain("HDB_ADMIN_PASSWORD");
  });

  test("does not need a credential to leave an adopted plist alone", async () => {
    // The adopted no-op must short-circuit BEFORE the credential gate: an
    // adopted instance with a missing pass file still must not be downgraded.
    const opts = baseOptions();
    writeFileSync(opts.plistPath, plistFor(DATA_DIR));
    expect(existsSync(opts.adminPassPath!)).toBe(false);

    const result = await writeInitLaunchdPlist(opts);
    expect(result.kind).toBe("unchanged");
  });
});

describe("writeInitLaunchdPlist — refusal with no credential and no file", () => {
  test("refuses, names the pass file and 'flair init', and writes no plist", async () => {
    const opts = baseOptions();
    expect(existsSync(opts.plistPath)).toBe(false);

    const result = await writeInitLaunchdPlist(opts);

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.detail).toContain(opts.adminPassPath!);
      expect(result.detail).toMatch(/flair init/);
    }
    expect(existsSync(opts.plistPath), "a refusal must not leave a plist").toBe(false);
    expect(existsSync(opts.adminPassPath!), "a refusal must not create a pass file").toBe(false);
  });
});

describe("writeInitLaunchdPlist — fresh install writes only the pass-file shape", () => {
  test("proves the in-hand credential, writes it 0600, and emits no inline password", async () => {
    const opts = baseOptions({ adminPass: "PLACEHOLDER-in-hand-pass", liveInstance: true });
    let proved = 0;

    const result = await writeInitLaunchdPlist(opts, {
      prove: async (port, credential) => {
        proved += 1;
        expect(port).toBe(9926);
        expect(credential).toBe("PLACEHOLDER-in-hand-pass");
        return null;
      },
    });

    expect(result.kind).toBe("written");
    expect(proved).toBe(1);
    expect(existsSync(opts.adminPassPath!)).toBe(true);
    expect(statSync(opts.adminPassPath!).mode & 0o777).toBe(0o600);
    const raw = readFileSync(opts.plistPath, "utf-8");
    expect(raw).toContain("start-flair-with-admin-pass.sh");
    expect(raw).not.toContain("HDB_ADMIN_PASSWORD");
    expect(raw).not.toContain("<string>run</string>");
  });

  test("refuses when the in-hand credential does not prove against the instance", async () => {
    const opts = baseOptions({ adminPass: "PLACEHOLDER-wrong-pass", liveInstance: true });

    const result = await writeInitLaunchdPlist(opts, {
      prove: async () => "HTTP 401 Login failed",
    });

    expect(result.kind).toBe("refused");
    expect(existsSync(opts.plistPath)).toBe(false);
    expect(existsSync(opts.adminPassPath!)).toBe(false);
  });

  test("reuses an existing valid pass file without re-proving or rewriting it", async () => {
    const opts = baseOptions({ adminPass: "PLACEHOLDER-in-hand-pass", liveInstance: true });
    writePassFile(opts.adminPassPath!, "PLACEHOLDER-existing-pass");
    const before = readFileSync(opts.adminPassPath!, "utf-8");

    const result = await writeInitLaunchdPlist(opts, {
      prove: async () => {
        throw new Error("an existing valid file must not need proving");
      },
    });

    expect(result.kind).toBe("written");
    expect(readFileSync(opts.adminPassPath!, "utf-8")).toBe(before);
    expect(readFileSync(opts.plistPath, "utf-8")).not.toContain("HDB_ADMIN_PASSWORD");
  });
});

describe("writeInitLaunchdPlist — ownership guard", () => {
  test("refuses a plist registered to a different data dir, naming doctor --fix", async () => {
    const opts = baseOptions();
    writeFileSync(opts.plistPath, plistFor("/Users/example/other/data"));

    const result = await writeInitLaunchdPlist(opts);

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.detail).toMatch(/flair doctor --fix/);
  });
});
