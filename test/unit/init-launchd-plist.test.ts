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
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLaunchdPlist,
  registerInitLaunchdService,
  setLaunchdMigrationLintForTests,
  writeInitLaunchdPlist,
  type LaunchdPlistOptions,
  type WriteInitLaunchdPlistOptions,
} from "../../src/cli.ts";
import { resolveHome } from "../../src/lib/home.ts";

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
/** A tree that does not exist on disk: the adopted-plist fixtures below serve it. */
const TREE = "/opt/flair";
const TREE_HARPER = `${TREE}/node_modules/harper/dist/bin/harper.js`;
const TREE_LAUNCHER = `${TREE}/templates/launchd/start-flair-with-admin-pass.sh`;

function plistFor(dataDir: string, over: Partial<LaunchdPlistOptions> = {}): string {
  return buildLaunchdPlist({
    label: "ai.tpsdev.flair.deadbeef",
    execPath: "/usr/local/bin/node",
    harperBinPath: TREE_HARPER,
    workingDirectory: TREE,
    dataDir,
    modelsDir: `${dataDir}/models`,
    setConfig: JSON.stringify({ rootPath: dataDir, http: { port: 9926 } }),
    adminUser: "admin",
    httpPort: 9926,
    opsNetworkPort: "9925",
    // This instance's own plist: this user's HOME and this instance's pass file.
    passFile: {
      launcher: TREE_LAUNCHER,
      adminPassFile: join(tmp, "admin-pass"),
      home: resolveHome(),
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
    harperBinPath: TREE_HARPER,
    workingDirectory: TREE,
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

describe("writeInitLaunchdPlist — re-points an adopted plist at this CLI's tree (#2034)", () => {
  /** An npm-global runtime prefix with a flair tree (+ Harper entry) and a node binary. */
  function runtimeTree(prefix: string, version: string): { tree: string; node: string; harper: string } {
    const tree = join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair");
    const harper = join(tree, "node_modules", "harper", "dist", "bin", "harper.js");
    mkdirSync(join(harper, ".."), { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version }));
    writeFileSync(harper, "// harper\n");
    mkdirSync(join(tree, "templates", "launchd"), { recursive: true });
    writeFileSync(join(tree, "templates", "launchd", "start-flair-with-admin-pass.sh"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(prefix, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
    return { tree, node: join(prefix, "bin", "node"), harper };
  }

  test("an adopted pass-file plist serving an OLD npm-global tree is re-pointed — runtime paths only", async () => {
    const old = runtimeTree(join(tmp, "node", "24.18.0"), "0.57.0");
    const cur = runtimeTree(join(tmp, "node", "24.19.0"), "0.57.0");
    const opts = baseOptions({ execPath: cur.node, harperBinPath: cur.harper, workingDirectory: cur.tree });
    const before = plistFor(DATA_DIR, {
      execPath: old.node,
      harperBinPath: old.harper,
      workingDirectory: old.tree,
      passFile: {
        launcher: join(old.tree, "templates", "launchd", "start-flair-with-admin-pass.sh"),
        adminPassFile: opts.adminPassPath!,
        home: resolveHome(),
        path: "/custom/R&D/bin:/usr/bin:/bin",
      },
    });
    writeFileSync(opts.plistPath, before, { mode: 0o644 });
    // No pass file and no credential: re-pointing must not need one (#1693's rule).
    expect(existsSync(opts.adminPassPath!)).toBe(false);

    const result = await writeInitLaunchdPlist(opts);

    expect(result.kind).toBe("repointed");
    const after = readFileSync(opts.plistPath, "utf-8");
    const expected = plistFor(DATA_DIR, {
      execPath: cur.node,
      harperBinPath: cur.harper,
      workingDirectory: cur.tree,
      passFile: {
        launcher: join(cur.tree, "templates", "launchd", "start-flair-with-admin-pass.sh"),
        adminPassFile: opts.adminPassPath!,
        home: resolveHome(),
        path: "/custom/R&D/bin:/usr/bin:/bin",
      },
    });
    expect(after).toBe(expected);
    expect(after).toContain("/custom/R&amp;D/bin");
    expect(after).not.toContain("HDB_ADMIN_PASSWORD");
    expect(statSync(opts.plistPath).mode & 0o777).toBe(0o644);
    expect(existsSync(opts.adminPassPath!)).toBe(false);

    // Idempotent: the next init leaves it byte-identical.
    const again = await writeInitLaunchdPlist(opts);
    expect(again.kind).toBe("unchanged");
    expect(readFileSync(opts.plistPath, "utf-8")).toBe(after);
  });

  test("an adopted plist serving a plain tree is left byte-identical, with the reason", async () => {
    const cur = runtimeTree(join(tmp, "node", "24.19.0"), "0.57.0");
    const opts = baseOptions({ execPath: cur.node, harperBinPath: cur.harper, workingDirectory: cur.tree });
    const before = plistFor(DATA_DIR);
    writeFileSync(opts.plistPath, before);

    const result = await writeInitLaunchdPlist(opts);

    expect(result.kind).toBe("not-repointed");
    if (result.kind === "not-repointed") expect(result.detail).toContain("separately managed");
    expect(readFileSync(opts.plistPath, "utf-8")).toBe(before);
  });
});

describe("registerInitLaunchdService — symlink preflight (#2085)", () => {
  async function runWithPlistPath(path: string) {
    return registerInitLaunchdService({
      dataDir: DATA_DIR,
      port: 9926,
      plistDir: tmp,
      write: baseOptions({ plistPath: path }),
    });
  }

  test("refuses an existing plist symlink without replacing it or changing its target", async () => {
    const path = baseOptions().plistPath;
    const target = join(tmp, "prior.xml");
    const prior = plistFor(DATA_DIR);
    writeFileSync(target, prior, { mode: 0o600 });
    symlinkSync(target, path);

    const result = await runWithPlistPath(path);

    expect(result.kind).toBe("skipped");
    const message = result.lines.map((line) => line.text).join("\n");
    expect(message).toContain(`${path} is a symbolic link`);
    expect(message).toContain(`Fix: move or remove the symbolic link at ${path}`);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(target);
    expect(readFileSync(target, "utf-8")).toBe(prior);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("refuses a dangling plist symlink as present and leaves it intact", async () => {
    const path = baseOptions().plistPath;
    const target = join(tmp, "missing.xml");
    symlinkSync(target, path);
    expect(existsSync(path)).toBe(false);

    const result = await runWithPlistPath(path);

    expect(result.kind).toBe("skipped");
    const message = result.lines.map((line) => line.text).join("\n");
    expect(message).toContain(`${path} is a symbolic link`);
    expect(message).toContain(`Fix: move or remove the symbolic link at ${path}`);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(target);
    expect(existsSync(target)).toBe(false);
  });
});

describe("registerInitLaunchdService — rollback permissions (#2085)", () => {
  test("restores a 0644 prior plist under umask 077 after validation refuses it", async () => {
    const opts = baseOptions();
    const prior = plistFor(DATA_DIR).replace("start-flair-with-admin-pass.sh", "prior-launcher.sh");
    writeFileSync(opts.plistPath, prior);
    chmodSync(opts.plistPath, 0o644);
    writePassFile(opts.adminPassPath!, "PLACEHOLDER-existing-pass");

    const previousUmask = process.umask(0o077);
    setLaunchdMigrationLintForTests(() => "injected validation refusal");
    try {
      const result = await registerInitLaunchdService({
        dataDir: DATA_DIR,
        port: 9926,
        plistDir: tmp,
        write: opts,
      });

      expect(result.kind).toBe("skipped");
      expect(result.lines.map((line) => line.text).join("\n")).toContain("the prior plist bytes and mode");
      expect(readFileSync(opts.plistPath, "utf-8")).toBe(prior);
      expect(statSync(opts.plistPath).mode & 0o777).toBe(0o644);
    } finally {
      setLaunchdMigrationLintForTests(null);
      process.umask(previousUmask);
    }
  });
});
