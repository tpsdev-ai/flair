/**
 * check-instance-boot-2739.test.ts — flair#2739.
 *
 * scripts/ci/check-instance-boot.sh keeps the admin password out of `flair
 * init`'s argv: init is handed `--admin-pass-file`, and also inherits the
 * HDB_ADMIN_PASSWORD and FLAIR_ADMIN_PASS environment variables the script
 * exports with the same value. By default the script writes a generated
 * password to a 0600 file inside a fresh `mktemp -d` directory under
 * RUNNER_TEMP (or /tmp) and removes that directory on exit through an EXIT
 * trap installed right after `mktemp -d`. An explicit PASS_FILE is not
 * removed; at the init step the script writes a generated password into it
 * when it is missing or empty, and sets its mode to 0600. For either, before
 * touching the file, the script resolves its directory (following symlinks on
 * the file itself) and fails when it cannot, or when that directory is or lies
 * under LOG_DIR, the working directory or GITHUB_WORKSPACE.
 *
 * The live canary proves the default path boots; it does not read the file's
 * location, mode or lifetime. This pins them hermetically: a stub FLAIR_BIN
 * records its argv and the stat of the `--admin-pass-file` it is handed, then
 * exits non-zero so the script takes its init-failure path at once. HOME,
 * TMPDIR, RUNNER_TEMP and LOG_DIR default to sandbox directories, the script
 * runs from a sandbox working directory, and FLAIR_PREFIX points at an empty
 * sandbox package dir so the script never asks npm. No flair, no Harper, no
 * port.
 *
 * A pass-through `mktemp` shim first on PATH records the directory each call
 * returned. The tests read the script's temp directory from that record, never
 * from a location guess, and remove a leaked one after the assertions have run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { tempDir } from "../helpers/temp-dir.ts";

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "scripts", "ci", "check-instance-boot.sh");
const CASE_BUDGET_MS = 30_000;
const OPERATOR_VALUE = "operator-supplied-test-value-2739\n";

/**
 * What the stub flair saw: its argv, the pass file as it was when flair got it, and the
 * LENGTH of each password-bearing variable it inherited (null when unset).
 */
interface Recorded {
  argv: string[];
  pass: null | { path: string; mode?: number; dirMode?: number; value?: string; error?: string };
  envLengths: Record<string, number | null>;
}

/** The stub's recorder. `.cjs` so it is CommonJS whatever surrounds it. */
const RECORDER = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const at = argv.indexOf("--admin-pass-file");
let pass = null;
if (at >= 0 && at + 1 < argv.length) {
  const file = argv[at + 1];
  try {
    pass = {
      path: file,
      mode: fs.statSync(file).mode & 0o777,
      dirMode: fs.statSync(path.dirname(file)).mode & 0o777,
      value: fs.readFileSync(file, "utf8"),
    };
  } catch (error) {
    pass = { path: file, error: String(error) };
  }
}
const envLengths = {};
for (const name of ["HDB_ADMIN_PASSWORD", "FLAIR_ADMIN_PASS"]) {
  envLengths[name] = name in process.env ? process.env[name].length : null;
}
fs.writeFileSync(process.env.FLAIR_STUB_RECORD, JSON.stringify({ argv, pass, envLengths }));
process.exit(3);
`;

interface Sandbox {
  root: string;
  home: string;
  tmp: string;
  work: string;
  runnerTemp: string;
  logs: string;
  prefix: string;
  shim: string;
  stub: string;
  record: string;
  mktempRecord: string;
}

/** Directories the mktemp shim returned this test; any still present are removed after it. */
const mktempSeen: string[] = [];
afterEach(() => {
  for (const dir of mktempSeen.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): Sandbox {
  const root = realpathSync(tempDir("flair-instance-boot-2739-"));
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const work = join(root, "work");
  const runnerTemp = join(root, "runner-temp");
  const logs = join(root, "logs");
  const prefix = join(root, "prefix");
  const shim = join(root, "shim");
  for (const dir of [home, tmp, work, runnerTemp, shim, join(prefix, "bin"), join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair")]) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(join(prefix, "bin", "record.cjs"), RECORDER);
  const stub = join(prefix, "bin", "flair");
  writeFileSync(stub, '#!/usr/bin/env bash\nexec node "$(dirname "$0")/record.cjs" "$@"\n');
  chmodSync(stub, 0o755);

  const realMktemp = Bun.which("mktemp", { PATH: process.env.PATH ?? "/usr/bin:/bin" });
  if (!realMktemp) throw new Error("mktemp is not on PATH");
  const mktempRecord = join(root, "mktemp-record.txt");
  writeFileSync(
    join(shim, "mktemp"),
    [
      "#!/usr/bin/env bash",
      `out="$(${JSON.stringify(realMktemp)} "$@")" || exit $?`,
      `printf '%s\\n' "$out" >> ${JSON.stringify(mktempRecord)}`,
      `printf '%s\\n' "$out"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(shim, "mktemp"), 0o755);

  return {
    root,
    home,
    tmp,
    work,
    runnerTemp,
    logs,
    prefix,
    shim,
    stub,
    record: join(root, "flair-stub-record.json"),
    mktempRecord,
  };
}

/**
 * Run the boot check from the sandbox working directory with ONLY the sandbox
 * environment (plus PATH, mktemp shim first). An `extra` value of undefined
 * unsets that variable.
 */
function runBoot(sb: Sandbox, extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {};
  const merged: Record<string, string | undefined> = {
    PATH: `${sb.shim}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: sb.home,
    TMPDIR: sb.tmp,
    RUNNER_TEMP: sb.runnerTemp,
    LOG_DIR: sb.logs,
    FLAIR_BIN: sb.stub,
    FLAIR_PREFIX: sb.prefix,
    FLAIR_STUB_RECORD: sb.record,
    ...extra,
  };
  for (const [key, value] of Object.entries(merged)) if (value !== undefined) env[key] = value;
  const result = spawnSync("bash", [SCRIPT], {
    cwd: sb.work,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    env,
  });
  mktempSeen.push(...mktempDirs(sb));
  expect(result.error).toBeUndefined();
  return result;
}

function readRecord(sb: Sandbox): Recorded {
  expect(existsSync(sb.record)).toBe(true);
  return JSON.parse(readFileSync(sb.record, "utf8")) as Recorded;
}

/** The stub's record, or null when the stub never ran. */
function readRecordIfAny(sb: Sandbox): Recorded | null {
  try {
    return JSON.parse(readFileSync(sb.record, "utf8")) as Recorded;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Every path the script's `mktemp` calls returned, in order. */
function mktempDirs(sb: Sandbox): string[] {
  if (!existsSync(sb.mktempRecord)) return [];
  return readFileSync(sb.mktempRecord, "utf8").split("\n").filter(Boolean).map((p) => resolve(p));
}

/** The value flair init received after `--admin-pass-file` (exactly one occurrence). */
function passFileArg(rec: Recorded): string {
  expect(rec.argv[0]).toBe("init");
  expect(rec.argv.filter((arg) => arg === "--admin-pass-file")).toHaveLength(1);
  const value = rec.argv[rec.argv.indexOf("--admin-pass-file") + 1];
  expect(typeof value).toBe("string");
  return value!;
}

function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function writeOperatorPassFile(sb: Sandbox, mode = 0o600): string {
  const passFile = join(sb.root, "operator", "admin-pass-input");
  mkdirSync(dirname(passFile), { recursive: true });
  writeFileSync(passFile, OPERATOR_VALUE);
  chmodSync(passFile, mode);
  return passFile;
}

/** Explicit pass files whose read fails for every uid, or yields an empty value. */
const UNUSABLE: Array<[string, (sb: Sandbox) => string, string]> = [
  [
    "is a directory, so reading it fails",
    (sb) => {
      const dir = join(sb.root, "operator", "pass-dir");
      mkdirSync(dir, { recursive: true });
      // A nonempty directory, so the script's `-s` test sees it as present and nonempty.
      writeFileSync(join(dir, "entry"), "");
      return dir;
    },
    "cannot read admin-pass input file",
  ],
  [
    "holds only a newline, so the read is empty",
    (sb) => {
      const file = join(sb.root, "operator", "admin-pass-input");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "\n");
      return file;
    },
    "is empty",
  ],
];

/** Explicit PASS_FILE paths that resolve into LOG_DIR, each with the path a write would land on; none exists beforehand. */
const EXPLICIT_PROTECTED: Array<[string, (sb: Sandbox) => { passFile: string; landing: string }]> = [
  [
    "a missing file directly in LOG_DIR",
    (sb) => ({ passFile: join(sb.logs, "admin-pass-input"), landing: join(sb.logs, "admin-pass-input") }),
  ],
  [
    "a missing file in a directory that is a symlink into LOG_DIR",
    (sb) => {
      const target = join(sb.logs, "sub");
      mkdirSync(target, { recursive: true });
      const link = join(sb.root, "pass-dir-link");
      symlinkSync(target, link);
      return { passFile: join(link, "admin-pass-input"), landing: join(target, "admin-pass-input") };
    },
  ],
  [
    "a symlink that points into LOG_DIR",
    (sb) => {
      const landing = join(sb.logs, "admin-pass-input");
      const link = join(sb.root, "operator", "pass-link");
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(landing, link);
      return { passFile: link, landing };
    },
  ],
];

/** Each case puts RUNNER_TEMP where the generated directory must not resolve. */
const OVERLAPS: Array<[string, (sb: Sandbox) => Record<string, string>]> = [
  ["inside LOG_DIR", (sb) => ({ RUNNER_TEMP: join(sb.logs, "runner-temp") })],
  ["inside the working directory", (sb) => ({ RUNNER_TEMP: join(sb.work, "runner-temp") })],
  [
    "inside GITHUB_WORKSPACE",
    (sb) => ({ RUNNER_TEMP: join(sb.root, "workspace", "_temp"), GITHUB_WORKSPACE: join(sb.root, "workspace") }),
  ],
  [
    "inside LOG_DIR through a symlink",
    (sb) => {
      const target = join(sb.logs, "runner-temp");
      mkdirSync(target, { recursive: true });
      const link = join(sb.root, "runner-temp-link");
      symlinkSync(target, link);
      return { RUNNER_TEMP: link };
    },
  ],
];

describe("check-instance-boot.sh — the admin-pass input file handed to flair init (flair#2739)", () => {
  test("default path: the --admin-pass-file is inside the script's own mktemp -d directory, outside the sandbox HOME and LOG_DIR", () => {
    const sb = sandbox();
    const r = runBoot(sb);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("flair init failed");
    const passFile = resolve(passFileArg(readRecord(sb)));

    expect(isUnder(passFile, sb.home)).toBe(false);
    expect(isUnder(passFile, sb.logs)).toBe(false);
    // Its directory is the one `mktemp -d` returned, and the script made no other.
    expect(mktempDirs(sb)).toEqual([dirname(passFile)]);
  }, CASE_BUDGET_MS);

  test("default path: the file is mode 0600, in a 0700 directory, when flair init receives it", () => {
    const sb = sandbox();
    const r = runBoot(sb);
    expect(r.status).toBe(1);
    const rec = readRecord(sb);
    expect(rec.pass?.error).toBeUndefined();
    expect(rec.pass?.mode).toBe(0o600);
    expect(rec.pass?.dirMode).toBe(0o700);
  }, CASE_BUDGET_MS);

  test("default path: the temp directory is gone after the script exits", () => {
    const sb = sandbox();
    const r = runBoot(sb);
    expect(r.status).toBe(1);
    const passDir = dirname(resolve(passFileArg(readRecord(sb))));
    expect(mktempDirs(sb)).toEqual([passDir]);
    expect(existsSync(passDir)).toBe(false);
  }, CASE_BUDGET_MS);

  test("default path, TMPDIR inside LOG_DIR: the directory is still made directly under RUNNER_TEMP, outside LOG_DIR", () => {
    const sb = sandbox();
    const tmpInLogs = join(sb.logs, "tmp");
    mkdirSync(tmpInLogs, { recursive: true });
    const r = runBoot(sb, { TMPDIR: `${tmpInLogs}/` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("flair init failed");
    const passFile = resolve(passFileArg(readRecord(sb)));
    expect(dirname(dirname(passFile))).toBe(sb.runnerTemp);
    expect(isUnder(passFile, sb.logs)).toBe(false);
    expect(mktempDirs(sb)).toEqual([dirname(passFile)]);
  }, CASE_BUDGET_MS);

  test("default path, RUNNER_TEMP unset: the directory is made directly under /tmp", () => {
    const sb = sandbox();
    const r = runBoot(sb, { RUNNER_TEMP: undefined });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("flair init failed");
    const passFile = passFileArg(readRecord(sb));
    expect(dirname(dirname(passFile))).toBe("/tmp");
    expect(mktempDirs(sb)).toEqual([dirname(resolve(passFile))]);
  }, CASE_BUDGET_MS);

  test.each(OVERLAPS)(
    "RUNNER_TEMP %s: the script fails before flair init, and the temp directory is removed",
    (_where, place) => {
      const sb = sandbox();
      const extra = place(sb);
      mkdirSync(extra.RUNNER_TEMP!, { recursive: true });
      const r = runBoot(sb, extra);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("resolves inside");
      expect(existsSync(sb.record)).toBe(false);
      const made = mktempDirs(sb);
      expect(made).toHaveLength(1);
      expect(existsSync(made[0]!)).toBe(false);
    },
    CASE_BUDGET_MS,
  );

  test("LOG_DIR cannot be created: the script fails before flair init, and the temp directory is still removed", () => {
    const sb = sandbox();
    const notADir = join(sb.root, "not-a-dir");
    writeFileSync(notADir, "");
    const r = runBoot(sb, { LOG_DIR: join(notADir, "logs") });
    expect(r.status).toBe(1);
    expect(existsSync(sb.record)).toBe(false);
    const made = mktempDirs(sb);
    expect(made).toHaveLength(1);
    expect(existsSync(made[0]!)).toBe(false);
  }, CASE_BUDGET_MS);

  test("FLAIR_BIN does not exist: DID NOT RUN (exit 2), and the temp directory is still removed", () => {
    const sb = sandbox();
    const r = runBoot(sb, { FLAIR_BIN: join(sb.prefix, "bin", "no-such-flair") });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DID NOT RUN");
    expect(existsSync(sb.record)).toBe(false);
    const made = mktempDirs(sb);
    expect(made).toHaveLength(1);
    expect(existsSync(made[0]!)).toBe(false);
  }, CASE_BUDGET_MS);

  test.each(EXPLICIT_PROTECTED)(
    "explicit PASS_FILE, %s: the script exits 1 before flair init, and nothing is written there",
    (_what, place) => {
      const sb = sandbox();
      const { passFile, landing } = place(sb);
      const r = runBoot(sb, { PASS_FILE: passFile });
      expect(r.status).toBe(1);
      expect(readRecordIfAny(sb)).toBeNull();
      expect(r.stderr).toContain("resolves inside");
      expect(r.stderr).toContain(passFile);
      expect(existsSync(landing)).toBe(false);
    },
    CASE_BUDGET_MS,
  );

  test("explicit PASS_FILE, an existing 0644 file in the working directory: the script exits 1 before flair init, content and mode untouched", () => {
    const sb = sandbox();
    const passFile = join(sb.work, "admin-pass-input");
    writeFileSync(passFile, OPERATOR_VALUE);
    chmodSync(passFile, 0o644);

    const r = runBoot(sb, { PASS_FILE: passFile });
    expect(r.status).toBe(1);
    expect(readRecordIfAny(sb)).toBeNull();
    expect(r.stderr).toContain("resolves inside");
    expect(readFileSync(passFile, "utf8")).toBe(OPERATOR_VALUE);
    expect(statSync(passFile).mode & 0o777).toBe(0o644);
  }, CASE_BUDGET_MS);

  test("explicit PASS_FILE whose directory does not exist: the script exits 1 before flair init and does not create that directory", () => {
    const sb = sandbox();
    const missingDir = join(sb.root, "no-such-dir");
    const r = runBoot(sb, { PASS_FILE: join(missingDir, "admin-pass-input") });
    expect(r.status).toBe(1);
    expect(readRecordIfAny(sb)).toBeNull();
    expect(r.stderr).toContain("cannot resolve the directory of admin-pass input file");
    expect(existsSync(missingDir)).toBe(false);
  }, CASE_BUDGET_MS);

  test("explicit PASS_FILE outside LOG_DIR, the working directory and GITHUB_WORKSPACE: a missing file is filled, handed to flair init at 0600, and left in place", () => {
    const sb = sandbox();
    const workspace = join(sb.root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const passFile = join(sb.root, "operator", "admin-pass-input");
    mkdirSync(dirname(passFile), { recursive: true });

    const r = runBoot(sb, { PASS_FILE: passFile, GITHUB_WORKSPACE: workspace });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("flair init failed");
    const rec = readRecord(sb);
    expect(passFileArg(rec)).toBe(passFile);
    expect(rec.pass?.mode).toBe(0o600);
    const generated = rec.pass?.value ?? "";
    expect(generated.trim().length).toBeGreaterThanOrEqual(16);
    expect(readFileSync(passFile, "utf8")).toBe(generated);
    expect(mktempDirs(sb)).toEqual([]);
  }, CASE_BUDGET_MS);

  test("an explicit nonempty 0600 PASS_FILE is passed as given and left in place with the same content and mode", () => {
    const sb = sandbox();
    const passFile = writeOperatorPassFile(sb);

    const r = runBoot(sb, { PASS_FILE: passFile });
    expect(r.status).toBe(1);
    const rec = readRecord(sb);
    expect(passFileArg(rec)).toBe(passFile);
    expect(rec.pass?.value).toBe(OPERATOR_VALUE);

    expect(existsSync(passFile)).toBe(true);
    expect(readFileSync(passFile, "utf8")).toBe(OPERATOR_VALUE);
    expect(statSync(passFile).mode & 0o777).toBe(0o600);
    // No temp directory is made for an explicit file.
    expect(mktempDirs(sb)).toEqual([]);
  }, CASE_BUDGET_MS);

  test("an explicit nonempty PASS_FILE at mode 0644 is set to 0600 before flair init receives it, content unchanged", () => {
    const sb = sandbox();
    const passFile = writeOperatorPassFile(sb, 0o644);

    const r = runBoot(sb, { PASS_FILE: passFile });
    expect(r.status).toBe(1);
    const rec = readRecord(sb);
    expect(passFileArg(rec)).toBe(passFile);
    expect(rec.pass?.mode).toBe(0o600);
    expect(rec.pass?.value).toBe(OPERATOR_VALUE);

    expect(readFileSync(passFile, "utf8")).toBe(OPERATOR_VALUE);
    expect(statSync(passFile).mode & 0o777).toBe(0o600);
  }, CASE_BUDGET_MS);

  test.each(UNUSABLE)(
    "an explicit PASS_FILE that %s: the script exits 1 naming the file, and flair init never runs",
    (_what, make, reason) => {
      const sb = sandbox();
      const passFile = make(sb);
      try {
        const r = runBoot(sb, { PASS_FILE: passFile });
        expect(r.status).toBe(1);
        // The script exports the credential variables right before flair init, so init never running
        // means no process inherited those exports, empty or otherwise.
        expect(readRecordIfAny(sb)).toBeNull();
        expect(r.stderr).toContain(reason);
        expect(r.stderr).toContain(passFile);
      } finally {
        // The script set the path to 0600; a directory needs its search bit back for cleanup.
        chmodSync(passFile, 0o700);
      }
    },
    CASE_BUDGET_MS,
  );

  test("flair init's argv carries no password value, and the script prints none", () => {
    for (const explicit of [false, true]) {
      const sb = sandbox();
      const r = runBoot(sb, explicit ? { PASS_FILE: writeOperatorPassFile(sb) } : {});
      expect(r.status).toBe(1);
      const rec = readRecord(sb);
      const secret = (rec.pass?.value ?? "").trim();
      expect(secret.length).toBeGreaterThanOrEqual(16);
      for (const arg of rec.argv) expect(arg).not.toContain(secret);
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
    }
  }, CASE_BUDGET_MS);
});
