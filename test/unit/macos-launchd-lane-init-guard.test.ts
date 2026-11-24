/**
 * macos-launchd-lane-init-guard.test.ts — flair#3100
 *
 * A failed `flair init` whose output passes the password scan must reach
 * on_error's diagnostics in the launchd adopt-then-upgrade lane. The block
 * under test is extracted from scripts/ci/macos-launchd-upgrade-lane.sh itself
 * (never copied), because stock macOS /bin/bash 3.2 does NOT fire the ERR trap
 * for `(exit "$init_rc")` inside an `if` body; Bash 5 does.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LANE = join(REPO_ROOT, "scripts", "ci", "macos-launchd-upgrade-lane.sh");

/** The init block, verbatim from the lane script. */
function extractInitBlock(): string {
  const lines = readFileSync(LANE, "utf8").split("\n");
  const start = lines.indexOf('ADMIN_PASS="${ADMIN_PASS:-}"');
  if (start < 0) throw new Error(`start marker not found in ${LANE}`);
  const anchor = lines.findIndex(
    (line, index) => index > start && line.includes("still exists after cleanup"),
  );
  if (anchor < 0) throw new Error(`end anchor not found in ${LANE}`);
  const end = lines.findIndex((line, index) => index > anchor && line.trim() === "fi");
  if (end < 0) throw new Error(`end marker not found in ${LANE}`);
  return lines.slice(start, end + 1).join("\n");
}

const STUB = `#!/usr/bin/env bash
set -u
pass_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --admin-pass-file) pass_file="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "\${STUB_MODE:-ok}" in
  ok)
    cp "$pass_file" "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    echo "init ok"
    ;;
  leak)
    cp "$pass_file" "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    cat "$pass_file"
    ;;
  fail)
    echo "init exploded"
    exit 3
    ;;
  nopattern)
    rm -f "$pass_file"
    echo "init wrote no pattern"
    ;;
esac
`;

const HARNESS_HEAD = `set -Eeuo pipefail
on_error() {
  local code=$?
  echo "DIAG code=$code"
  exit "$code"
}
ADMIN_PASS_SOURCE_DIR=""
cleanup_admin_pass_source() {
  if [ -n "$ADMIN_PASS_SOURCE_DIR" ]; then
    rm -rf "$ADMIN_PASS_SOURCE_DIR"
  fi
}
trap cleanup_admin_pass_source EXIT
if [ "\${HARNESS_ERR_TRAP:-0}" = "1" ]; then
  trap on_error ERR
fi
`;

type Mode = "ok" | "leak" | "fail" | "nopattern";

interface Scratch {
  root: string;
  runDir: string;
  passFile: string;
}

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeScratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "flair-init-guard-"));
  scratches.push(root);
  const runDir = join(root, "runner-temp");
  const binDir = join(root, "bin");
  const passFile = join(root, "pass", "admin-pass");
  mkdirSync(runDir);
  mkdirSync(binDir);
  mkdirSync(join(root, "pass"));
  writeFileSync(join(binDir, "flair"), STUB);
  chmodSync(join(binDir, "flair"), 0o755);
  writeFileSync(join(root, "harness.sh"), `${HARNESS_HEAD}${extractInitBlock()}\necho REACHED-END\n`);
  return { root, runDir, passFile };
}

function runCase(mode: Mode, errTrap: boolean, shell = "bash") {
  const scratch = makeScratch();
  const result = spawnSync(shell, [join(scratch.root, "harness.sh")], {
    encoding: "utf8",
    env: {
      PATH: `${join(scratch.root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: join(scratch.root, "home"),
      PORT: "19926",
      OPS_PORT: "19925",
      RUNNER_TEMP: scratch.runDir,
      PASS_FILE: scratch.passFile,
      STUB_MODE: mode,
      HARNESS_ERR_TRAP: errTrap ? "1" : "0",
    },
    timeout: 30_000,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const value = existsSync(scratch.passFile) ? readFileSync(scratch.passFile, "utf8").trim() : "";
  return { result, out, value, scratch };
}

describe("launchd lane init guard (flair#3100)", () => {
  test(
    "failed init with no ERR trap still reaches on_error once and cleans up",
    () => {
      const { result, out, scratch } = runCase("fail", false);
      expect(result.status).toBe(3);
      expect((out.match(/DIAG code=3/g) ?? []).length).toBe(1);
      expect(out).not.toContain("REACHED-END");
      expect(readdirSync(scratch.runDir)).toHaveLength(0);
    },
    60_000,
  );

  test(
    "stock /bin/bash fires on_error for a failed init when an ERR trap is installed",
    () => {
      if (!existsSync("/bin/bash")) {
        console.warn("[case] skipped: /bin/bash does not exist on this host");
        return;
      }
      const { result, out } = runCase("fail", true, "/bin/bash");
      expect(result.status).toBe(3);
      expect((out.match(/DIAG code=3/g) ?? []).length).toBe(1);
      expect(out).not.toContain("REACHED-END");
    },
    60_000,
  );

  test(
    "a leaked password withholds init output and prints no value",
    () => {
      const { result, out, value } = runCase("leak", false);
      expect(result.status).toBe(1);
      expect(out).toContain("withheld");
      expect(value.length).toBeGreaterThan(0);
      expect(out).not.toContain(value);
      expect(out).not.toContain("REACHED-END");
    },
    60_000,
  );

  test(
    "a password scan that cannot run (grep exit 2) withholds init output",
    () => {
      const { result, out } = runCase("nopattern", false);
      expect(result.status).toBe(1);
      expect(out).toContain("withheld");
      expect(out).toContain("grep exit 2");
      expect(out).not.toContain("REACHED-END");
    },
    60_000,
  );

  // Darwin only: the block reads the pass-file mode with BSD `stat -f '%Lp'`.
  test.skipIf(process.platform !== "darwin")(
    "successful init reaches the end and removes the source dir",
    () => {
      const { result, out, scratch } = runCase("ok", false);
      expect(result.status).toBe(0);
      expect(out).toContain("REACHED-END");
      expect(readdirSync(scratch.runDir)).toHaveLength(0);
    },
    60_000,
  );
});
