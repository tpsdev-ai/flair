/**
 * check-instance-boot-2739.test.ts — flair#2739.
 *
 * scripts/ci/check-instance-boot.sh hands `flair init` the admin password only
 * through `--admin-pass-file`. By default it writes a generated password to a
 * 0600 file inside a fresh `mktemp -d` directory and removes that directory on
 * exit through an EXIT trap, installed before the flair-binary check. An
 * explicitly supplied PASS_FILE is used as given and left in place.
 *
 * The live canary proves the default path boots; it does not read the file's
 * location, mode or lifetime. This pins them hermetically: a stub FLAIR_BIN
 * records its argv and the stat of the `--admin-pass-file` it is handed, then
 * exits non-zero so the script takes its init-failure path at once. HOME,
 * TMPDIR and LOG_DIR are sandbox directories, and FLAIR_PREFIX points at an
 * empty sandbox package dir so the script never asks npm. No flair, no Harper,
 * no port.
 *
 * Where `mktemp -d` puts its directory is platform-defined (GNU honours TMPDIR;
 * darwin uses the per-user temp dir and ignores TMPDIR), so a pass-through
 * `mktemp` shim first on PATH records the directory it returned. The tests
 * read the script's temp directory from that record, never from a location
 * guess, and remove a leaked one after the assertions have run.
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
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { tempDir } from "../helpers/temp-dir.ts";

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "scripts", "ci", "check-instance-boot.sh");
const CASE_BUDGET_MS = 30_000;
const OPERATOR_VALUE = "operator-supplied-test-value-2739\n";

/** What the stub flair saw: its argv and the pass file as it was when flair got it. */
interface Recorded {
  argv: string[];
  pass: null | { path: string; mode?: number; dirMode?: number; value?: string; error?: string };
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
fs.writeFileSync(process.env.FLAIR_STUB_RECORD, JSON.stringify({ argv, pass }));
process.exit(3);
`;

interface Sandbox {
  root: string;
  home: string;
  tmp: string;
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
  const logs = join(root, "logs");
  const prefix = join(root, "prefix");
  const shim = join(root, "shim");
  for (const dir of [home, tmp, shim, join(prefix, "bin"), join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair")]) {
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

  return { root, home, tmp, logs, prefix, shim, stub, record: join(root, "flair-stub-record.json"), mktempRecord };
}

/** Run the boot check with ONLY the sandbox environment (plus PATH, mktemp shim first). */
function runBoot(sb: Sandbox, extra: Record<string, string> = {}) {
  const result = spawnSync("bash", [SCRIPT], {
    cwd: sb.root,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    env: {
      PATH: `${sb.shim}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: sb.home,
      TMPDIR: sb.tmp,
      LOG_DIR: sb.logs,
      FLAIR_BIN: sb.stub,
      FLAIR_PREFIX: sb.prefix,
      FLAIR_STUB_RECORD: sb.record,
      ...extra,
    },
  });
  mktempSeen.push(...mktempDirs(sb));
  expect(result.error).toBeUndefined();
  return result;
}

function readRecord(sb: Sandbox): Recorded {
  expect(existsSync(sb.record)).toBe(true);
  return JSON.parse(readFileSync(sb.record, "utf8")) as Recorded;
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

function writeOperatorPassFile(sb: Sandbox): string {
  const passFile = join(sb.root, "operator", "admin-pass-input");
  mkdirSync(dirname(passFile), { recursive: true });
  writeFileSync(passFile, OPERATOR_VALUE);
  chmodSync(passFile, 0o600);
  return passFile;
}

describe("check-instance-boot.sh — the admin-pass input file handed to flair init (flair#2739)", () => {
  test("default path: the --admin-pass-file is under neither HOME nor LOG_DIR, inside the script's own mktemp -d directory", () => {
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

  test("an explicit PASS_FILE is passed as given and left in place, unchanged", () => {
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
